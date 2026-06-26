/**
 * ESMira backend client.
 *
 * READ:  GET  {root}api/studies.php?access_key=KEY   -> study definition JSON
 * WRITE: POST {root}api/datasets.php  (raw JSON, the same shape native apps and
 *        QuestionnaireSaver::saveDataset() send) -> identical CSV via CreateDataSet.
 *
 * No new backend code: datasets.php already json-decodes the body straight into
 * CreateDataSet::prepare(). We only add a `joined` event on first submission.
 */

import type { EsmiraStudy, PreloadedQuestion, StudiesEnvelope, WearableStatus } from '../types';

/** API root derived from the served base path ('/esmira/pwa/' -> '/esmira/'). */
const API_ROOT = (import.meta.env.BASE_URL || '/').replace(/pwa\/?$/, '');

/** Full URL of the ESMira server root the PWA talks to (for display in About). */
export function serverRootUrl(): string {
  try {
    return new URL(API_ROOT, window.location.href).href;
  } catch {
    return window.location.origin;
  }
}

export interface FetchedStudy {
  study: EsmiraStudy;
  serverVersion: number;
  /** Server VAPID public key for web push (only when a study has push enabled). */
  vapidPublicKey?: string;
  /** Wearable providers with credentials configured on the server. */
  wearableProviders?: string[];
}

export async function fetchStudy(accessKey: string, studyId?: number): Promise<FetchedStudy> {
  const url = `${API_ROOT}api/studies.php?access_key=${encodeURIComponent(accessKey)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`studies.php returned ${resp.status}`);
  const env = (await resp.json()) as StudiesEnvelope;
  if (!env.success) throw new Error(env.error || 'Study fetch failed');
  if (!env.dataset?.length) throw new Error('No study found for this access key');
  const study = studyId != null
    ? env.dataset.find(s => s.id === studyId) ?? env.dataset[0]
    : env.dataset[0];
  return {
    study,
    serverVersion: env.serverVersion,
    vapidPublicKey: env.vapidPublicKey,
    wearableProviders: env.wearableProviders,
  };
}

/**
 * Register this device's web-push subscription with the server, so the backend
 * scheduler can send the participant's questionnaire reminders even when the PWA
 * is closed. Mirrors the other POST endpoints; the subscription is the browser's
 * `PushSubscription` serialized as JSON ({ endpoint, keys: { p256dh, auth } }).
 */
export async function subscribeToPush(args: {
  study: EsmiraStudy;
  serverVersion: number;
  userId: string;
  subscription: PushSubscriptionJSON;
}): Promise<boolean> {
  const resp = await fetch(`${API_ROOT}api/push_subscribe.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: args.userId,
      studyId: args.study.id,
      serverVersion: args.serverVersion,
      subscription: args.subscription,
      // So the server can schedule "08:00" in the participant's local time, not its own.
      tzOffset: new Date().getTimezoneOffset(),
    }),
  });
  if (!resp.ok) throw new Error(`push_subscribe.php returned ${resp.status}`);
  const env = await resp.json();
  if (!env.success) throw new Error(env.error || 'Push subscription rejected');
  return true;
}

/**
 * Ask the server for this participant's next scheduled reminder time (UTC ms),
 * computed from the study schedule. Returns null if none is upcoming or push is
 * off. Best-effort: never throws (purely informational for the Details panel).
 */
export async function fetchNextNotification(studyId: number, userId: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `${API_ROOT}api/push_status.php?studyId=${studyId}&userId=${encodeURIComponent(userId)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!resp.ok) return null;
    const env = await resp.json();
    return env?.success ? (env.dataset?.nextNotification ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Start connecting a wearable: the server validates and returns the provider's OAuth
 * authorization URL (carrying a single-use state). The caller then navigates the
 * browser there. Mirrors the other POST endpoints.
 */
export async function startWearableConnect(args: {
  study: EsmiraStudy;
  serverVersion: number;
  userId: string;
  provider: string;
}): Promise<string> {
  const resp = await fetch(`${API_ROOT}api/wearables_connect.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: args.userId,
      studyId: args.study.id,
      serverVersion: args.serverVersion,
      provider: args.provider,
    }),
  });
  if (!resp.ok) throw new Error(`wearables_connect.php returned ${resp.status}`);
  const env = await resp.json();
  if (!env.success || !env.dataset?.authUrl) throw new Error(env.error || 'Could not start connection');
  return env.dataset.authUrl as string;
}

/**
 * Fetch the participant's connected wearables (+ last sync time). Best-effort: returns
 * an empty list and never throws (purely informational for the Settings/Details panels).
 */
export async function fetchWearableStatus(studyId: number, userId: string): Promise<WearableStatus[]> {
  try {
    const resp = await fetch(
      `${API_ROOT}api/wearables_status.php?studyId=${studyId}&userId=${encodeURIComponent(userId)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!resp.ok) return [];
    const env = await resp.json();
    return env?.success ? (env.dataset?.providers ?? []) : [];
  } catch {
    return [];
  }
}

/** Disconnect a wearable: removes the server-side token, data and sync cursor. */
export async function disconnectWearable(args: {
  study: EsmiraStudy;
  serverVersion: number;
  userId: string;
  provider: string;
}): Promise<boolean> {
  const resp = await fetch(`${API_ROOT}api/wearables_disconnect.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: args.userId,
      studyId: args.study.id,
      serverVersion: args.serverVersion,
      provider: args.provider,
    }),
  });
  if (!resp.ok) throw new Error(`wearables_disconnect.php returned ${resp.status}`);
  const env = await resp.json();
  if (!env.success) throw new Error(env.error || 'Disconnect failed');
  return true;
}

/**
 * Build the ESMira `responses` object from the engine's response map.
 * Mirrors QuestionnaireSaver value formats; expands multi_choice to `name~i`
 * booleans and drops display-only `info` items.
 */
export function buildEsmiraResponses(
  questions: PreloadedQuestion[],
  responseMap: Readonly<Record<string, string>>,
): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {};
  for (const q of questions) {
    const v = responseMap[q.id];
    if (v === undefined || q.type === 'info') continue;
    if (q.type === 'multi_choice') {
      const selected = new Set(v ? v.split(',') : []);
      (q.options ?? []).forEach((opt, i) => {
        out[`${q.id}~${i + 1}`] = selected.has(opt);
      });
    } else {
      out[q.id] = v;
    }
  }
  return out;
}

export interface SubmitArgs {
  study: EsmiraStudy;
  serverVersion: number;
  accessKey: string;
  questionnaireInternalId: number;
  questionnaireName: string;
  /** Stable backend-facing identifier (distinct from the display name). */
  userId: string;
  responses: Record<string, string | boolean | number>;
  newParticipant: boolean;
  formDuration: number;
  pageDurations: string;
}

interface DatasetEntry {
  dataSetId: number;
  studyId: number;
  studyVersion: number;
  studySubVersion: number;
  studyLang: string;
  accessKey: string;
  questionnaireName: string | null;
  questionnaireInternalId: number | null;
  eventType: 'joined' | 'questionnaire';
  responseTime: number;
  responses: Record<string, string | boolean | number>;
}

interface DatasetPayload {
  userId: string;
  appType: string;
  appVersion: string;
  serverVersion: number;
  dataset: DatasetEntry[];
}

function buildPayload(args: SubmitArgs): DatasetPayload {
  const now = Date.now();
  const model = navigator.userAgent;
  const common = {
    studyId: args.study.id,
    studyVersion: args.study.version ?? 0,
    studySubVersion: args.study.subVersion ?? 0,
    studyLang: args.study.lang ?? 'en',
    accessKey: args.accessKey,
  };
  const dataset: DatasetEntry[] = [];
  if (args.newParticipant) {
    dataset.push({
      ...common,
      dataSetId: 0,
      questionnaireName: null,
      questionnaireInternalId: null,
      eventType: 'joined',
      responseTime: now,
      responses: { model },
    });
  }
  dataset.push({
    ...common,
    dataSetId: dataset.length,
    questionnaireName: args.questionnaireName,
    questionnaireInternalId: args.questionnaireInternalId,
    eventType: 'questionnaire',
    responseTime: now,
    responses: {
      ...args.responses,
      formDuration: args.formDuration,
      pageDurations: args.pageDurations,
      model,
    },
  });
  return {
    userId: args.userId,
    appType: 'Web',
    appVersion: String(args.serverVersion),
    serverVersion: args.serverVersion,
    dataset,
  };
}

// ── Upload protocol (client-side transparency log) ───────────────
// ESMira's native apps keep a local record of every dataset sent to the
// server so participants can verify what was uploaded. We mirror that here:
// one entry per logical upload, persisted per study + user in localStorage.

const PROTOCOL_KEY_PREFIX = 'esmira_upload_protocol_';
const PROTOCOL_MAX = 200; // keep the log bounded

export interface UploadProtocolEntry {
  /** Stable id, used to flip a queued entry's status once it actually sends. */
  id: string;
  /** Upload time (epoch ms). */
  time: number;
  /** Survey name, or a label for non-questionnaire uploads. */
  label: string;
  eventType: 'joined' | 'questionnaire' | 'cognitive';
  /** 'sent' once the server accepted it; 'pending' while queued offline. */
  status: 'sent' | 'pending';
}

let protocolSeq = 0;
function newProtocolId(): string {
  protocolSeq += 1;
  return `${Date.now()}-${protocolSeq}`;
}

function protocolKey(studyId: number, userId: string): string {
  return `${PROTOCOL_KEY_PREFIX}${studyId}_${userId}`;
}

function loadRawProtocol(studyId: number, userId: string): UploadProtocolEntry[] {
  try {
    const raw = localStorage.getItem(protocolKey(studyId, userId));
    return raw ? (JSON.parse(raw) as UploadProtocolEntry[]) : [];
  } catch {
    return [];
  }
}

function saveProtocol(studyId: number, userId: string, list: UploadProtocolEntry[]): void {
  try {
    localStorage.setItem(protocolKey(studyId, userId), JSON.stringify(list.slice(-PROTOCOL_MAX)));
  } catch {
    /* storage full/unavailable */
  }
}

/** Read the upload protocol for a study + user, newest first. */
export function loadUploadProtocol(studyId: number, userId: string): UploadProtocolEntry[] {
  return loadRawProtocol(studyId, userId).sort((a, b) => b.time - a.time);
}

function appendProtocol(studyId: number, userId: string, entries: UploadProtocolEntry[]): void {
  if (!entries.length) return;
  const list = loadRawProtocol(studyId, userId);
  list.push(...entries);
  saveProtocol(studyId, userId, list);
}

function markProtocolSent(studyId: number, userId: string, ids: string[]): void {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const list = loadRawProtocol(studyId, userId);
  let changed = false;
  for (const e of list) {
    if (wanted.has(e.id) && e.status !== 'sent') {
      e.status = 'sent';
      changed = true;
    }
  }
  if (changed) saveProtocol(studyId, userId, list);
}

function questionnaireProtocolEntries(args: SubmitArgs, status: UploadProtocolEntry['status']): UploadProtocolEntry[] {
  const time = Date.now();
  const entries: UploadProtocolEntry[] = [];
  if (args.newParticipant) {
    entries.push({ id: newProtocolId(), time, label: 'Joined study', eventType: 'joined', status });
  }
  entries.push({ id: newProtocolId(), time, label: args.questionnaireName, eventType: 'questionnaire', status });
  return entries;
}

// ── Submission with offline retry queue ─────────────────────────

const QUEUE_KEY = 'esmira_submit_queue';

interface QueuedSubmit {
  payload: DatasetPayload;
  attempts: number;
  /** Links this queued payload back to its pending upload-protocol entries. */
  protocol?: { studyId: number; userId: string; ids: string[] };
}

function loadQueue(): QueuedSubmit[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: QueuedSubmit[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* storage full/unavailable */
  }
}

async function postDataset(payload: DatasetPayload): Promise<void> {
  const resp = await fetch(`${API_ROOT}api/datasets.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`datasets.php returned ${resp.status}`);
  const env = await resp.json();
  if (!env.success) throw new Error(env.error || 'Submission rejected');
}

/**
 * Submit a completed questionnaire. On network failure the payload is queued in
 * localStorage and retried on reconnect/visibility. Returns true if the server
 * accepted it now, false if it was queued for later.
 */
export async function submitQuestionnaire(args: SubmitArgs): Promise<boolean> {
  const payload = buildPayload(args);
  try {
    await postDataset(payload);
    appendProtocol(args.study.id, args.userId, questionnaireProtocolEntries(args, 'sent'));
    return true;
  } catch {
    const entries = questionnaireProtocolEntries(args, 'pending');
    appendProtocol(args.study.id, args.userId, entries);
    const queue = loadQueue();
    queue.push({
      payload,
      attempts: 1,
      protocol: { studyId: args.study.id, userId: args.userId, ids: entries.map((e) => e.id) },
    });
    saveQueue(queue);
    return false;
  }
}

/**
 * Send a free-text message from the participant to the research team via the
 * existing public `api/save_message.php` (the same endpoint native apps use).
 * The message is stored against the participant's study userId, so the
 * researcher can link it to that participant's data — no real name or contact
 * details are attached. Returns true on success; throws on a network or
 * validation failure so the caller can surface a retry.
 */
export async function sendParticipantMessage(args: {
  study: EsmiraStudy;
  serverVersion: number;
  userId: string;
  content: string;
}): Promise<boolean> {
  const resp = await fetch(`${API_ROOT}api/save_message.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: args.userId,
      studyId: args.study.id,
      content: args.content,
      serverVersion: args.serverVersion,
    }),
  });
  if (!resp.ok) throw new Error(`save_message.php returned ${resp.status}`);
  const env = await resp.json();
  if (!env.success) throw new Error(env.error || 'Message rejected');
  return true;
}

export interface CognitiveTrialsArgs {
  study: EsmiraStudy;
  serverVersion: number;
  accessKey: string;
  /** Stable backend-facing identifier (distinct from the display name). */
  userId: string;
  trialsInternalId: number;
  trialsName: string;
  rows: Record<string, string | number>[];
}

/**
 * Write one row per cognitive trial to the dedicated "Cognitive Trials"
 * questionnaire (long/tabular format) via the existing datasets.php. Uses the
 * same offline queue on failure.
 */
export async function submitCognitiveTrials(args: CognitiveTrialsArgs): Promise<boolean> {
  if (!args.rows.length) return true;
  const now = Date.now();
  const model = navigator.userAgent;
  const common = {
    studyId: args.study.id,
    studyVersion: args.study.version ?? 0,
    studySubVersion: args.study.subVersion ?? 0,
    studyLang: args.study.lang ?? 'en',
    accessKey: args.accessKey,
  };
  const payload: DatasetPayload = {
    userId: args.userId,
    appType: 'Web',
    appVersion: String(args.serverVersion),
    serverVersion: args.serverVersion,
    dataset: args.rows.map((r, i) => ({
      ...common,
      dataSetId: i,
      questionnaireName: args.trialsName,
      questionnaireInternalId: args.trialsInternalId,
      eventType: 'questionnaire' as const,
      responseTime: now + i,
      responses: { ...r, model },
    })),
  };
  const entry: UploadProtocolEntry = {
    id: newProtocolId(), time: now, label: args.trialsName, eventType: 'cognitive', status: 'sent',
  };
  try {
    await postDataset(payload);
    appendProtocol(args.study.id, args.userId, [entry]);
    return true;
  } catch {
    appendProtocol(args.study.id, args.userId, [{ ...entry, status: 'pending' }]);
    const queue = loadQueue();
    queue.push({
      payload,
      attempts: 1,
      protocol: { studyId: args.study.id, userId: args.userId, ids: [entry.id] },
    });
    saveQueue(queue);
    return false;
  }
}

/** Retry any queued submissions. */
export async function flushSubmitQueue(): Promise<void> {
  let queue = loadQueue();
  if (queue.length === 0) return;
  const remaining: QueuedSubmit[] = [];
  for (const item of queue) {
    if (item.attempts >= 20) continue; // give up after many tries
    try {
      await postDataset(item.payload);
      if (item.protocol) markProtocolSent(item.protocol.studyId, item.protocol.userId, item.protocol.ids);
    } catch {
      remaining.push({ ...item, attempts: item.attempts + 1 });
    }
  }
  queue = remaining;
  saveQueue(queue);
}

export function pendingSubmitCount(): number {
  return loadQueue().length;
}

// ── Client error log (powers "Send error report") ───────────────
// Capture uncaught errors / promise rejections into a small capped ring buffer
// in localStorage so a participant can forward them to the research team — the
// web equivalent of the native app's "Forward error report".

const ERROR_LOG_KEY = 'esmira_error_log';
const ERROR_LOG_MAX = 30;

export interface ClientErrorEntry {
  time: number;
  message: string;
}

/** Read the captured client error log, oldest first. */
export function loadErrorLog(): ClientErrorEntry[] {
  try {
    const raw = localStorage.getItem(ERROR_LOG_KEY);
    return raw ? (JSON.parse(raw) as ClientErrorEntry[]) : [];
  } catch {
    return [];
  }
}

function pushErrorLog(message: string): void {
  try {
    const list = loadErrorLog();
    list.push({ time: Date.now(), message: message.slice(0, 500) });
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(list.slice(-ERROR_LOG_MAX)));
  } catch {
    /* storage full/unavailable */
  }
}

/** Clear the captured client error log (e.g. after a report is sent). */
export function clearErrorLog(): void {
  try {
    localStorage.removeItem(ERROR_LOG_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Capture uncaught errors and unhandled rejections into the local log.
 *  Returns an uninstaller (so it cleans up cleanly under StrictMode remounts). */
export function installErrorLogger(): () => void {
  const onError = (e: ErrorEvent) => {
    pushErrorLog(`${e.message}${e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : ''}`);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason;
    pushErrorLog(`Unhandled rejection: ${r instanceof Error ? `${r.message}` : String(r)}`);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Wire up automatic flushing on reconnect / tab visibility. */
export function installSubmitQueueFlusher(): () => void {
  const onOnline = () => void flushSubmitQueue();
  const onVisible = () => {
    if (document.visibilityState === 'visible') void flushSubmitQueue();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  void flushSubmitQueue();
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
