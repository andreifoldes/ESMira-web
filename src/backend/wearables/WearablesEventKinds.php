<?php
declare(strict_types=1);

namespace backend\wearables;

/**
 * Provider-neutral names for the "new data arrived" webhooks, and the translation to
 * each provider's own category (Withings `appli` code / Fitbit subscription collection).
 * Must stay in sync with WEARABLE_EVENTS in frontend/ts/data/study/EventTrigger.ts.
 *
 * A webhook only says "new data of this category exists"; it carries no measurement
 * value, so sensor triggers cannot (yet) be conditioned on the value itself.
 */
class WearablesEventKinds {
	const WITHINGS_APPLI = [
		'weight'         => 1,
		'blood_pressure' => 4,
		'activity'       => 16,
		'sleep'          => 44,
		'ecg'            => 54,
	];
	const FITBIT_COLLECTION = [
		'sleep'    => 'sleep',
		'activity' => 'activities',
		'weight'   => 'body',
	];

	/** Google Health webhook data types (kebab-case), grouped into the designer's event kinds. */
	const GOOGLEHEALTH_DATA_TYPES = [
		'sleep'    => ['sleep'],
		'activity' => ['steps', 'distance', 'floors', 'active-minutes', 'active-zone-minutes', 'exercise'],
		'weight'   => ['weight', 'body-fat'],
	];

	public static function kinds(): array {
		return array_keys(self::WITHINGS_APPLI);
	}

	/** Kinds the given provider can deliver by webhook. */
	public static function kindsFor(string $provider): array {
		switch($provider) {
			case 'withings': return array_keys(self::WITHINGS_APPLI);
			case 'fitbit':   return array_keys(self::FITBIT_COLLECTION);
			case 'googlehealth': return array_keys(self::GOOGLEHEALTH_DATA_TYPES);
			default:         return [];
		}
	}

	public static function fromWithingsAppli(int $appli): ?string {
		$kind = array_search($appli, self::WITHINGS_APPLI, true);
		return $kind === false ? null : (string) $kind;
	}

	public static function fromFitbitCollection(string $collection): ?string {
		$kind = array_search($collection, self::FITBIT_COLLECTION, true);
		return $kind === false ? null : (string) $kind;
	}

	public static function fromGoogleHealthDataType(string $dataType): ?string {
		foreach(self::GOOGLEHEALTH_DATA_TYPES as $kind => $types) {
			if(in_array($dataType, $types, true))
				return $kind;
		}
		return null;
	}
}
