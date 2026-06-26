<?php
declare(strict_types=1);

namespace backend\notifications;

/**
 * Computes which questionnaire reminders are due for one participant, from the
 * study's existing schedule config (the same config the native apps consume).
 *
 * Supports fixed AND random signal times, reminder repeats, and completion-aware
 * suppression:
 *  - Fixed signal time → fires at startTimeOfDay (participant-local).
 *  - Random signal window → `frequency` times are sampled within
 *    [startTimeOfDay, endTimeOfDay] ONCE per day and persisted in `$realized`
 *    (the per-participant .state), so they stay stable across the per-minute runs
 *    instead of jittering. (They need not match the native app's own random roll.)
 *  - Reminders (reminder_count × reminder_delay_minu) follow each base, and are
 *    suppressed once the participant has submitted anything since the base time
 *    (a study-wide lastDataSetTime heuristic — good enough for EMA, where a
 *    submission right after a prompt is almost always the prompted survey).
 *
 * Times of day are participant-local via the tz offset captured at subscribe time.
 * The day/weekday/duration math is a best-effort port of helpers/Scheduler.ts and
 * should be validated against the canonical Kotlin sharedCode for advanced cases.
 */
class PushScheduler {
	const ONE_DAY = 86400000;
	const ACTION_NOTIFICATION = 3; // Action.type (1=invitation, 2=message, 3=notification)

	/**
	 * @param array $study           decoded, language-resolved study config
	 * @param int   $anchorMs        participant schedule anchor (join time, UTC ms)
	 * @param int   $tzOffsetMin     participant tz offset (JS getTimezoneOffset(), minutes)
	 * @param int   $sinceMs         exclusive lower bound (per-participant cursor)
	 * @param int   $nowMs           inclusive upper bound (now)
	 * @param int   $lastDataSetTime participant's last submission time (UTC ms), or -1
	 * @param array $realized        persisted realized random times; mutated in place
	 * @return array<int, array{title:string, body:string, timestamp:int}>
	 */
	public static function computeDueOccurrences(
		array $study, int $anchorMs, int $tzOffsetMin, int $sinceMs, int $nowMs,
		int $lastDataSetTime, array &$realized
	): array {
		$out = [];
		$offsetMs = $tzOffsetMin * 60000;
		$studyTitle = (is_string($study['title'] ?? null) && $study['title'] !== '') ? $study['title'] : 'ESMira';
		$anchorDayLocal = intdiv($anchorMs - $offsetMs, self::ONE_DAY) * self::ONE_DAY;
		$toDay = self::dayIndex($nowMs - $offsetMs, $anchorDayLocal);

		foreach(($study['questionnaires'] ?? []) as $qi => $q) {
			$qTitle = (is_string($q['title'] ?? null) && $q['title'] !== '') ? $q['title'] : $studyTitle;
			$durStartDay = (int) ($q['durationStartingAfterDays'] ?? 0);
			$durPeriod   = (int) ($q['durationPeriodDays'] ?? 0);
			$durStart    = (int) ($q['durationStart'] ?? 0);
			$durEnd      = (int) ($q['durationEnd'] ?? 0);

			foreach(($q['actionTriggers'] ?? []) as $ai => $at) {
				$action = self::notificationAction($at);
				if($action === null)
					continue;
				[$body, $reminderCount, $reminderDelayMs] = $action;

				foreach(($at['schedules'] ?? []) as $si => $s) {
					$repeat     = max(1, (int) ($s['dailyRepeatRate'] ?? 1));
					$weekdays   = (int) ($s['weekdays'] ?? 0);
					$dayOfMonth = (int) ($s['dayOfMonth'] ?? 0);
					$skipFirst  = !empty($s['skipFirstInLoop']);
					$firstDay   = $durStartDay + ($skipFirst ? $repeat : 0);
					$maxDay     = $durPeriod > 0 ? ($firstDay + $durPeriod - 1) : PHP_INT_MAX;

					// Look back enough days that reminders of an earlier base still surface.
					$lookback = $reminderCount > 0 ? (int) ceil(($reminderCount * $reminderDelayMs) / self::ONE_DAY) + 1 : 0;
					$fromDay  = max($firstDay, self::dayIndex($sinceMs - $offsetMs, $anchorDayLocal) - $lookback);

					foreach(($s['signalTimes'] ?? []) as $sti => $st) {
						$isRandom = !empty($st['random']);
						for($d = $fromDay; $d <= $toDay; $d++) {
							if($d < $firstDay || $d > $maxDay)
								continue;
							if(($d - $firstDay) % $repeat !== 0)
								continue;
							$dayMidnightLocal = $anchorDayLocal + $d * self::ONE_DAY;
							if($weekdays !== 0 && !self::weekdayMatches($dayMidnightLocal, $weekdays))
								continue;
							if($dayOfMonth !== 0 && (int) gmdate('j', intdiv($dayMidnightLocal, 1000)) !== $dayOfMonth)
								continue;

							if($isRandom) {
								$key = "$qi:$ai:$si:$sti:$d";
								if(!isset($realized[$key]))
									$realized[$key] = self::sampleRandomTimes($st, $dayMidnightLocal, $offsetMs);
								$baseTimes = $realized[$key];
							}
							else {
								$baseTimes = [$dayMidnightLocal + (int) ($st['startTimeOfDay'] ?? 0) + $offsetMs];
							}

							foreach($baseTimes as $T) {
								$T = (int) $T;
								if($durStart > 0 && $T < $durStart)
									continue;
								if($durEnd > 0 && $T > $durEnd)
									continue;
								if($T > $sinceMs && $T <= $nowMs)
									$out[] = ['title' => $qTitle, 'body' => $body, 'timestamp' => $T];
								for($k = 1; $k <= $reminderCount; $k++) {
									$rt = $T + $k * $reminderDelayMs;
									if($rt <= $sinceMs || $rt > $nowMs)
										continue;
									if($lastDataSetTime >= $T) // completed since the base — stop nagging
										continue;
									$out[] = ['title' => $qTitle, 'body' => 'Reminder: ' . $body, 'timestamp' => $rt];
								}
							}
						}
					}
				}
			}
		}

		self::pruneRealized($realized, $toDay);
		return $out;
	}

	/** [body, reminderCount, reminderDelayMs] for a trigger's Notification action, or null. */
	private static function notificationAction(array $at): ?array {
		foreach(($at['actions'] ?? []) as $a) {
			if((int) ($a['type'] ?? 0) === self::ACTION_NOTIFICATION) {
				$msg   = $a['msgText'] ?? '';
				$body  = (is_string($msg) && $msg !== '') ? $msg : 'You have a questionnaire to complete.';
				$count = max(0, (int) ($a['reminder_count'] ?? 0));
				$delay = max(0, (int) ($a['reminder_delay_minu'] ?? 0)) * 60000;
				if($delay === 0)
					$count = 0; // no spacing configured → no reminders
				return [$body, $count, $delay];
			}
		}
		return null;
	}

	/** Sample `frequency` random times within [start,end] for one day, as UTC ms. */
	private static function sampleRandomTimes(array $st, int $dayMidnightLocal, int $offsetMs): array {
		$start = (int) ($st['startTimeOfDay'] ?? 0);
		$end   = (int) ($st['endTimeOfDay'] ?? $start);
		if($end < $start)
			$end = $start;
		$frequency = max(1, (int) ($st['frequency'] ?? 1));
		$block = intdiv($end - $start, $frequency);
		$times = [];
		for($i = 0; $i < $frequency; $i++) {
			$blockStart = $start + $i * $block;
			$tod = $block > 0 ? $blockStart + random_int(0, $block) : $blockStart;
			$times[] = $dayMidnightLocal + $tod + $offsetMs;
		}
		return $times;
	}

	/** Drop realized entries for days now safely in the past (keeps today + yesterday). */
	private static function pruneRealized(array &$realized, int $toDay): void {
		foreach(array_keys($realized) as $key) {
			$parts = explode(':', (string) $key);
			if((int) end($parts) < $toDay - 1)
				unset($realized[$key]);
		}
	}

	private static function dayIndex(int $localMs, int $anchorDayLocal): int {
		return intdiv((intdiv($localMs, self::ONE_DAY) * self::ONE_DAY) - $anchorDayLocal, self::ONE_DAY);
	}

	/** weekdays is a bitfield, bit 0 = Sunday … bit 6 = Saturday. */
	private static function weekdayMatches(int $localMs, int $weekdays): bool {
		$dayNum = intdiv($localMs, self::ONE_DAY); // days since (local) epoch
		$dow = (($dayNum % 7) + 4) % 7;            // 1970-01-01 was a Thursday (index 4); 0=Sun
		return ($weekdays & (1 << $dow)) !== 0;
	}
}
