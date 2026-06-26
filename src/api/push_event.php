<?php

use backend\Configs;
use backend\JsonOutput;
use backend\Main;
use backend\notifications\PushEvents;

require_once dirname(__FILE__, 2) .'/backend/autoload.php';

// Push funnel receipt from the participant's service worker: a notification was
// 'received' (the SW got the push) or 'clicked' (the participant tapped it). The
// payload carries the studyId/userId the server put in the push (see PushSender).
// High-frequency telemetry — kept deliberately light.

if(!Configs::getDataStore()->isReady()) {
	echo JsonOutput::error('Server is not ready.');
	return;
}

$rest_json = Main::getRawPostInput();
if(!($json = json_decode($rest_json))) {
	echo JsonOutput::error('Unexpected data');
	return;
}
if(!isset($json->studyId) || !isset($json->userId) || !isset($json->event)) {
	echo JsonOutput::error('Missing data');
	return;
}

$studyId = (int) $json->studyId;
$userId  = (string) $json->userId;
$event   = (string) $json->event;

if(!Main::strictCheckInput($userId)) {
	echo JsonOutput::error('User is faulty');
	return;
}
if($event !== 'received' && $event !== 'clicked') { // only client-reportable events
	echo JsonOutput::error('Unknown event');
	return;
}

PushEvents::log($studyId, $userId, $event);
echo JsonOutput::successObj();
