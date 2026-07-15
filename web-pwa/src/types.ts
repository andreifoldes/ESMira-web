// ── Engine-facing question/session types ────────────────────────
// (Consumed by surveyEngine.ts, ported from the iEMAbot PWA.)

export interface ShowIf {
  question_id: string;
  operator: 'equals' | 'not_equals' | 'gte';
  value: string;
}

/** Internal question type the chat UI renders. */
export type QType =
  | 'likert'
  | 'choice'
  | 'multi_choice'
  | 'yesno'
  | 'text'
  | 'number'
  | 'time'
  | 'duration'
  | 'date'
  | 'va_scale'
  | 'audio'
  | 'cognitive'
  | 'info';

export interface PreloadedQuestion {
  id: string; // == ESMira input `name` (unique study-wide → response key)
  text: string; // question text — authored in the rich-text editor, so may contain HTML
  type: QType;
  required: boolean;
  options?: string[] | null;
  // likert / va_scale
  scale_min?: number;
  scale_max?: number;
  scale_min_label?: string;
  scale_max_label?: string;
  max_value?: number; // va_scale upper bound (default 100)
  // yesno (ESMira `binary`: left=value0/label, right=value1/label)
  no_label?: string;
  no_value?: string;
  yes_label?: string;
  yes_value?: string;
  // render `text` as raw HTML (set on every question — text is rich-text-authored)
  is_html?: boolean;
  // cognitive/link-out tasks: launch this URL in an in-app iframe overlay
  title?: string;
  description?: string;
  launch_url?: string;
  launch_label?: string;
  // number input hint
  decimal?: boolean;
  // duration input constraints
  max_hours?: number;   // upper bound for the hours wheel (default 24)
  minute_step?: number; // step between minute options (default 1)
  // audio (record_audio): max recording length in seconds (default 300 = 5 min)
  max_recording_seconds?: number;
  show_if?: ShowIf | null;
  other_specify?: { options: string[]; prompt: string } | null;
}

export interface PreloadedSection {
  id: string;
  name: string;
  description: string;
  start: number;
  length: number;
  allow_change_all: boolean;
}

export interface PreloadedSession {
  session_id: string;
  survey_id: string;
  survey_name: string;
  survey_description: string;
  questions: PreloadedQuestion[];
  sections: PreloadedSection[] | null;
  question_order: number[] | null;
  allow_response_editing: boolean;
  allow_change_all: boolean;
  answered: Record<string, string> | null;
  current_question_index: number;
}

// ── Raw ESMira study JSON (from api/studies.php) ─────────────────

export type EsmiraResponseType =
  | 'binary'
  | 'date'
  | 'duration'
  | 'dynamic_input'
  | 'image'
  | 'likert'
  | 'list_multiple'
  | 'list_single'
  | 'number'
  | 'photo'
  | 'record_audio'
  | 'text'
  | 'text_input'
  | 'time'
  | 'va_scale'
  | 'video'
  | 'webapp'
  | string;

export interface EsmiraInput {
  name: string;
  responseType: EsmiraResponseType;
  text?: string;
  required?: boolean;
  likertSteps?: number;
  leftSideLabel?: string;
  rightSideLabel?: string;
  listChoices?: string[];
  maxValue?: number;
  numberHasDecimal?: boolean;
  other?: boolean;
  url?: string;
  /** "webapp" type: instructions shown on the launch card (the item `text` is the title). */
  webappDescription?: string;
  /** "record_audio" type: max recording length in seconds (falls back to 300 = 5 min). */
  maxLength?: number;
}

export interface EsmiraPage {
  header?: string;
  inputs: EsmiraInput[];
  randomized?: boolean;
}

/** A single notification time within a schedule (ms since local midnight). */
export interface EsmiraSignalTime {
  startTimeOfDay: number;
  endTimeOfDay?: number;
  random?: boolean;
  frequency?: number;
}

/** Recurrence for a set of signal times. */
export interface EsmiraSchedule {
  dailyRepeatRate?: number; // 1 = every day, 2 = every other day, …
  weekdays?: number;        // bitfield, bit0=Sun … bit6=Sat; 0 = every weekday
  dayOfMonth?: number;      // 1–31, 0 = any
  skipFirstInLoop?: boolean;
  startDayOne?: boolean;
  signalTimes?: EsmiraSignalTime[];
}

export interface EsmiraActionTrigger {
  schedules?: EsmiraSchedule[];
}

export interface EsmiraQuestionnaire {
  internalId: number;
  title: string;
  pages: EsmiraPage[];
  // ── Scheduling / availability (served verbatim by api/studies.php) ──
  /** Activation delay: not available until this many days after joining (0 = immediately). */
  durationStartingAfterDays?: number;
  /** Active for this many days after joining (0 = no expiry). */
  durationPeriodDays?: number;
  /** Absolute availability window (epoch ms); 0 = unbounded. */
  durationStart?: number;
  durationEnd?: number;
  /** Completion constraints. */
  completableOnce?: boolean;
  /** At most one completion per local calendar day (any signal count / passive). */
  completableOncePerDay?: boolean;
  completableOncePerNotification?: boolean;
  completableMinutesAfterNotification?: number;
  completableAtSpecificTime?: boolean;
  completableAtSpecificTimeStart?: number; // ms since midnight, -1 = off
  completableAtSpecificTimeEnd?: number;
  /** Web push only: include a "Complete by HH:MM" deadline in the reminder body. */
  notificationIncludeDeadline?: boolean;
  limitCompletionFrequency?: boolean;
  completionFrequencyMinutes?: number;
  actionTriggers?: EsmiraActionTrigger[];
  /** Which answered items show a "Change response" affordance in the chat flow:
   *  'previous' (only the last, default), 'any' (every prior item), or 'none'
   *  (disabled — e.g. cognitive tasks, which must not be re-attempted). */
  changeResponseMode?: 'previous' | 'any' | 'none';
}

export interface EsmiraStudy {
  id: number;
  version?: number;
  subVersion?: number;
  lang?: string;
  title: string;
  studyDescription?: string;
  informedConsentForm?: string;
  postInstallInstructions?: string;
  accessKeys?: string[];
  /** When true (set by the researcher in the designer), first-time web participants
   *  see a tutorial overview with optional no-submit practice runs before starting. */
  enableTutorialMode?: boolean;
  /** Researcher-customised tutorial prompts (empty = the PWA's built-in defaults). */
  tutorialOffer?: string;
  tutorialIntro?: string;
  /** When true, the researcher has enabled server-sent web push reminders for PWA
   *  participants. The client requests notification permission after consent and
   *  registers a push subscription; the server schedules/sends the reminders. */
  webPushEnabled?: boolean;
  /** When true, the researcher has enabled wearable data sharing. The PWA offers
   *  the intersection of `wearablesProviders` and the server's `wearableProviders`
   *  (those with OAuth credentials configured) as connectable devices. */
  wearablesEnabled?: boolean;
  /** Provider slugs the researcher offers for this study (e.g. ["fitbit","oura"]). */
  wearablesProviders?: string[];
  questionnaires: EsmiraQuestionnaire[];
}

export interface StudiesEnvelope {
  success: boolean;
  serverVersion: number;
  dataset: EsmiraStudy[];
  error?: string;
  /** Base64url VAPID public key, present only when a study in the set has web push
   *  enabled. The client passes it to `pushManager.subscribe(applicationServerKey)`. */
  vapidPublicKey?: string;
  /** Wearable providers with OAuth credentials configured on the server. The PWA only
   *  offers those that are also listed in a study's `wearablesProviders`. */
  wearableProviders?: string[];
}

/** A connected wearable as reported by api/wearables_status.php. */
export interface WearableStatus {
  provider: string;
  /** UTC ms of the last day the server synced for this provider, or null if none yet. */
  lastSync: number | null;
}
