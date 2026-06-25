/**
 * ESMira participant PWA — a chat-style survey experience modelled on the
 * iEMAbot PWA, served by ESMira's PHP backend. Pull-driven: the participant
 * opens /esmira/pwa/?key=ACCESSKEY and the "conversation" plays out locally.
 *
 * Flow: load study -> (consent) -> participant name -> questionnaire list ->
 * chat-style survey (one question per bubble, engine-driven) -> submit to
 * api/datasets.php -> thank-you -> back to list.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Settings, ClipboardList, Info, X, Grid, SkipForward, PlayCircle,
  Sun, Moon, Contrast, Type, Send, ChevronRight, ChevronLeft, CheckCircle, RotateCcw, LogOut,
  FileText, ShieldCheck, Bell, MessageSquare, UploadCloud, Clock, RefreshCw,
} from 'lucide-react';
import { cn } from './lib/utils';
import { OfflineSurveyEngine } from './lib/surveyEngine';
import { adaptQuestionnaire } from './lib/esmiraAdapter';
import {
  buildEsmiraResponses, fetchStudy, installSubmitQueueFlusher, submitQuestionnaire,
  submitCognitiveTrials, serverRootUrl, sendParticipantMessage, loadUploadProtocol,
  flushSubmitQueue,
} from './lib/esmiraApi';
import type { UploadProtocolEntry } from './lib/esmiraApi';
import type { EsmiraStudy, EsmiraQuestionnaire, PreloadedQuestion } from './types';
import { SurveyInputs } from './components/SurveyInputs';

type Phase = 'loading' | 'error' | 'consent' | 'name' | 'list' | 'survey' | 'tutorial';
type TextSize = 'normal' | 'large' | 'xlarge' | 'xxlarge';

interface ChatMsg {
  id: string;
  sender: 'bot' | 'user';
  kind: 'text' | 'section';
  content: string;
  html?: boolean;
  /** Question id this message belongs to (set on settled Q&A pairs). */
  qid?: string;
}

interface M2c2Complete {
  type: string;
  assessment?: string;
  summary?: { n_trials?: number; duration_s?: number | null; correct_count?: number | null };
  data?: unknown;
}

const TEXT_SIZE_CLASS: Record<TextSize, string> = {
  normal: 'text-[15px]',
  large: 'text-lg',
  xlarge: 'text-xl',
  xxlarge: 'text-2xl',
};

const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  normal: 'Normal',
  large: 'Large',
  xlarge: 'X-Large',
  xxlarge: 'XX-Large',
};

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Human-readable echo of a participant's answer for the user bubble. */
function formatAnswer(q: PreloadedQuestion, value: string): string {
  if (q.type === 'yesno') {
    if (value === q.yes_value) return q.yes_label || 'Yes';
    if (value === q.no_value) return q.no_label || 'No';
  }
  if (q.type === 'multi_choice') return value ? value.split(',').join(', ') : '(none)';
  if (q.type === 'duration') {
    // Stored value is total minutes (ESMira `duration` format); show it human-readably.
    const total = Number(value);
    if (Number.isFinite(total)) {
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
    }
  }
  return value;
}

let msgSeq = 0;
const mkId = () => `m${++msgSeq}`;

/**
 * Resolve a stable per-study user id — the identifier sent to the backend,
 * kept distinct from the participant's display name. Priority:
 *   1. a `uid` (alias `user_id` / `userId`) URL param — for personalised invite links
 *   2. an id already stored for this study (constant across visits)
 *   3. a freshly generated random id
 * The resolved id is persisted immediately so it survives reloads.
 */
function resolveUserId(studyId: number, params: URLSearchParams): string {
  const storeKey = `esmira_userid_${studyId}`;
  const fromUrl = (params.get('uid') ?? params.get('user_id') ?? params.get('userId') ?? '').trim();
  if (fromUrl) {
    localStorage.setItem(storeKey, fromUrl);
    return fromUrl;
  }
  const stored = localStorage.getItem(storeKey);
  if (stored) return stored;
  const generated = generateUserId();
  localStorage.setItem(storeKey, generated);
  return generated;
}

/** A URL/filesystem-safe random user id (the backend maps userId onto a path). */
function generateUserId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Hidden questionnaire used as the tabular sink for cognitive trial rows.
const TRIALS_QN_TITLE = 'Cognitive Trials';

/** localStorage flag marking that this device has already seen the study's tutorial
 *  overview (so it only auto-shows on the participant's first visit). */
const tutorialSeenKey = (studyId: number) => `esmira_tutorial_seen_${studyId}`;

/** Rough size hint for a questionnaire's tutorial card: counts answerable inputs
 *  (display-only info/image items aren't questions). */
function countQuestions(q: EsmiraQuestionnaire): number {
  return q.pages.reduce(
    (n, p) => n + p.inputs.filter((i) => i.responseType !== 'text' && i.responseType !== 'image').length,
    0,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function pickNum(o: any, keys: string[]): number | '' {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(+v)) return +v;
  }
  return '';
}
function pickStr(o: any, keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null) return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return '';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const accessKey = params.get('key') ?? params.get('access_key') ?? '';
  const studyIdParam = params.get('id') ? Number(params.get('id')) : undefined;
  // `?tutorial=1` forces the tutorial (and `?tutorial=0` suppresses it) regardless of
  // the study flag — a test hook and a manual "tutorial link" researchers can share.
  const tutorialParam = params.get('tutorial');

  const [phase, setPhase] = useState<Phase>('loading');
  const [study, setStudy] = useState<EsmiraStudy | null>(null);
  const [serverVersion, setServerVersion] = useState(11);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [participant, setParticipant] = useState(''); // display name (username)
  const [userId, setUserId] = useState('');           // stable backend identifier
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [footerValue, setFooterValue] = useState('');

  const engineRef = useRef<OfflineSurveyEngine | null>(null);
  const initedRef = useRef(false);
  const surveyStartRef = useRef(0);
  const activeQRef = useRef<{ id: number; name: string } | null>(null);
  // True while a no-submit tutorial practice run is in progress (gates all network writes).
  const practiceRef = useRef(false);
  const [currentQuestion, setCurrentQuestion] = useState<PreloadedQuestion | null>(null);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Accessibility (client-only)
  const [dark, setDark] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [textSize, setTextSize] = useState<TextSize>('normal');
  const textSizeClass = TEXT_SIZE_CLASS[textSize];

  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutView, setAboutView] = useState<'main' | 'description' | 'consent' | 'protocol'>('main');
  // Bumped by the Upload protocol "Refresh" button to force a re-read of the log.
  const [protocolTick, setProtocolTick] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactText, setContactText] = useState('');
  const [contactStatus, setContactStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [webview, setWebview] = useState<{ url: string; title: string; qid?: string } | null>(null);
  const webviewRef = useRef<{ url: string; title: string; qid?: string } | null>(null);
  webviewRef.current = webview;

  const scrollRef = useRef<HTMLElement | null>(null);

  // NB: compute the id OUTSIDE the updater so the updater stays pure (React
  // StrictMode double-invokes updaters, which would otherwise dupe ids/keys).
  const pushBot = useCallback((content: string, html = false, qid?: string) => {
    const id = mkId();
    setMessages((prev) => [...prev, { id, sender: 'bot', kind: 'text', content, html, qid }]);
  }, []);
  const pushUser = useCallback((content: string, qid?: string) => {
    const id = mkId();
    setMessages((prev) => [...prev, { id, sender: 'user', kind: 'text', content, qid }]);
  }, []);
  const pushSection = useCallback((content: string) => {
    const id = mkId();
    setMessages((prev) => [...prev, { id, sender: 'bot', kind: 'section', content }]);
  }, []);

  // ── Tutorial-mode helpers ────────────────────────────────────
  const shouldShowTutorial = useCallback((s: EsmiraStudy): boolean => {
    if (tutorialParam === '0') return false;
    if (tutorialParam === '1') return true;
    return !!s.enableTutorialMode && !localStorage.getItem(tutorialSeenKey(s.id));
  }, [tutorialParam]);

  const pushTutorialIntro = useCallback((s: EsmiraStudy) => {
    pushBot("Here's a quick tutorial. Below is every questionnaire this study uses — you can try a practice run of any of them (nothing you enter is saved). When you're ready, continue to the study.");
    if (s.postInstallInstructions) pushBot(s.postInstallInstructions);
  }, [pushBot]);

  // First screen after consent/name: the tutorial (first visit, if enabled) or the live list.
  const enterStudy = useCallback((s: EsmiraStudy) => {
    if (shouldShowTutorial(s)) {
      pushTutorialIntro(s);
      setPhase('tutorial');
    } else {
      setPhase('list');
    }
  }, [shouldShowTutorial, pushTutorialIntro]);

  const finishTutorial = useCallback(() => {
    if (study) localStorage.setItem(tutorialSeenKey(study.id), '1');
    pushBot("Great — you're all set. Choose a questionnaire to begin.");
    setPhase('list');
  }, [study, pushBot]);

  // ── Retry queue flusher (re-installs cleanly on remount) ─────
  useEffect(() => installSubmitQueueFlusher(), []);

  // ── Load study once (guarded against StrictMode double-mount) ─
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    if (!accessKey) {
      setLoadError('No study access key in the URL. Expected ?key=YOUR_KEY');
      setPhase('error');
      return;
    }
    fetchStudy(accessKey, studyIdParam)
      .then(({ study, serverVersion }) => {
        setStudy(study);
        setServerVersion(serverVersion);
        // Assign/restore the stable user id (invite-link param > stored > random).
        setUserId(resolveUserId(study.id, params));
        const savedName = localStorage.getItem(`esmira_participant_${study.id}`) || '';
        setParticipant(savedName);
        pushBot(`Welcome to ${study.title}.`);
        if (study.studyDescription) pushBot(study.studyDescription);
        const consented = localStorage.getItem(`esmira_consent_${study.id}`) === '1';
        if (study.informedConsentForm && !consented) {
          pushBot(study.informedConsentForm);
          setPhase('consent');
        } else if (!savedName) {
          pushBot('Before we begin — what name would you like to go by? (Just for display; your study id is assigned automatically.)');
          setPhase('name');
        } else if (shouldShowTutorial(study)) {
          pushTutorialIntro(study);
          setPhase('tutorial');
        } else {
          pushBot(`Welcome back, ${savedName}!`);
          setPhase('list');
        }
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : 'Could not load the study');
        setPhase('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll to bottom ────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [messages, currentQuestion, phase, reduceMotion]);

  // ── Consent ──────────────────────────────────────────────────
  const onConsent = (agree: boolean) => {
    if (!study) return;
    if (!agree) {
      pushUser('I do not consent');
      pushBot('No problem — you can close this page. Thank you for your time.');
      setPhase('loading'); // no further actions
      return;
    }
    pushUser('I consent');
    localStorage.setItem(`esmira_consent_${study.id}`, '1');
    const savedName = localStorage.getItem(`esmira_participant_${study.id}`) || '';
    if (!savedName) {
      pushBot('Thank you. What name would you like to go by?');
      setPhase('name');
    } else {
      enterStudy(study);
    }
  };

  // ── Sign out: clear this study's saved identity/consent, restart ──
  const signOut = () => {
    if (!window.confirm("Sign out? You'll need to enter your name again to continue the study.")) return;
    if (study) {
      localStorage.removeItem(`esmira_participant_${study.id}`);
      localStorage.removeItem(`esmira_consent_${study.id}`);
      // Drop the assigned id too — a fresh visitor gets a new one (an invite-link
      // `uid` re-resolves to the same id on reload, which is the intended behaviour).
      localStorage.removeItem(`esmira_userid_${study.id}`);
    }
    window.location.reload();
  };

  // ── Contact: send an anonymous message to the research team ──
  const openContact = () => {
    setContactText('');
    setContactStatus('idle');
    setContactOpen(true);
  };
  const sendContact = async () => {
    const text = contactText.trim();
    if (!study || text.length < 2 || contactStatus === 'sending') return;
    setContactStatus('sending');
    try {
      await sendParticipantMessage({ study, serverVersion, userId, content: text });
      setContactText('');
      setContactStatus('sent');
    } catch {
      setContactStatus('error');
    }
  };

  // ── Footer submit (name entry or text-question answer) ───────
  const onFooterSend = () => {
    const value = footerValue.trim();
    if (!value) return;
    if (phase === 'name' && study) {
      setParticipant(value);
      localStorage.setItem(`esmira_participant_${study.id}`, value);
      pushUser(value);
      setFooterValue('');
      if (shouldShowTutorial(study)) {
        pushBot(`Thanks, ${value}!`);
        pushTutorialIntro(study);
        setPhase('tutorial');
      } else {
        pushBot(`Thanks, ${value}! Which questionnaire would you like to complete?`);
        setPhase('list');
      }
      return;
    }
    if (phase === 'survey' && currentQuestion?.type === 'text') {
      setFooterValue('');
      handleRespond(currentQuestion.id, value);
    }
  };

  // ── Start a questionnaire ────────────────────────────────────
  const startQuestionnaire = (internalId: number, practice = false) => {
    if (!study) return;
    const q = study.questionnaires.find((x) => x.internalId === internalId);
    if (!q) return;
    practiceRef.current = practice;
    const session = adaptQuestionnaire(study.id, q, Date.now());
    const engine = new OfflineSurveyEngine(session);
    engineRef.current = engine;
    activeQRef.current = { id: q.internalId, name: q.title };
    surveyStartRef.current = Date.now();
    pushUser(q.title);
    if (practice) pushSection('Practice run — nothing you enter is saved');
    setPhase('survey');
    const transition = engine.getSectionTransition();
    if (transition?.description) pushSection(transition.description);
    setCurrentQuestion(engine.getCurrentQuestion());
    setProgress(engine.getProgress());
  };

  // ── Respond to current question ──────────────────────────────
  const handleRespond = (questionId: string, value: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const q = engine.session.questions.find((x) => x.id === questionId);
    if (q) {
      // Settle the question into the thread as a bot bubble, then the answer.
      // Tag both with the question id so "Change response" can rewind/remove them.
      pushBot(q.text, false, questionId);
      pushUser(formatAnswer(q, value), questionId);
    }
    const next = engine.respond(questionId, value);
    afterAdvance(next);
  };

  // ── Change the most recent answer (rewind engine, re-ask it) ──
  const onChangeResponse = (qid: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const rewound = engine.rewindTo(qid);
    if (!rewound) return;
    setMessages((prev) => prev.filter((m) => m.qid !== qid));
    setCurrentQuestion(rewound);
    setProgress(engine.getProgress());
  };

  // Settle a question into the thread when it's skipped or continued past.
  // Cognitive link-out items hold raw HTML in `text` (rendered live as a launch
  // card via title/description, never as text), so settling that text as a plain
  // bubble would dump the markup. Settle them by their clean title instead —
  // matching how a *completed* cognitive task is settled.
  const settleQuestionIntoThread = (q: PreloadedQuestion, qid?: string) => {
    if (q.type === 'cognitive') pushBot(q.title || 'Cognitive task', false, qid);
    else pushBot(q.text, !!q.is_html, qid);
  };

  const handleContinueInfo = () => {
    const engine = engineRef.current;
    if (!engine) return;
    // Settle the info/link-out content into the thread (keeps the link clickable).
    if (currentQuestion) settleQuestionIntoThread(currentQuestion);
    const next = engine.skip();
    afterAdvance(next);
  };

  const afterAdvance = (next: PreloadedQuestion | null) => {
    const engine = engineRef.current;
    if (!engine) return;
    setProgress(engine.getProgress());
    if (next) {
      const transition = engine.getSectionTransition();
      if (transition?.description) pushSection(transition.description);
      setCurrentQuestion(next);
    } else {
      setCurrentQuestion(null);
      void finishSurvey();
    }
  };

  const handleSkip = () => {
    const engine = engineRef.current;
    if (!engine || phase !== 'survey' || !currentQuestion) return;
    // Settle the skipped question into the thread, then record an explicit
    // "Skipped" response. Both bubbles are tagged with the question id so the
    // "Change response" affordance can rewind and re-ask it.
    const qid = currentQuestion.id;
    settleQuestionIntoThread(currentQuestion, qid);
    pushUser('Skipped', qid);
    const next = engine.skip();
    afterAdvance(next);
  };

  // ── Finish & submit ──────────────────────────────────────────
  const finishSurvey = async () => {
    const engine = engineRef.current;
    const active = activeQRef.current;
    if (!engine || !study || !active) return;
    // Tutorial practice run: render is identical to a live beep, but nothing is
    // sent and no join/completion state is recorded. Return to the tutorial.
    if (practiceRef.current) {
      pushBot("✅ Practice complete — that's exactly what a real questionnaire looks like. Nothing was saved.");
      engineRef.current = null;
      activeQRef.current = null;
      practiceRef.current = false;
      setPhase('tutorial');
      return;
    }
    setSubmitting(true);
    const responses = buildEsmiraResponses(engine.session.questions, engine.getResponseMap());
    const joinedKey = `esmira_joined_${study.id}_${userId}`;
    const newParticipant = !localStorage.getItem(joinedKey);
    const submittedAt = Date.now();
    const ok = await submitQuestionnaire({
      study,
      serverVersion,
      accessKey,
      questionnaireInternalId: active.id,
      questionnaireName: active.name,
      userId,
      responses,
      newParticipant,
      formDuration: Date.now() - surveyStartRef.current,
      pageDurations: '',
    });
    // Record the join time (epoch ms) on first submission; bump the count of
    // completed questionnaires. Both surface in the About / Study information panel.
    if (newParticipant) localStorage.setItem(joinedKey, String(submittedAt));
    const completedKey = `esmira_completed_${study.id}_${userId}`;
    localStorage.setItem(completedKey, String(Number(localStorage.getItem(completedKey) || '0') + 1));
    setSubmitting(false);
    pushBot(ok
      ? '✅ Thank you — your responses have been recorded.'
      : '📥 You appear to be offline. Your responses are saved and will be sent automatically when you reconnect.');
    engineRef.current = null;
    activeQRef.current = null;
    const visibleCount = study.questionnaires.filter((q) => q.title !== TRIALS_QN_TITLE).length;
    if (visibleCount > 1) {
      pushBot('Would you like to complete another questionnaire?');
    }
    setPhase('list');
  };

  // ── Cognitive task result (posted by the m2c2 iframe in embed mode) ──
  // Reassigned each render so the listener always sees current closures.
  const cogCompleteRef = useRef<(qid: string, payload: M2c2Complete) => void>(() => {});
  cogCompleteRef.current = (qid, payload) => {
    const engine = engineRef.current;
    if (!engine) return;
    const q = engine.session.questions.find((x) => x.id === qid);
    const s = payload.summary || {};
    const session = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `s${Date.now()}`;
    if (q) {
      pushBot(q.title || 'Cognitive task', false, qid);
      // Participant sees only a neutral confirmation — no performance feedback.
      // The full summary (trials, duration, correctness) is still stored below.
      pushUser('✓ Completed', qid);
    }
    // Store a compact summary (incl. the session id, to join the trial rows) in
    // the cognitive item's own column.
    const next = engine.respond(qid, JSON.stringify({ session, ...s }));
    setWebview(null);
    afterAdvance(next);

    // Write the tabular trial rows to the hidden "Cognitive Trials" questionnaire.
    const data = payload.data as { trials?: unknown[] } | undefined;
    const trials = Array.isArray(data?.trials) ? data!.trials : [];
    const trialsQn = study?.questionnaires.find((x) => x.title === TRIALS_QN_TITLE);
    const active = activeQRef.current;
    if (!practiceRef.current && study && trialsQn && active && trials.length) {
      const rows = trials.map((t, i) => ({
        cogAssessment: payload.assessment ?? '',
        cogSource: active.name,
        cogInputName: qid,
        cogSession: session,
        cogTrialIndex: i,
        cogRt: pickNum(t, ['response_time_ms', 'rt', 'reaction_time_ms', 'elapsed_test_time_ms']),
        cogCorrect: pickStr(t, ['is_correct', 'correct']),
        cogResponse: pickStr(t, ['response', 'user_response', 'selected', 'tapped']),
        cogStimulus: pickStr(t, ['stimulus', 'condition', 'trial_type']),
        cogRaw: JSON.stringify(t),
      }));
      void submitCognitiveTrials({
        study, serverVersion, accessKey, userId,
        trialsInternalId: trialsQn.internalId, trialsName: trialsQn.title, rows,
      });
    }
  };

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const wv = webviewRef.current;
      if (!wv) return;
      let origin: string;
      try { origin = new URL(wv.url, window.location.href).origin; } catch { return; }
      if (e.origin !== origin) return;
      const d = e.data as M2c2Complete | undefined;
      if (d && d.type === 'm2c2:complete' && wv.qid) cogCompleteRef.current(wv.qid, d);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Derived state ────────────────────────────────────────────
  // The most recently answered question shows a "Change response" pill (t-1).
  const lastAnswerId = useMemo(() => {
    let id: string | undefined;
    for (const m of messages) if (m.sender === 'user' && m.qid) id = m.id;
    return id;
  }, [messages]);
  const footerActive = phase === 'name' || (phase === 'survey' && currentQuestion?.type === 'text');
  const footerPlaceholder = phase === 'name' ? 'Enter your name' : 'Type your response…';

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className={cn(
      'flex flex-col h-screen bg-surface overflow-hidden transition-colors duration-300',
      dark && 'dark', highContrast && 'high-contrast',
    )}>
      {/* Header */}
      <header aria-label={study?.title ?? 'ESMira Study'} className="fixed top-0 w-full z-50 bg-[#075E54] dark:bg-surface-container-lowest text-white dark:text-on-surface shadow-md flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <ClipboardList size={20} aria-hidden="true" />
          </div>
          <div className="flex flex-col min-w-0">
            <h1 className="text-base font-bold leading-none truncate">{study?.title ?? 'ESMira Study'}</h1>
            <span className="text-[10px] opacity-80 uppercase tracking-widest font-semibold truncate">
              {participant ? participant : 'Survey'}
            </span>
          </div>
        </div>
      </header>

      {/* Chat area */}
      <main ref={scrollRef} role="log" aria-label="Survey conversation" aria-live="polite" className="flex-1 mt-16 mb-20 chat-wallpaper overflow-y-auto px-4 py-6 flex flex-col gap-4 no-scrollbar">
        <div className="flex justify-center my-2">
          <span className="bg-slate-700 dark:bg-surface-container-highest text-white dark:text-on-surface px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm">Today</span>
        </div>

        <AnimatePresence initial={false}>
          {messages.map((msg) => msg.kind === 'section' ? (
            <motion.div key={msg.id}
              initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.3 }} className="flex justify-center my-1">
              <span className="bg-secondary-container text-on-secondary-container px-4 py-1.5 rounded-full text-xs font-bold shadow-sm">{msg.content}</span>
            </motion.div>
          ) : (
            <motion.div key={msg.id}
              initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.3 }}
              className={cn('flex flex-col max-w-[85%]', msg.sender === 'user' ? 'self-end items-end' : 'self-start items-start')}>
              <div className={cn('px-4 py-3 rounded-2xl message-shadow relative',
                msg.sender === 'user' ? 'bg-primary text-on-primary rounded-tr-none'
                  : 'bg-white dark:bg-surface-container-lowest text-on-surface rounded-tl-none border border-slate-200 dark:border-outline-variant/30')}>
                {msg.html
                  ? <div className={cn('leading-relaxed font-medium esmira-rich', textSizeClass)} dangerouslySetInnerHTML={{ __html: msg.content }} />
                  : <p className={cn('leading-relaxed font-medium whitespace-pre-wrap', textSizeClass)}>{msg.content}</p>}
                <div className="flex justify-end items-center gap-1 mt-1">
                  <span className={cn('text-[10px] font-bold', msg.sender === 'user' ? 'text-on-primary opacity-70' : 'text-slate-500 dark:text-on-surface-variant')}>{nowTime()}</span>
                  {msg.sender === 'user' && <CheckCircle size={12} className="text-on-primary opacity-70" aria-hidden="true" />}
                </div>
              </div>
              {phase === 'survey' && msg.qid && msg.id === lastAnswerId && (
                <button
                  onClick={() => onChangeResponse(msg.qid!)}
                  className="mt-1 px-3 py-1.5 bg-surface-container-high dark:bg-surface-container-highest text-on-surface-variant rounded-full text-xs font-semibold flex items-center gap-1.5 hover:bg-surface-container-highest transition-colors active:scale-95"
                >
                  <RotateCcw size={12} aria-hidden="true" /> Change response
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Error */}
        {phase === 'error' && (
          <div className="self-center max-w-[85%] bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 px-4 py-3 rounded-xl text-sm font-medium border border-red-200 dark:border-red-500/30">
            {loadError}
          </div>
        )}

        {/* Loading */}
        {phase === 'loading' && messages.length === 0 && (
          <div className="self-center text-on-surface-variant text-sm">Loading study…</div>
        )}

        {/* Consent actions */}
        {phase === 'consent' && (
          <div className="self-start w-[85%] flex gap-3">
            <button onClick={() => onConsent(true)} className="flex-1 bg-primary text-on-primary font-bold py-3 rounded-full active:scale-95 hover:brightness-110 transition-all">I consent</button>
            <button onClick={() => onConsent(false)} className="flex-1 bg-surface-container-high text-on-surface font-bold py-3 rounded-full active:scale-95 transition-all">I do not consent</button>
          </div>
        )}

        {/* Questionnaire list */}
        {phase === 'list' && study && (
          <div className="self-start w-[85%] flex flex-col gap-2">
            {study.questionnaires.filter((q) => q.title !== TRIALS_QN_TITLE).map((q) => (
              <button key={q.internalId} onClick={() => startQuestionnaire(q.internalId)}
                className="w-full flex items-center justify-between px-4 py-3 bg-white dark:bg-surface-container-lowest border border-slate-200 dark:border-outline-variant/30 hover:bg-surface-container-high rounded-xl transition-colors text-left shadow-sm message-shadow">
                <span className={cn('font-semibold', textSizeClass)}>{q.title}</span>
                <ChevronRight size={18} className="text-outline-variant" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {/* Tutorial overview — first-visit orientation with optional practice runs */}
        {phase === 'tutorial' && study && (
          <div className="self-start w-[85%] flex flex-col gap-2">
            {study.questionnaires.filter((q) => q.title !== TRIALS_QN_TITLE).map((q) => {
              const n = countQuestions(q);
              return (
                <div key={q.internalId}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-surface-container-lowest border border-slate-200 dark:border-outline-variant/30 rounded-xl shadow-sm message-shadow">
                  <div className="min-w-0">
                    <p className={cn('font-semibold', textSizeClass)}>{q.title}</p>
                    <p className="text-xs text-on-surface-variant mt-0.5">{n} {n === 1 ? 'question' : 'questions'}</p>
                  </div>
                  <button onClick={() => startQuestionnaire(q.internalId, true)}
                    aria-label={`Try a practice run of ${q.title}`}
                    className="shrink-0 inline-flex items-center gap-1.5 bg-secondary-container text-on-secondary-container font-semibold text-sm px-3 py-2 rounded-full active:scale-95 hover:brightness-95 transition-all">
                    <PlayCircle size={16} aria-hidden="true" /> Practice
                  </button>
                </div>
              );
            })}
            <button onClick={finishTutorial}
              className="mt-2 w-full bg-primary text-on-primary font-bold py-3 rounded-full active:scale-95 hover:brightness-110 transition-all">
              I'm ready — continue
            </button>
            <button onClick={finishTutorial}
              className="w-full text-on-surface-variant font-semibold py-2 rounded-full text-sm active:scale-95 transition-colors">
              Skip tutorial
            </button>
          </div>
        )}

        {/* Active survey question */}
        {phase === 'survey' && currentQuestion && (
          <SurveyInputs
            question={currentQuestion}
            progress={progress}
            textSizeClass={textSizeClass}
            reduceMotion={reduceMotion}
            onRespond={handleRespond}
            onContinueInfo={handleContinueInfo}
            onOpenWebview={(url, title) => setWebview({ url, title, qid: currentQuestion?.id })}
          />
        )}

        {submitting && <div className="self-center text-on-surface-variant text-sm">Saving…</div>}
      </main>

      {/* Footer */}
      <footer aria-label="Message input" className="fixed bottom-0 left-0 right-0 z-50 bg-white/85 dark:bg-surface-container-lowest/85 backdrop-blur-md rounded-t-2xl shadow-[0_-4px_12px_rgba(0,0,0,0.05)] px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Quick-actions grid menu */}
          <div className="relative shrink-0">
            <button
              onClick={() => setGridMenuOpen((o) => !o)}
              className="p-3 text-on-surface-variant hover:bg-surface-container-high dark:hover:bg-surface-container-highest rounded-full transition-colors"
              aria-label="Quick actions"
            >
              <Grid size={20} aria-hidden="true" />
            </button>
            <AnimatePresence>
              {gridMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40 cursor-pointer"
                    role="presentation"
                    onClick={() => setGridMenuOpen(false)}
                    onTouchEnd={(e) => { e.preventDefault(); setGridMenuOpen(false); }}
                  />
                  <motion.div
                    initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.95, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 10 }}
                    transition={{ duration: reduceMotion ? 0 : 0.15 }}
                    className={cn('absolute bottom-full left-0 mb-4 p-4 bg-white dark:bg-surface-container-lowest rounded-2xl shadow-xl z-50 border origin-bottom-left w-64', highContrast ? 'border-2 border-black' : 'border-slate-100 dark:border-outline-variant/30')}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { key: 'settings', display: 'Settings', icon: Settings, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-500/10', onSelect: () => setA11yOpen(true) },
                        { key: 'about', display: 'Details', icon: Info, color: 'text-green-500', bg: 'bg-green-50 dark:bg-green-500/10', onSelect: () => { setAboutView('main'); setAboutOpen(true); } },
                        { key: 'contact', display: 'Contact', icon: MessageSquare, color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-500/10', onSelect: openContact },
                        ...(phase === 'survey' && currentQuestion
                          ? [{ key: 'skip', display: 'Skip', icon: SkipForward, color: 'text-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-500/10', onSelect: handleSkip }]
                          : []),
                        { key: 'signout', display: 'Sign out', icon: LogOut, color: 'text-orange-500', bg: 'bg-orange-50 dark:bg-orange-500/10', onSelect: signOut },
                      ].map((a) => (
                        <button
                          key={a.key}
                          onClick={() => { setGridMenuOpen(false); a.onSelect(); }}
                          className={cn('flex flex-col items-center justify-center gap-2 p-3 rounded-xl transition-colors', highContrast ? 'border-2 border-black hover:bg-black hover:text-white' : 'hover:bg-surface-container-high dark:hover:bg-surface-container-highest')}
                        >
                          <div className={cn('p-3 rounded-full', highContrast ? 'bg-transparent' : a.bg)}>
                            <a.icon size={24} className={highContrast ? 'text-current' : a.color} aria-hidden="true" />
                          </div>
                          <span className="text-xs font-semibold text-on-surface">{a.display}</span>
                        </button>
                      ))}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
          <input
            type="text"
            value={footerValue}
            disabled={!footerActive}
            onChange={(e) => setFooterValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onFooterSend()}
            aria-label="Type a response"
            placeholder={footerActive ? footerPlaceholder : 'Tap an option above to continue'}
            className="flex-1 min-w-0 bg-surface-container-high rounded-full px-4 py-3 text-[15px] text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
          />
          <button
            onClick={onFooterSend}
            disabled={!footerActive || !footerValue.trim()}
            className="bg-primary text-on-primary p-3 rounded-full active:scale-95 hover:brightness-110 transition-all disabled:opacity-40 disabled:active:scale-100 shrink-0"
            aria-label="Send"
          >
            <Send size={18} aria-hidden="true" />
          </button>
        </div>
      </footer>

      {/* Accessibility modal */}
      <AnimatePresence>
        {a11yOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" initial={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }}
              className="w-full max-w-md max-h-[85vh] bg-white dark:bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden flex flex-col text-on-surface">
              <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/30 shrink-0">
                <h2 id="settings-dialog-title" className="font-bold text-lg flex items-center gap-2"><Settings size={20} aria-hidden="true" /> Settings</h2>
                <button onClick={() => setA11yOpen(false)} aria-label="Close Settings" className="p-1 hover:bg-surface-container-high rounded-full"><X size={20} aria-hidden="true" /></button>
              </div>
              <div className="p-5 flex flex-col gap-5 overflow-y-auto custom-scrollbar">
                {/* Live preview — reflects theme, contrast and text size */}
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-2">Preview</div>
                  <div className="rounded-xl p-4 flex flex-col gap-3 chat-wallpaper border border-outline-variant/30 overflow-hidden bg-surface-container-low">
                    <div className="self-start max-w-[85%]">
                      <div className="px-3 py-2 rounded-2xl message-shadow bg-white dark:bg-surface-container-lowest text-on-surface rounded-tl-none border border-slate-200 dark:border-outline-variant/30">
                        <p className={cn('leading-relaxed font-medium', textSizeClass)}>How does this look?</p>
                      </div>
                    </div>
                    <div className="self-end max-w-[85%]">
                      <div className="px-3 py-2 rounded-2xl message-shadow bg-primary text-on-primary rounded-tr-none">
                        <p className={cn('leading-relaxed font-medium', textSizeClass)}>Looks great!</p>
                      </div>
                    </div>
                  </div>
                </div>
                <Toggle icon={<Moon size={18} aria-hidden="true" />} label="Dark mode" on={dark} onClick={() => setDark((v) => !v)} />
                <Toggle icon={<Contrast size={18} aria-hidden="true" />} label="High contrast" on={highContrast} onClick={() => setHighContrast((v) => !v)} />
                <Toggle icon={<Sun size={18} aria-hidden="true" />} label="Reduce motion" on={reduceMotion} onClick={() => setReduceMotion((v) => !v)} />
                <div>
                  <div className="flex items-center gap-2 mb-2"><Type size={18} aria-hidden="true" /><span className="font-semibold text-sm">Text size</span></div>
                  <div role="group" aria-label="Text size" className="grid grid-cols-4 gap-2">
                    {(['normal', 'large', 'xlarge', 'xxlarge'] as TextSize[]).map((s) => (
                      <button key={s} onClick={() => setTextSize(s)} aria-pressed={textSize === s}
                        className={cn('py-2 rounded-full text-xs font-bold transition-colors',
                          textSize === s ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface')}>{TEXT_SIZE_LABEL[s]}</button>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* About / Study information modal */}
      <AnimatePresence>
        {aboutOpen && (() => {
          // Read the participant's per-study record fresh each time the panel opens.
          const joinedRaw = study ? localStorage.getItem(`esmira_joined_${study.id}_${userId}`) : null;
          let joinedAt: Date | null = null;
          if (joinedRaw && joinedRaw !== '1') {
            const t = Number(joinedRaw);
            const d = Number.isFinite(t) && t > 0 ? new Date(t) : new Date(joinedRaw);
            if (!Number.isNaN(d.getTime())) joinedAt = d;
          }
          const completedCount = study ? Number(localStorage.getItem(`esmira_completed_${study.id}_${userId}`) || '0') : 0;
          const detailTitle = aboutView === 'description' ? 'Study description'
            : aboutView === 'consent' ? 'Informed consent'
            : 'Upload protocol';
          const detailHtml = aboutView === 'description' ? study?.studyDescription : study?.informedConsentForm;
          const protocolEntries = study && aboutView === 'protocol' ? loadUploadProtocol(study.id, userId) : [];
          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
              <motion.div role="dialog" aria-modal="true" aria-labelledby="about-dialog-title" initial={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }}
                className="w-full max-w-md max-h-[85vh] bg-white dark:bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden flex flex-col text-on-surface">
                <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-outline-variant/30 shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {aboutView !== 'main' && (
                      <button onClick={() => setAboutView('main')} aria-label="Back" className="p-1 -ml-1 hover:bg-surface-container-high rounded-full shrink-0"><ChevronLeft size={20} aria-hidden="true" /></button>
                    )}
                    <h2 id="about-dialog-title" className="font-bold text-lg truncate">{aboutView === 'main' ? 'Details' : detailTitle}</h2>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {aboutView === 'protocol' && (
                      <button
                        onClick={() => { void flushSubmitQueue().then(() => setProtocolTick((t) => t + 1)); }}
                        aria-label="Refresh upload protocol"
                        className="p-1 hover:bg-surface-container-high rounded-full"
                      >
                        <RefreshCw size={18} aria-hidden="true" />
                      </button>
                    )}
                    <button onClick={() => setAboutOpen(false)} aria-label="Close" className="p-1 hover:bg-surface-container-high rounded-full"><X size={20} aria-hidden="true" /></button>
                  </div>
                </div>

                {aboutView === 'main' ? (
                  <div className="overflow-y-auto custom-scrollbar">
                    {/* Study identity */}
                    <div className="px-5 pt-4 pb-2">
                      <p className="font-semibold text-on-surface leading-snug">{study?.title}</p>
                    </div>
                    {/* Study information rows */}
                    <div className="px-5 pb-2">
                      <InfoRow label="Username" value={participant || '—'} />
                      <InfoRow label="User id" value={userId || '—'} mono />
                      <InfoRow label="Server url" value={serverRootUrl()} mono />
                      <InfoRow label="Joined at" value={joinedAt ? joinedAt.toLocaleString() : 'Not yet joined'} />
                      <InfoRow label="Completed questionnaires" value={completedCount} />
                      <InfoRow label="Next notification" value={<span className="inline-flex items-center gap-1 text-on-surface-variant"><Bell size={13} aria-hidden="true" /> Not scheduled</span>} />
                    </div>
                    {/* Detail navigation */}
                    <div className="px-3 pb-4 pt-1 flex flex-col">
                      <AboutLinkButton icon={FileText} label="Study description" onClick={() => setAboutView('description')} />
                      <AboutLinkButton icon={ShieldCheck} label="Informed consent" onClick={() => setAboutView('consent')} />
                      <AboutLinkButton icon={UploadCloud} label="Upload protocol" onClick={() => setAboutView('protocol')} />
                    </div>
                    <div className="px-5 pb-4 pt-1 text-center text-xs text-on-surface-variant border-t border-outline-variant/20">
                      Powered by ESMira · web participant interface
                    </div>
                  </div>
                ) : aboutView === 'protocol' ? (
                  <div className="overflow-y-auto custom-scrollbar px-3 py-2">
                    {protocolEntries.length === 0 ? (
                      <p className="px-2 py-4 text-sm text-on-surface-variant">
                        No uploads yet. Each time you submit a questionnaire, the upload to the research server will be listed here.
                      </p>
                    ) : (
                      <ul key={protocolTick} className="flex flex-col">
                        {protocolEntries.map((e) => <ProtocolRow key={e.id} entry={e} />)}
                      </ul>
                    )}
                    <p className="px-2 pt-3 pb-1 text-xs text-on-surface-variant">
                      A record of the data this device has uploaded to the research server.
                    </p>
                  </div>
                ) : (
                  <div className="p-5 overflow-y-auto custom-scrollbar">
                    {detailHtml
                      ? <div className={cn('leading-relaxed esmira-rich', textSizeClass)} dangerouslySetInnerHTML={{ __html: detailHtml }} />
                      : <p className="text-sm text-on-surface-variant">Not provided for this study.</p>}
                  </div>
                )}
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Contact researchers modal */}
      <AnimatePresence>
        {contactOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title" initial={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }}
              className="w-full max-w-md max-h-[85vh] bg-white dark:bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden flex flex-col text-on-surface">
              <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/30 shrink-0">
                <h2 id="contact-dialog-title" className="font-bold text-lg flex items-center gap-2"><MessageSquare size={20} aria-hidden="true" /> Contact researchers</h2>
                <button onClick={() => setContactOpen(false)} aria-label="Close" className="p-1 hover:bg-surface-container-high rounded-full"><X size={20} aria-hidden="true" /></button>
              </div>
              <div className="p-5 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
                {contactStatus === 'sent' ? (
                  <div className="flex flex-col items-center text-center gap-3 py-4">
                    <span className="p-3 rounded-full bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400"><CheckCircle size={28} aria-hidden="true" /></span>
                    <p className="font-semibold">Message sent</p>
                    <p className="text-sm text-on-surface-variant">Thank you — your message has reached the research team.</p>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => setContactStatus('idle')} className="px-4 py-2 rounded-full bg-surface-container-high text-on-surface font-semibold text-sm active:scale-95 transition-all">Send another</button>
                      <button onClick={() => setContactOpen(false)} className="px-4 py-2 rounded-full bg-primary text-on-primary font-semibold text-sm active:scale-95 hover:brightness-110 transition-all">Close</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-on-surface-variant">
                      Send a message to the research team. It's linked to your study id
                      {' '}(<span className="font-mono text-on-surface break-all">{userId || '—'}</span>), so they can see which participant it's from and connect it to your responses. Your name and contact details aren't shared unless you write them here.
                    </p>
                    <textarea
                      value={contactText}
                      onChange={(e) => setContactText(e.target.value)}
                      rows={5}
                      disabled={contactStatus === 'sending'}
                      placeholder="Type your message to the researchers…"
                      aria-label="Message to researchers"
                      className={cn('w-full resize-none rounded-xl bg-surface-container-high px-4 py-3 text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60', textSizeClass)}
                    />
                    {contactStatus === 'error' && (
                      <p className="text-sm text-red-600 dark:text-red-400">Couldn't send your message. Please check your connection and try again.</p>
                    )}
                    <button
                      onClick={sendContact}
                      disabled={contactText.trim().length < 2 || contactStatus === 'sending'}
                      className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary font-bold py-3 rounded-full active:scale-95 hover:brightness-110 transition-all disabled:opacity-40 disabled:active:scale-100"
                    >
                      {contactStatus === 'sending' ? 'Sending…' : <><Send size={18} aria-hidden="true" /> Send message</>}
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen webview overlay (cognitive tasks / external assessments) */}
      <AnimatePresence>
        {webview && (
          <motion.div
            initial={reduceMotion ? { opacity: 1 } : { y: '100%' }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: '100%' }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', damping: 28, stiffness: 220 }}
            className="fixed inset-0 z-[110] bg-surface flex flex-col"
          >
            <header className="bg-surface-container-high text-on-surface px-4 py-3 flex items-center justify-between border-b border-outline-variant/30 shadow-sm shrink-0">
              <h2 className="font-bold text-base truncate pr-2">{webview.title}</h2>
              <button
                onClick={() => setWebview(null)}
                className="flex items-center gap-1.5 px-3 py-2 bg-surface-container-highest rounded-full text-sm font-semibold hover:brightness-95 active:scale-95 transition-all shrink-0"
                aria-label="Close"
              >
                <X size={18} aria-hidden="true" /> Close
              </button>
            </header>
            <iframe
              src={webview.url}
              title={webview.title}
              className="flex-1 w-full border-0"
              allow="autoplay; fullscreen; accelerometer; gyroscope"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A label / value row in the About · Study information panel. */
function InfoRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-outline-variant/20 last:border-0">
      <span className="text-sm text-on-surface-variant shrink-0">{label}</span>
      <span className={cn('text-sm font-medium text-on-surface text-right break-all', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

/** Format an upload time as dd/mm/yy HH:MM (matches the native ESMira protocol). */
function formatProtocolTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One upload in the Upload protocol: survey name, timestamp, and send status. */
function ProtocolRow({ entry }: { entry: UploadProtocolEntry }) {
  const sent = entry.status === 'sent';
  return (
    <li className="flex items-start justify-between gap-3 px-2 py-3 border-b border-outline-variant/20 last:border-0">
      <div className="flex items-start gap-3 min-w-0">
        <span className={cn('p-2 rounded-full shrink-0',
          sent ? 'bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400'
               : 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
          {sent ? <CheckCircle size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm text-on-surface break-words">{entry.label}</p>
          <p className="text-xs text-on-surface-variant">{formatProtocolTime(entry.time)}</p>
        </div>
      </div>
      <span className={cn('text-xs font-semibold shrink-0 mt-1',
        sent ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')}>
        {sent ? 'Sent' : 'Pending'}
      </span>
    </li>
  );
}

/** A tappable row that opens a sub-page (Study description / Informed consent). */
function AboutLinkButton({ icon: Icon, label, onClick }: { icon: typeof FileText; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-2 py-3 rounded-xl hover:bg-surface-container-high dark:hover:bg-surface-container-highest transition-colors text-left">
      <span className="p-2 rounded-full bg-surface-container-high dark:bg-surface-container-highest text-on-surface-variant shrink-0"><Icon size={18} aria-hidden="true" /></span>
      <span className="flex-1 font-semibold text-sm text-on-surface">{label}</span>
      <ChevronRight size={18} className="text-outline-variant shrink-0" aria-hidden="true" />
    </button>
  );
}

function Toggle({ icon, label, on, onClick }: { icon: React.ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} aria-label={label} className="flex items-center justify-between w-full">
      <span className="flex items-center gap-2 font-semibold text-sm">{icon}{label}</span>
      <span className={cn('w-11 h-6 rounded-full transition-colors relative', on ? 'bg-primary' : 'bg-surface-container-highest')}>
        <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}
