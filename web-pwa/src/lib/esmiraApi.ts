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

import type { EsmiraStudy, PreloadedQuestion, StudiesEnvelope } from '../types';

/** API root derived from the served base path ('/esmira/pwa/' -> '/esmira/'). */
const API_ROOT = (import.meta.env.BASE_URL || '/').replace(/pwa\/?$/, '');

export interface FetchedStudy {
  study: EsmiraStudy;
  serverVersion: number;
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
  return { study, serverVersion: env.serverVersion };
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
  participant: string;
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

function buildPayload(args: SubmitArgs) {
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
    userId: args.participant,
    appType: 'Web',
    appVersion: String(args.serverVersion),
    serverVersion: args.serverVersion,
    dataset,
  };
}

// ── Submission with offline retry queue ─────────────────────────

const QUEUE_KEY = 'esmira_submit_queue';

interface QueuedSubmit {
  payload: ReturnType<typeof buildPayload>;
  attempts: number;
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

async function postDataset(payload: ReturnType<typeof buildPayload>): Promise<void> {
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
    return true;
  } catch {
    const queue = loadQueue();
    queue.push({ payload, attempts: 1 });
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
