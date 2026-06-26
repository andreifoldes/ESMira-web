<?php
declare(strict_types=1);

namespace backend\notifications;

use backend\Configs;
use backend\FileSystemBasics;
use backend\fileSystem\loader\UserDataLoader;
use backend\fileSystem\PathsFS;
use backend\Main;
use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;
use Throwable;

/**
 * Sends the questionnaire reminders that are due, to every registered web-push
 * subscription. Designed to be invoked once a minute by cron
 * (cli/push_send_due.php).
 *
 * Per participant we keep a tiny `.state` file with a `cursor` (the last instant
 * processed); each run sends occurrences in (cursor, now] exactly once. The first
 * run for a participant initialises the cursor to "now", so enabling push never
 * backfills historical reminders.
 */
class PushSender {
	public static function run(): array {
		$publicKey  = Configs::get('vapid_public_key');
		$privateKey = Configs::get('vapid_private_key');
		if(empty($publicKey) || empty($privateKey))
			return ['error' => 'VAPID keys not configured (run cli/generate_vapid.php)'];

		$subject = Configs::get('vapid_subject');
		if(empty($subject))
			$subject = 'mailto:noreply@esmira';

		$webPush = new WebPush(['VAPID' => [
			'subject'    => $subject,
			'publicKey'  => $publicKey,
			'privateKey' => $privateKey,
		]]);

		$now        = Main::getMilliseconds();
		$defaultLang = Configs::get('defaultLang') ?: 'en';
		$studyStore = Configs::getDataStore()->getStudyStore();

		$queued = 0;
		$studiesProcessed = 0;

		foreach(self::listStudyIds() as $studyId) {
			try {
				$study = json_decode($studyStore->getStudyLangConfigAsJson($studyId, $defaultLang), true);
			}
			catch(Throwable $e) {
				continue; // unreadable / no config in this lang — skip
			}
			if(!is_array($study) || empty($study['webPushEnabled']))
				continue;

			$folder = PathsFS::folderPushSubscriptions($studyId);
			if(!is_dir($folder))
				continue;
			$studiesProcessed++;

			foreach(array_diff(scandir($folder), ['.', '..']) as $entry) {
				if(self::isStateFile($entry))
					continue;
				$file = $folder . $entry;
				$data = json_decode(@file_get_contents($file), true);
				if(!is_array($data) || empty($data['subscription']['endpoint']))
					continue;

				$userId = (string) ($data['userId'] ?? $entry);
				$tz     = (int) ($data['tzOffset'] ?? 0);

				// Prefer the participant's real join time (and read completion state)
				// from UserData; fall back to the subscribe time if they haven't
				// submitted yet (UserData is created on first submission).
				$anchor = (int) ($data['created'] ?? $now);
				$lastDataSetTime = -1;
				$userDataPath = PathsFS::fileUserData($studyId, $userId);
				if(file_exists($userDataPath)) {
					try {
						$ud = UserDataLoader::import(file_get_contents($userDataPath));
						if(!empty($ud->joinedTime))
							$anchor = (int) $ud->joinedTime;
						$lastDataSetTime = (int) $ud->lastDataSetTime;
					}
					catch(Throwable $e) { /* corrupt/unreadable — use subscribe time */ }
				}

				$stateFile = $file . '.state';
				$state     = json_decode(@file_get_contents($stateFile), true);
				$cursor    = (is_array($state) && isset($state['cursor'])) ? (int) $state['cursor'] : $now;
				$realized  = (is_array($state) && isset($state['realized']) && is_array($state['realized'])) ? $state['realized'] : [];

				$occurrences = PushScheduler::computeDueOccurrences($study, $anchor, $tz, $cursor, $now, $lastDataSetTime, $realized);
				foreach($occurrences as $occ) {
					try {
						$sub = Subscription::create([
							'endpoint' => $data['subscription']['endpoint'],
							'keys'     => [
								'p256dh' => $data['subscription']['keys']['p256dh'] ?? '',
								'auth'   => $data['subscription']['keys']['auth'] ?? '',
							],
						]);
						$webPush->queueNotification($sub, json_encode([
							'title' => $occ['title'],
							'body'  => $occ['body'],
							'url'   => '/esmira/pwa/',
						]));
						$queued++;
					}
					catch(Throwable $e) {
						/* malformed subscription — skip this occurrence */
					}
				}
				// Advance the cursor and persist realized random times (so they stay
				// stable across the per-minute runs) whether or not anything was due.
				try { FileSystemBasics::writeFile($stateFile, json_encode(['cursor' => $now, 'realized' => $realized])); }
				catch(Throwable $e) { /* non-fatal */ }
			}
		}

		// Deliver, and prune subscriptions the push service reports as gone (404/410).
		foreach($webPush->flush() as $report) {
			if(!$report->isSuccess() && $report->isSubscriptionExpired())
				self::removeSubscriptionByEndpoint($report->getEndpoint());
		}

		return ['studies' => $studiesProcessed, 'queued' => $queued];
	}

	/** Numeric study folders under the studies root. */
	private static function listStudyIds(): array {
		$folder = PathsFS::folderStudies();
		if(!is_dir($folder))
			return [];
		$ids = [];
		foreach(array_diff(scandir($folder), ['.', '..']) as $entry) {
			if(ctype_digit($entry) && is_dir($folder . $entry))
				$ids[] = (int) $entry;
		}
		return $ids;
	}

	private static function isStateFile(string $entry): bool {
		return substr($entry, -6) === '.state';
	}

	private static function removeSubscriptionByEndpoint(string $endpoint): void {
		foreach(self::listStudyIds() as $studyId) {
			$folder = PathsFS::folderPushSubscriptions($studyId);
			if(!is_dir($folder))
				continue;
			foreach(array_diff(scandir($folder), ['.', '..']) as $entry) {
				if(self::isStateFile($entry))
					continue;
				$file = $folder . $entry;
				$data = json_decode(@file_get_contents($file), true);
				if(is_array($data) && ($data['subscription']['endpoint'] ?? '') === $endpoint) {
					@unlink($file);
					@unlink($file . '.state');
					return;
				}
			}
		}
	}
}
