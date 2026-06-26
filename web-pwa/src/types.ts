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
  | 'cognitive'
  | 'info';

export interface PreloadedQuestion {
  id: string; // == ESMira input `name` (unique study-wide → response key)
  text: string; // question text; for `info` may contain raw HTML
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
  // info items render text as raw HTML (cognitive link-outs etc.)
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
}

export interface EsmiraPage {
  header?: string;
  inputs: EsmiraInput[];
  randomized?: boolean;
}

export interface EsmiraQuestionnaire {
  internalId: number;
  title: string;
  pages: EsmiraPage[];
  durationPeriodDays?: number;
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
  /** When true, the researcher has enabled server-sent web push reminders for PWA
   *  participants. The client requests notification permission after consent and
   *  registers a push subscription; the server schedules/sends the reminders. */
  webPushEnabled?: boolean;
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
}
