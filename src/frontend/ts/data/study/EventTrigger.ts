import {DataStructure} from "../DataStructure";

/**
 * cueCode value for sensor-contingent triggers: the prompt fires when a wearable
 * provider (Withings / Fitbit) pushes a webhook saying new data of `wearableEvent`
 * arrived. All `wearable*` and `fallback*` fields are only meaningful for this cue.
 */
export const CUE_WEARABLE = "wearable_event"

export const WEARABLE_PROVIDER_ANY = "any"
export const WEARABLE_PROVIDERS: readonly string[] = ["withings", "fitbit"]
export const WEARABLE_PROVIDER_GOOGLE_HEALTH = "googlehealth"
/**
 * Google Health support is an untested placeholder (backend only; Google is not onboarding new
 * projects). Keep it out of the designer until it has been run against a real project, then flip this.
 */
export const SHOW_GOOGLE_HEALTH = false

/**
 * Normalised sensor events, mapped by the server onto each provider's webhook category
 * (Withings `appli` code / Fitbit subscription collection / Google Health data types).
 * `null`/`false` = the provider has no webhook for it.
 */
export const WEARABLE_EVENTS: Record<string, { withings: number | null, fitbit: string | null, googlehealth: boolean }> = {
	sleep:          { withings: 44, fitbit: "sleep",      googlehealth: true },
	activity:       { withings: 16, fitbit: "activities", googlehealth: true },
	weight:         { withings: 1,  fitbit: "body",       googlehealth: true },
	blood_pressure: { withings: 4,  fitbit: null,         googlehealth: false },
	ecg:            { withings: 54, fitbit: null,         googlehealth: false },
}

export class EventTrigger extends DataStructure {
	public label								= this.primitive<string>(		"label",							"Event")
	public cueCode								= this.primitive<string>(		"cueCode",							"joined")
	public skipThisQuestionnaire				= this.primitive<boolean>(		"skipThisQuestionnaire",			false)
	public specificQuestionnaireEnabled			= this.primitive<boolean>(		"specificQuestionnaireEnabled",	false)
	public specificQuestionnaireInternalId		= this.primitive<number>(		"specificQuestionnaireInternalId",	-1)
	public randomDelay							= this.primitive<boolean>(		"randomDelay",						false)
	public delaySec								= this.primitive<number>(		"delaySec",						0)
	public delayMinimumSec						= this.primitive<number>(		"delayMinimumSec",					0)

	// --- Sensor-contingent trigger (cueCode == CUE_WEARABLE) ---
	/** "any" or one of WEARABLE_PROVIDERS */
	public wearableProvider						= this.primitive<string>(		"wearableProvider",				WEARABLE_PROVIDER_ANY)
	/** key of WEARABLE_EVENTS */
	public wearableEvent						= this.primitive<string>(		"wearableEvent",					"sleep")
	/** Only react to events inside a daily window (local time of day, ms since midnight). */
	public wearableWindowEnabled				= this.primitive<boolean>(		"wearableWindowEnabled",			false)
	public wearableWindowStart					= this.primitive<number>(		"wearableWindowStart",				18000000)  // 05:00
	public wearableWindowEnd					= this.primitive<number>(		"wearableWindowEnd",				43200000)  // 12:00
	/** Cap on sensor-fired prompts per participant and local day. */
	public wearableMaxPerDay					= this.primitive<number>(		"wearableMaxPerDay",				1)

	// --- Fallback: time-contingent prompt if the sensor stays silent ---
	/** Send the prompt at `fallbackTimeOfDay` if no matching sensor event fired that day. */
	public fallbackEnabled						= this.primitive<boolean>(		"fallbackEnabled",					false)
	public fallbackTimeOfDay					= this.primitive<number>(		"fallbackTimeOfDay",				43200000)  // 12:00
}
