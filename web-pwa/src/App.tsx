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
  Settings, ClipboardList, Info, MoreVertical, X,
  Sun, Moon, Contrast, Type, Send, ChevronRight, CheckCircle, RotateCcw, LogOut,
} from 'lucide-react';
import { cn } from './lib/utils';
import { OfflineSurveyEngine } from './lib/surveyEngine';
import { adaptQuestionnaire } from './lib/esmiraAdapter';
import {
  buildEsmiraResponses, fetchStudy, installSubmitQueueFlusher, submitQuestionnaire,
  submitCognitiveTrials,
} from './lib/esmiraApi';
import type { EsmiraStudy, PreloadedQuestion } from './types';
import { SurveyInputs } from './components/SurveyInputs';

type Phase = 'loading' | 'error' | 'consent' | 'name' | 'list' | 'survey';
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

// Hidden questionnaire used as the tabular sink for cognitive trial rows.
const TRIALS_QN_TITLE = 'Cognitive Trials';

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

  const [phase, setPhase] = useState<Phase>('loading');
  const [study, setStudy] = useState<EsmiraStudy | null>(null);
  const [serverVersion, setServerVersion] = useState(11);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [participant, setParticipant] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [footerValue, setFooterValue] = useState('');

  const engineRef = useRef<OfflineSurveyEngine | null>(null);
  const initedRef = useRef(false);
  const surveyStartRef = useRef(0);
  const activeQRef = useRef<{ id: number; name: string } | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<PreloadedQuestion | null>(null);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Accessibility (client-only)
  const [dark, setDark] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [textSize, setTextSize] = useState<TextSize>('normal');
  const textSizeClass = TEXT_SIZE_CLASS[textSize];

  const [menuOpen, setMenuOpen] = useState(false);
  const [a11yOpen, setA11yOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
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
        const savedName = localStorage.getItem(`esmira_participant_${study.id}`) || '';
        setParticipant(savedName);
        pushBot(`Welcome to ${study.title}.`);
        if (study.studyDescription) pushBot(study.studyDescription);
        const consented = localStorage.getItem(`esmira_consent_${study.id}`) === '1';
        if (study.informedConsentForm && !consented) {
          pushBot(study.informedConsentForm);
          setPhase('consent');
        } else if (!savedName) {
          pushBot('Before we begin — what name or ID would you like to use? (Your researcher may have given you one.)');
          setPhase('name');
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
      pushBot('Thank you. What name or ID would you like to use?');
      setPhase('name');
    } else {
      setPhase('list');
    }
  };

  // ── Sign out: clear this study's saved identity/consent, restart ──
  const signOut = () => {
    if (!window.confirm("Sign out? You'll need to enter your name again to continue the study.")) return;
    if (study) {
      localStorage.removeItem(`esmira_participant_${study.id}`);
      localStorage.removeItem(`esmira_consent_${study.id}`);
    }
    window.location.reload();
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
      pushBot(`Thanks, ${value}! Which questionnaire would you like to complete?`);
      setPhase('list');
      return;
    }
    if (phase === 'survey' && currentQuestion?.type === 'text') {
      setFooterValue('');
      handleRespond(currentQuestion.id, value);
    }
  };

  // ── Start a questionnaire ────────────────────────────────────
  const startQuestionnaire = (internalId: number) => {
    if (!study) return;
    const q = study.questionnaires.find((x) => x.internalId === internalId);
    if (!q) return;
    const session = adaptQuestionnaire(study.id, q, Date.now());
    const engine = new OfflineSurveyEngine(session);
    engineRef.current = engine;
    activeQRef.current = { id: q.internalId, name: q.title };
    surveyStartRef.current = Date.now();
    pushUser(q.title);
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

  const handleContinueInfo = () => {
    const engine = engineRef.current;
    if (!engine) return;
    // Settle the info/link-out content into the thread (keeps the link clickable).
    if (currentQuestion) pushBot(currentQuestion.text, !!currentQuestion.is_html);
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

  // ── Finish & submit ──────────────────────────────────────────
  const finishSurvey = async () => {
    const engine = engineRef.current;
    const active = activeQRef.current;
    if (!engine || !study || !active) return;
    setSubmitting(true);
    const responses = buildEsmiraResponses(engine.session.questions, engine.getResponseMap());
    const joinedKey = `esmira_joined_${study.id}_${participant}`;
    const newParticipant = !localStorage.getItem(joinedKey);
    const ok = await submitQuestionnaire({
      study,
      serverVersion,
      accessKey,
      questionnaireInternalId: active.id,
      questionnaireName: active.name,
      participant,
      responses,
      newParticipant,
      formDuration: Date.now() - surveyStartRef.current,
      pageDurations: '',
    });
    localStorage.setItem(joinedKey, '1');
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
    const bits: string[] = [];
    if (s.n_trials != null) bits.push(`${s.n_trials} trials`);
    if (s.duration_s != null) bits.push(`${s.duration_s}s`);
    if (s.correct_count != null) bits.push(`${s.correct_count} correct`);
    if (q) {
      pushBot(q.title || 'Cognitive task', false, qid);
      pushUser(`✓ Completed${bits.length ? ' — ' + bits.join(', ') : ''}`, qid);
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
    if (study && trialsQn && active && trials.length) {
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
        study, serverVersion, accessKey, participant,
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
  const footerPlaceholder = phase === 'name' ? 'Enter your name or ID' : 'Type your response…';

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className={cn(
      'flex flex-col h-screen bg-surface overflow-hidden transition-colors duration-300',
      dark && 'dark', highContrast && 'high-contrast',
    )}>
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-[#075E54] dark:bg-surface-container-lowest text-white dark:text-on-surface shadow-md flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <ClipboardList size={20} />
          </div>
          <div className="flex flex-col min-w-0">
            <h1 className="text-base font-bold leading-none truncate">{study?.title ?? 'ESMira Study'}</h1>
            <span className="text-[10px] opacity-80 uppercase tracking-widest font-semibold truncate">
              {participant ? participant : 'Survey'}
            </span>
          </div>
        </div>
        <div className="relative shrink-0">
          <button onClick={() => setMenuOpen((o) => !o)} className="p-2 hover:bg-white/10 rounded-full transition-colors" aria-label="More options">
            <MoreVertical size={20} />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <motion.div
                  initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.95, y: -10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -10 }}
                  transition={{ duration: reduceMotion ? 0 : 0.15 }}
                  className="absolute right-0 mt-2 w-48 bg-white dark:bg-surface-container-lowest rounded-xl shadow-lg py-2 z-50 border border-slate-100 dark:border-outline-variant/30 origin-top-right text-on-surface"
                >
                  <button onClick={() => { setMenuOpen(false); setA11yOpen(true); }} className="w-full text-left px-4 py-3 text-sm flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-surface-container-high">
                    <Settings size={18} /><span className="font-medium">Settings</span>
                  </button>
                  <button onClick={() => { setMenuOpen(false); setAboutOpen(true); }} className="w-full text-left px-4 py-3 text-sm flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-surface-container-high">
                    <Info size={18} /><span className="font-medium">About</span>
                  </button>
                  <button onClick={() => { setMenuOpen(false); signOut(); }} className="w-full text-left px-4 py-3 text-sm flex items-center gap-3 text-red-600 dark:text-red-400 hover:bg-slate-50 dark:hover:bg-surface-container-high">
                    <LogOut size={18} /><span className="font-medium">Sign out</span>
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* Chat area */}
      <main ref={scrollRef} className="flex-1 mt-16 mb-20 chat-wallpaper overflow-y-auto px-4 py-6 flex flex-col gap-4 no-scrollbar">
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
                  {msg.sender === 'user' && <CheckCircle size={12} className="text-on-primary opacity-70" />}
                </div>
              </div>
              {phase === 'survey' && msg.qid && msg.id === lastAnswerId && (
                <button
                  onClick={() => onChangeResponse(msg.qid!)}
                  className="mt-1 px-3 py-1.5 bg-surface-container-high dark:bg-surface-container-highest text-on-surface-variant rounded-full text-xs font-semibold flex items-center gap-1.5 hover:bg-surface-container-highest transition-colors active:scale-95"
                >
                  <RotateCcw size={12} /> Change response
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
                <ChevronRight size={18} className="text-outline-variant" />
              </button>
            ))}
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
      <footer className="fixed bottom-0 left-0 right-0 z-50 bg-white/85 dark:bg-surface-container-lowest/85 backdrop-blur-md rounded-t-2xl shadow-[0_-4px_12px_rgba(0,0,0,0.05)] px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={footerValue}
            disabled={!footerActive}
            onChange={(e) => setFooterValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onFooterSend()}
            placeholder={footerActive ? footerPlaceholder : 'Tap an option above to continue'}
            className="flex-1 min-w-0 bg-surface-container-high rounded-full px-4 py-3 text-[15px] text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
          />
          <button
            onClick={onFooterSend}
            disabled={!footerActive || !footerValue.trim()}
            className="bg-primary text-on-primary p-3 rounded-full active:scale-95 hover:brightness-110 transition-all disabled:opacity-40 disabled:active:scale-100 shrink-0"
            aria-label="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </footer>

      {/* Accessibility modal */}
      <AnimatePresence>
        {a11yOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div initial={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }}
              className="w-full max-w-md max-h-[85vh] bg-white dark:bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden flex flex-col text-on-surface">
              <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/30 shrink-0">
                <h2 className="font-bold text-lg flex items-center gap-2"><Settings size={20} /> Settings</h2>
                <button onClick={() => setA11yOpen(false)} className="p-1 hover:bg-surface-container-high rounded-full"><X size={20} /></button>
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
                <Toggle icon={<Moon size={18} />} label="Dark mode" on={dark} onClick={() => setDark((v) => !v)} />
                <Toggle icon={<Contrast size={18} />} label="High contrast" on={highContrast} onClick={() => setHighContrast((v) => !v)} />
                <Toggle icon={<Sun size={18} />} label="Reduce motion" on={reduceMotion} onClick={() => setReduceMotion((v) => !v)} />
                <div>
                  <div className="flex items-center gap-2 mb-2"><Type size={18} /><span className="font-semibold text-sm">Text size</span></div>
                  <div className="grid grid-cols-4 gap-2">
                    {(['normal', 'large', 'xlarge', 'xxlarge'] as TextSize[]).map((s) => (
                      <button key={s} onClick={() => setTextSize(s)}
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

      {/* About modal */}
      <AnimatePresence>
        {aboutOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <motion.div initial={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={reduceMotion ? { scale: 1 } : { scale: 0.95, y: 20 }}
              className="w-full max-w-md bg-white dark:bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden flex flex-col text-on-surface">
              <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/30">
                <h2 className="font-bold text-lg">About</h2>
                <button onClick={() => setAboutOpen(false)} className="p-1 hover:bg-surface-container-high rounded-full"><X size={20} /></button>
              </div>
              <div className="p-5 flex flex-col gap-2 text-sm text-on-surface-variant">
                <p><span className="font-semibold text-on-surface">{study?.title}</span></p>
                {participant && <p>Participant: <span className="font-mono">{participant}</span></p>}
                <p>Powered by ESMira · web participant interface</p>
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
                <X size={18} /> Close
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

function Toggle({ icon, label, on, onClick }: { icon: React.ReactNode; label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center justify-between w-full">
      <span className="flex items-center gap-2 font-semibold text-sm">{icon}{label}</span>
      <span className={cn('w-11 h-6 rounded-full transition-colors relative', on ? 'bg-primary' : 'bg-surface-container-highest')}>
        <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}
