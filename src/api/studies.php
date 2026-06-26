<?php

use backend\Configs;
use backend\exceptions\CriticalException;
use backend\JsonOutput;
use backend\Main;

require_once dirname(__FILE__, 2) .'/backend/autoload.php';

if(!Configs::getDataStore()->isReady()) {
	echo JsonOutput::error('Server is not ready.');
	return;
}

$includeFinished = isset($_GET['include_finished_studies']);

$studiesJson = [];
$studyStore = Configs::getDataStore()->getStudyStore();

try {
    $key = isset($_GET['access_key']) ? strtolower(trim($_GET['access_key'])) : '';
    $lang = Main::getLang(false);
    
    $ids = Configs::getDataStore()->getStudyAccessIndexStore()->getStudyIds($key);
    $dataStore = Configs::getDataStore();
    foreach ($ids as $studyId) {
        $metadata = $dataStore->getStudyMetadataStore($studyId);
		if($includeFinished || !$metadata->isOver()) {
			$studiesJson[] = $studyStore->getStudyLangConfigAsJson($studyId, $lang);
		}
    }
} catch (CriticalException $e) {
    echo JsonOutput::error($e->getMessage());
    return;
} catch (Throwable $e) {
    Main::reportError($e);
    echo JsonOutput::error('Internal server error');
    return;
}

$dataset = '[' .implode(',', $studiesJson) .']';

// When a VAPID public key is configured, hand it to the PWA so it can register a
// web-push subscription (it only does so for studies with webPushEnabled). The
// public key is safe to expose.
$vapidPublicKey = Configs::get('vapid_public_key');
if(!empty($vapidPublicKey))
	echo JsonOutput::successStringWithExtra($dataset, ['vapidPublicKey' => $vapidPublicKey]);
else
	echo JsonOutput::successString($dataset);