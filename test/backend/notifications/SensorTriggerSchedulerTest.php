<?php

namespace backend\notifications;

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../../autoload.php';

class SensorTriggerSchedulerTest extends TestCase {
	const H = 3600000;
	const DAY = 86400000;
	// 2025-03-10 00:00 UTC (a Monday); tz offset 0 keeps local == UTC in the assertions.
	const D0 = 1741564800000;

	private function study(array $eventTrigger, array $questionnaire = [], array $action = []): array {
		return ['title' => 'S', 'questionnaires' => [array_merge([
			'internalId' => 7,
			'title' => 'Morning',
			'actionTriggers' => [[
				'actions' => [array_merge(['msgText' => 'How did you sleep?'], $action)],
				'eventTriggers' => [array_merge(['cueCode' => 'wearable_event'], $eventTrigger)],
			]],
		], $questionnaire)]];
	}

	private function event(int $t, string $kind = 'sleep', string $provider = 'withings'): array {
		return ['t' => $t, 'provider' => $provider, 'kind' => $kind];
	}

	private function compute(array $study, array $events, int $now, array &$ledger, int $lastData = -1): array {
		return SensorTriggerScheduler::computeOccurrences($study, $events, self::D0 - 5 * self::DAY, 0, $now, $lastData, $ledger);
	}

	function test_matching_event_fires_prompt() {
		$ledger = [];
		$out = $this->compute($this->study([]), [$this->event(self::D0 + 7 * self::H)], self::D0 + 7 * self::H + 60000, $ledger);
		$this->assertCount(1, $out);
		$this->assertSame(7, $out[0]['qid']);
		$this->assertSame(self::D0 + 7 * self::H, $out[0]['timestamp']);
		$this->assertSame('How did you sleep?', $out[0]['body']);
	}

	function test_other_kind_or_provider_is_ignored() {
		$ledger = [];
		$study = $this->study(['wearableProvider' => 'fitbit']);
		$out = $this->compute($study, [
			$this->event(self::D0 + 7 * self::H, 'sleep', 'withings'),
			$this->event(self::D0 + 7 * self::H, 'activity', 'fitbit'),
		], self::D0 + 8 * self::H, $ledger);
		$this->assertSame([], $out);
	}

	function test_event_is_sent_once_across_runs() {
		$ledger = [];
		$study = $this->study([]);
		$events = [$this->event(self::D0 + 7 * self::H)];
		$this->assertCount(1, $this->compute($study, $events, self::D0 + 7 * self::H + 60000, $ledger));
		$this->assertCount(0, $this->compute($study, $events, self::D0 + 7 * self::H + 120000, $ledger));
	}

	function test_event_appended_late_is_still_picked_up() {
		// The previous run happened after the event's timestamp but before it was written.
		$ledger = [];
		$study = $this->study([]);
		$this->assertCount(0, $this->compute($study, [], self::D0 + 7 * self::H + 60000, $ledger));
		$out = $this->compute($study, [$this->event(self::D0 + 7 * self::H + 30000)], self::D0 + 7 * self::H + 120000, $ledger);
		$this->assertCount(1, $out);
	}

	function test_delay_postpones_prompt() {
		$ledger = [];
		$study = $this->study(['delaySec' => 600]);
		$events = [$this->event(self::D0 + 7 * self::H)];
		$this->assertCount(0, $this->compute($study, $events, self::D0 + 7 * self::H + 300000, $ledger));
		$out = $this->compute($study, $events, self::D0 + 7 * self::H + 601000, $ledger);
		$this->assertCount(1, $out);
		$this->assertSame(self::D0 + 7 * self::H + 600000, $out[0]['timestamp']);
	}

	function test_random_delay_is_stable_and_in_range() {
		$study = $this->study(['randomDelay' => true, 'delayMinimumSec' => 60, 'delaySec' => 120]);
		$events = [$this->event(self::D0 + 7 * self::H)];
		$fireTimes = [];
		foreach([1, 2] as $_) {
			$ledger = [];
			$out = $this->compute($study, $events, self::D0 + 8 * self::H, $ledger);
			$fireTimes[] = $out[0]['timestamp'];
		}
		$this->assertSame($fireTimes[0], $fireTimes[1]);
		$delay = $fireTimes[0] - (self::D0 + 7 * self::H);
		$this->assertGreaterThanOrEqual(60000, $delay);
		$this->assertLessThanOrEqual(120000, $delay);
	}

	function test_daily_window_filters_events() {
		$study = $this->study(['wearableWindowEnabled' => true, 'wearableWindowStart' => 5 * self::H, 'wearableWindowEnd' => 11 * self::H]);
		$ledger = [];
		$out = $this->compute($study, [
			$this->event(self::D0 + 3 * self::H),   // too early
			$this->event(self::D0 + 14 * self::H),  // too late
		], self::D0 + 15 * self::H, $ledger);
		$this->assertSame([], $out);
		$ledger = [];
		$out = $this->compute($study, [$this->event(self::D0 + 8 * self::H)], self::D0 + 8 * self::H + 1000, $ledger);
		$this->assertCount(1, $out);
	}

	function test_window_wraps_over_midnight() {
		$study = $this->study(['wearableWindowEnabled' => true, 'wearableWindowStart' => 22 * self::H, 'wearableWindowEnd' => 2 * self::H]);
		$ledger = [];
		$out = $this->compute($study, [$this->event(self::D0 + 23 * self::H)], self::D0 + 23 * self::H + 1000, $ledger);
		$this->assertCount(1, $out);
	}

	function test_max_per_day_caps_prompts_but_next_day_resets() {
		$study = $this->study(['wearableMaxPerDay' => 2]);
		$ledger = [];
		$events = [
			$this->event(self::D0 + 7 * self::H), $this->event(self::D0 + 7 * self::H + 600000), $this->event(self::D0 + 7 * self::H + 1200000),
		];
		$out = $this->compute($study, $events, self::D0 + 7 * self::H + 1300000, $ledger);
		$this->assertCount(2, $out);
		$events[] = $this->event(self::D0 + self::DAY + 7 * self::H);
		$out = $this->compute($study, $events, self::D0 + self::DAY + 7 * self::H + 1000, $ledger);
		$this->assertCount(1, $out);
	}

	function test_fallback_fires_when_no_event_arrived() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		$this->assertCount(0, $this->compute($study, [], self::D0 + 10 * self::H - 60000, $ledger));
		$out = $this->compute($study, [], self::D0 + 10 * self::H + 60000, $ledger);
		$this->assertCount(1, $out);
		$this->assertSame(self::D0 + 10 * self::H, $out[0]['timestamp']);
		$this->assertCount(0, $this->compute($study, [], self::D0 + 10 * self::H + 120000, $ledger));
	}

	function test_fallback_skipped_when_sensor_already_fired_that_day() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		$events = [$this->event(self::D0 + 7 * self::H)];
		$this->assertCount(1, $this->compute($study, $events, self::D0 + 7 * self::H + 1000, $ledger));
		$this->assertCount(0, $this->compute($study, $events, self::D0 + 10 * self::H + 60000, $ledger));
	}

	function test_late_sensor_event_after_fallback_does_not_prompt_twice() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		$this->compute($study, [], self::D0 + 9 * self::H, $ledger); // first run: sets the baseline
		$this->assertCount(1, $this->compute($study, [], self::D0 + 10 * self::H + 60000, $ledger));
		$events = [$this->event(self::D0 + 11 * self::H)];
		$this->assertCount(0, $this->compute($study, $events, self::D0 + 11 * self::H + 1000, $ledger));
	}

	function test_fallback_only_on_the_participants_active_days() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H], ['durationStartingAfterDays' => 2]);
		$ledger = [];
		// anchor is D0 - 5 days in run(); override via direct call: joined at D0 => day 0 is today.
		$out = SensorTriggerScheduler::computeOccurrences($study, [], self::D0, 0, self::D0 + 10 * self::H + 60000, -1, $ledger);
		$this->assertSame([], $out);
	}

	function test_stale_candidates_are_not_back_filled() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		$out = $this->compute($study, [$this->event(self::D0 + 2 * self::H)], self::D0 + 20 * self::H, $ledger);
		$this->assertSame([], $out);
	}

	function test_timezone_offset_shifts_fallback_to_local_time() {
		// JS getTimezoneOffset() is minutes WEST of UTC: -120 means UTC+2.
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		SensorTriggerScheduler::computeOccurrences($study, [], self::D0 - 5 * self::DAY, -120, self::D0 + 7 * self::H, -1, $ledger);
		$out = SensorTriggerScheduler::computeOccurrences($study, [], self::D0 - 5 * self::DAY, -120, self::D0 + 8 * self::H + 60000, -1, $ledger);
		$this->assertCount(1, $out);
		$this->assertSame(self::D0 + 8 * self::H, $out[0]['timestamp']); // 10:00 local = 08:00 UTC
	}

	function test_reminders_follow_sensor_prompt_until_completed() {
		$study = $this->study([], [], ['reminder_count' => 2, 'reminder_delay_minu' => 10]);
		$ledger = [];
		$events = [$this->event(self::D0 + 7 * self::H)];
		$out = $this->compute($study, $events, self::D0 + 7 * self::H + 11 * 60000, $ledger);
		$this->assertSame(['availability', 'reminder'], array_column($out, 'type'));
		$out = $this->compute($study, $events, self::D0 + 7 * self::H + 21 * 60000, $ledger, self::D0 + 7 * self::H + 15 * 60000);
		$this->assertSame([], $out); // answered in between: second reminder suppressed
	}

	function test_only_notifying_actions_fire() {
		$ledger = [];
		$study = $this->study([], [], ['type' => 2]); // in-app message
		$this->assertSame([], $this->compute($study, [$this->event(self::D0 + 7 * self::H)], self::D0 + 8 * self::H, $ledger));
	}

	function test_hasTriggers_and_wantsEvent() {
		$study = $this->study(['wearableProvider' => 'fitbit', 'wearableEvent' => 'activity']);
		$this->assertTrue(SensorTriggerScheduler::hasTriggers($study));
		$this->assertTrue(SensorTriggerScheduler::wantsEvent($study, 'fitbit', 'activity'));
		$this->assertFalse(SensorTriggerScheduler::wantsEvent($study, 'withings', 'activity'));
		$this->assertFalse(SensorTriggerScheduler::wantsEvent($study, 'fitbit', 'sleep'));
		$this->assertFalse(SensorTriggerScheduler::hasTriggers(['questionnaires' => [['actionTriggers' => [['eventTriggers' => [['cueCode' => 'joined']]]]]]]));
	}

	function test_first_run_does_not_back_fill_a_fallback_that_was_due_earlier() {
		$study = $this->study(['fallbackEnabled' => true, 'fallbackTimeOfDay' => 10 * self::H]);
		$ledger = [];
		$this->assertSame([], $this->compute($study, [], self::D0 + 10 * self::H + 60000, $ledger));
	}

	function test_first_run_still_sends_a_fresh_sensor_event() {
		$ledger = [];
		$out = $this->compute($this->study([]), [$this->event(self::D0 + 7 * self::H)], self::D0 + 7 * self::H + 60000, $ledger);
		$this->assertCount(1, $out);
	}

	function test_cap_counts_on_the_day_the_prompt_is_shown() {
		// Event 23:50, delayed 30 min => shown at 00:20 the NEXT day and uses that day's single slot,
		// so that day's 12:00 fallback must not prompt a second time.
		$study = $this->study(['delaySec' => 1800, 'fallbackEnabled' => true, 'fallbackTimeOfDay' => 12 * self::H]);
		$ledger = [];
		$this->compute($study, [], self::D0 + 23 * self::H, $ledger);
		$event = $this->event(self::D0 + 23 * self::H + 50 * 60000);
		$this->assertCount(1, $this->compute($study, [$event], self::D0 + self::DAY + 21 * 60000, $ledger));
		$this->assertCount(0, $this->compute($study, [$event], self::D0 + self::DAY + 12 * self::H + 60000, $ledger));
	}

	function test_cap_survives_questionnaire_reordering() {
		$study = $this->study([]);
		$ledger = [];
		$event = $this->event(self::D0 + 7 * self::H);
		$this->assertCount(1, $this->compute($study, [$event], self::D0 + 7 * self::H + 1000, $ledger));
		// same questionnaire (internalId 7), now at a different position in the list
		$study['questionnaires'] = [['internalId' => 99, 'actionTriggers' => []], $study['questionnaires'][0]];
		$later = $this->event(self::D0 + 7 * self::H + 600000);
		$this->assertCount(0, $this->compute($study, [$event, $later], self::D0 + 7 * self::H + 610000, $ledger));
	}
}
