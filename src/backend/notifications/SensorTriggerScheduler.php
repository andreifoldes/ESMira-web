<?php
declare(strict_types=1);

namespace backend\notifications;

/**
 * Sensor-contingent ("if the wearable reports X, then prompt - else fall back to a fixed
 * time") occurrences for one participant. Counterpart of PushScheduler::computeDueOccurrences,
 * which only knows wall-clock schedules.
 *
 * An event trigger with cueCode `wearable_event` fires when a matching webhook event
 * (see wearables/WearablesEventStore) is on record. Optionally it
 *  - only reacts inside a daily window (`wearableWindow*`),
 *  - is capped at `wearableMaxPerDay` prompts per participant and local day,
 *  - is delayed by `delaySec` (or a stable pseudo-random value in [delayMinimumSec, delaySec]),
 *  - has a time-contingent fallback: at `fallbackTimeOfDay`, if no qualifying event arrived
 *    earlier that local day (including participants who never linked a device), the prompt is
 *    sent anyway. A fallback counts against the daily cap, so a late sync cannot prompt twice.
 *
 * Idempotence does not rely on a time cursor: every candidate has a key recorded in `$ledger`,
 * so an event that is appended just after the previous run read the log is still picked up, and
 * nothing is sent twice. Candidates older than MAX_AGE_MS are recorded without being sent
 * (no back-filling after downtime). On a participant's first run, fallbacks due earlier are skipped too.
 */
class SensorTriggerScheduler {
	const CUE = 'wearable_event';
	const ONE_DAY = 86400000;
	const MAX_AGE_MS = 7200000;      // do not send prompts more than 2 h stale
	const LEDGER_KEEP_DAYS = 4;
	// Defaults of the omitted-when-default fields; keep in sync with data/study/EventTrigger.ts.
	const DEFAULT_WINDOW_START = 18000000; // 05:00
	const DEFAULT_WINDOW_END = 43200000;   // 12:00
	const DEFAULT_FALLBACK_TOD = 43200000; // 12:00

	/** How far back callers should load events: covers fallback evaluation and delayed prompts. */
	const EVENT_LOOKBACK_MS = 3 * self::ONE_DAY;

	/** True when any event trigger of the study is a sensor trigger. */
	public static function hasTriggers(array $study): bool {
		return !empty(self::collect($study));
	}

	/** True when some sensor trigger of the study reacts to this provider/kind combination. */
	public static function wantsEvent(array $study, string $provider, string $kind): bool {
		foreach(self::collect($study) as $t) {
			if(self::eventMatches($t['et'], $provider, $kind))
				return true;
		}
		return false;
	}

	/**
	 * @param array $events  [{t:int, provider:string, kind:string}] from WearablesEventStore, any order
	 * @param array $ledger  per-participant state, mutated: ['seen' => key=>fireMs, 'fired' => dayKey=>count]
	 * @return array<int, array> occurrences in the shape PushSender::buildCoalescedPayload consumes
	 */
	public static function computeOccurrences(
		array $study, array $events, int $anchorMs, int $tzOffsetMin, int $nowMs, int $lastDataSetTime, array &$ledger
	): array {
		$out = [];
		$offsetMs = $tzOffsetMin * 60000;
		$anchorDayLocal = intdiv($anchorMs - $offsetMs, self::ONE_DAY) * self::ONE_DAY;
		$studyTitle = (is_string($study['title'] ?? null) && $study['title'] !== '') ? $study['title'] : 'ESMira';
		$ledger['seen']  = (isset($ledger['seen'])  && is_array($ledger['seen']))  ? $ledger['seen']  : [];
		$ledger['fired'] = (isset($ledger['fired']) && is_array($ledger['fired'])) ? $ledger['fired'] : [];
		// First run for this participant: fallbacks due before now are not back-filled (enabling
		// push or adding a trigger must not fire a "missed" prompt). Real sensor events still are.
		if(!isset($ledger['init']))
			$ledger['init'] = $nowMs;

		foreach(self::collect($study) as $t) {
			['qi' => $qi, 'q' => $q, 'ai' => $ai, 'at' => $at, 'ei' => $ei, 'et' => $et] = $t;
			$action = PushScheduler::notificationAction($at);
			if($action === null)
				continue;
			[$body, $reminderCount, $reminderDelayMs] = $action;

			$qTitle = (is_string($q['title'] ?? null) && $q['title'] !== '') ? $q['title'] : $studyTitle;
			$qid = (int) ($q['internalId'] ?? $qi);
			$includeDeadline = !empty($q['notificationIncludeDeadline']);
			$maxPerDay = max(1, (int) ($et['wearableMaxPerDay'] ?? 1));
			$baseKey = "$qid:$ai:$ei"; // qid, not position: survives questionnaire reordering/deletion

			// Candidate fire times: [fireMs, key, absoluteLocalDay]
			$cands = [];
			$qualifyingByDay = [];
			foreach($events as $e) {
				if(!self::eventMatches($et, (string) $e['provider'], (string) $e['kind']))
					continue;
				$time = (int) $e['t'];
				if($time < $anchorMs || !self::inWindow($et, self::timeOfDay($time, $offsetMs)))
					continue;
				$fireMs = $time + self::delayMs($et, "$baseKey:$time");
				// The cap and the fallback check work on the day the prompt is shown, not the day the sensor reported.
				$day = intdiv($fireMs - $offsetMs, self::ONE_DAY);
				$qualifyingByDay[$day][] = $time;
				$cands[] = [$fireMs, "$baseKey:s:$time", $day];
			}
			$fallbackTod = (int) ($et['fallbackTimeOfDay'] ?? self::DEFAULT_FALLBACK_TOD);
			if(!empty($et['fallbackEnabled']) && $fallbackTod >= 0) { // < 0: time input was cleared
				$lastDay = intdiv($nowMs - $offsetMs, self::ONE_DAY);
				for($day = $lastDay - 2; $day <= $lastDay; $day++) {
					$fireMs = $day * self::ONE_DAY + $fallbackTod + $offsetMs;
					if($fireMs < $anchorMs || $fireMs > $nowMs)
						continue;
					if(self::anyAtOrBefore($qualifyingByDay[$day] ?? [], $fireMs))
						continue;
					$cands[] = [$fireMs, "$baseKey:f:$day", $day];
				}
			}
			usort($cands, fn($a, $b) => $a[0] <=> $b[0]);

			foreach($cands as [$fireMs, $key, $day]) {
				if(!self::isActive($q, $fireMs, $offsetMs, $anchorDayLocal))
					continue;
				$status = $ledger['seen'][$key] ?? null;
				if($status === null && $fireMs <= $nowMs) {
					$dayKey = "$baseKey:$day";
					$isFallback = strpos($key, ':f:') !== false;
					$isStale = $nowMs - $fireMs > self::MAX_AGE_MS || ($isFallback && $fireMs < $ledger['init']);
					$isCapped = ($ledger['fired'][$dayKey] ?? 0) >= $maxPerDay;
					if($isStale || $isCapped) {
						$ledger['seen'][$key] = ['t' => $fireMs, 'sent' => false];
					}
					else {
						$ledger['seen'][$key] = ['t' => $fireMs, 'sent' => true];
						$ledger['fired'][$dayKey] = ($ledger['fired'][$dayKey] ?? 0) + 1;
						$out[] = self::occurrence('availability', $q, $qid, $qTitle, $body, $includeDeadline, $fireMs, $fireMs, $offsetMs);
					}
					$status = $ledger['seen'][$key];
				}
				if(!is_array($status) || empty($status['sent']))
					continue;

				for($k = 1; $k <= $reminderCount; $k++) {
					$rt = $fireMs + $k * $reminderDelayMs;
					$rKey = "$key:r$k";
					if($rt > $nowMs || isset($ledger['seen'][$rKey]))
						continue;
					$fresh = $nowMs - $rt <= self::MAX_AGE_MS && $lastDataSetTime < $fireMs;
					$ledger['seen'][$rKey] = ['t' => $rt, 'sent' => $fresh];
					if($fresh)
						$out[] = self::occurrence('reminder', $q, $qid, $qTitle, $body, $includeDeadline, $rt, $fireMs, $offsetMs);
				}
			}
		}

		self::prune($ledger, $nowMs, $offsetMs);
		return $out;
	}

	/** @return array<int, array{qi:int, q:array, ai:int, at:array, ei:int, et:array}> */
	private static function collect(array $study): array {
		$found = [];
		foreach(($study['questionnaires'] ?? []) as $qi => $q) {
			foreach(($q['actionTriggers'] ?? []) as $ai => $at) {
				foreach(($at['eventTriggers'] ?? []) as $ei => $et) {
					if(($et['cueCode'] ?? '') === self::CUE)
						$found[] = ['qi' => $qi, 'q' => $q, 'ai' => $ai, 'at' => $at, 'ei' => $ei, 'et' => $et];
				}
			}
		}
		return $found;
	}

	private static function eventMatches(array $et, string $provider, string $kind): bool {
		$wantedProvider = (string) ($et['wearableProvider'] ?? 'any');
		return $kind === (string) ($et['wearableEvent'] ?? 'sleep')
			&& ($wantedProvider === 'any' || $wantedProvider === $provider);
	}

	/** Local time of day (ms) of an instant. */
	private static function timeOfDay(int $utcMs, int $offsetMs): int {
		return (($utcMs - $offsetMs) % self::ONE_DAY + self::ONE_DAY) % self::ONE_DAY;
	}

	/** Daily window check; a window whose end precedes its start wraps over midnight. */
	private static function inWindow(array $et, int $tod): bool {
		if(empty($et['wearableWindowEnabled']))
			return true;
		$start = (int) ($et['wearableWindowStart'] ?? self::DEFAULT_WINDOW_START);
		$end   = (int) ($et['wearableWindowEnd'] ?? self::DEFAULT_WINDOW_END);
		if($start < 0 || $end < 0) // a cleared time input is stored as -1: treat as unrestricted
			return true;
		return $start <= $end ? ($tod >= $start && $tod <= $end) : ($tod >= $start || $tod <= $end);
	}

	/** Fixed delay, or a value in [delayMinimumSec, delaySec] that is stable for a given seed. */
	private static function delayMs(array $et, string $seed): int {
		$max = max(0, (int) ($et['delaySec'] ?? 0));
		if(empty($et['randomDelay']))
			return $max * 1000;
		$min = min($max, max(0, (int) ($et['delayMinimumSec'] ?? 0)));
		return ($min + (crc32($seed) % ($max - $min + 1))) * 1000;
	}

	private static function anyAtOrBefore(array $times, int $limit): bool {
		foreach($times as $time) {
			if($time <= $limit)
				return true;
		}
		return false;
	}

	/** The questionnaire's own active period (absolute dates and days since joining). */
	private static function isActive(array $q, int $fireMs, int $offsetMs, int $anchorDayLocal): bool {
		$durStart = (int) ($q['durationStart'] ?? 0);
		$durEnd   = (int) ($q['durationEnd'] ?? 0);
		if(($durStart > 0 && $fireMs < $durStart) || ($durEnd > 0 && $fireMs > $durEnd))
			return false;
		$startDay = (int) ($q['durationStartingAfterDays'] ?? 0);
		$period   = (int) ($q['durationPeriodDays'] ?? 0);
		$day = PushScheduler::dayIndex($fireMs - $offsetMs, $anchorDayLocal);
		return $day >= $startDay && ($period <= 0 || $day <= $startDay + $period - 1);
	}

	private static function occurrence(string $type, array $q, int $qid, string $title, string $body, bool $includeDeadline, int $timestamp, int $windowStart, int $offsetMs): array {
		$dayMidnightLocal = intdiv($windowStart - $offsetMs, self::ONE_DAY) * self::ONE_DAY;
		$deadlineTod = PushScheduler::deadlineTod($q, $windowStart - $offsetMs - $dayMidnightLocal);
		return [
			'type' => $type, 'qid' => $qid, 'title' => $title,
			'body' => PushScheduler::appendDeadline($body, $includeDeadline, $deadlineTod),
			'timestamp' => $timestamp, 'windowStart' => $windowStart,
			'deadline' => $deadlineTod === null ? null : $dayMidnightLocal + $deadlineTod + $offsetMs,
			'occKey' => "sensor:$windowStart",
		];
	}

	private static function prune(array &$ledger, int $nowMs, int $offsetMs): void {
		$cutoff = $nowMs - self::LEDGER_KEEP_DAYS * self::ONE_DAY;
		foreach($ledger['seen'] as $key => $entry) {
			if(!is_array($entry) || (int) ($entry['t'] ?? 0) < $cutoff)
				unset($ledger['seen'][$key]);
		}
		$minDay = intdiv($cutoff - $offsetMs, self::ONE_DAY);
		foreach(array_keys($ledger['fired']) as $dayKey) {
			$parts = explode(':', (string) $dayKey);
			if((int) end($parts) < $minDay)
				unset($ledger['fired'][$dayKey]);
		}
	}
}
