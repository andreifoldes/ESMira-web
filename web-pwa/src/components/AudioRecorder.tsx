/**
 * AudioRecorder — a modal voice-memo recorder for `record_audio` questions.
 *
 * Matches the "New Diary" design: a red REC dot + `MM:SS / max` timer, a live
 * waveform, and Redo / Pause-Resume / Save controls. Recording starts as soon as
 * the sheet opens (mic permission is requested up front). "Save" stops and commits
 * the recording; the parent persists the bytes and advances the survey. Closing
 * (X / backdrop) discards without committing.
 *
 * Capture uses MediaRecorder; the waveform is driven by a Web Audio AnalyserNode
 * sampled on an interval (cheaper and steadier than a per-frame rAF for a handful
 * of bars). The recorded container (WebM on Chrome/Android, MP4 on Safari/iOS)
 * satisfies the server's `/video/i` mime check in file_uploads.php.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { X, Pause, Mic, RotateCcw, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { newAudioIdentifier } from '../lib/audioUploads';
import type { PreloadedQuestion } from '../types';

const BAR_COUNT = 44;
const SAMPLE_MS = 90; // waveform sample + timer tick cadence

type Status = 'starting' | 'recording' | 'paused' | 'denied' | 'error';

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
  for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface Props {
  question: PreloadedQuestion;
  reduceMotion: boolean;
  onCancel: () => void;
  onSave: (identifier: number, blob: Blob) => void;
}

export function AudioRecorder({ question, reduceMotion, onCancel, onSave }: Props) {
  const maxSec = question.max_recording_seconds ?? 300;
  const title = (question.text || 'Voice memo').replace(/<[^>]+>/g, '').trim() || 'Voice memo';

  const [status, setStatus] = useState<Status>('starting');
  const [elapsed, setElapsed] = useState(0);
  const [bars, setBars] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumRef = useRef(0); // ms recorded before the current segment
  const startedAtRef = useRef<number | null>(null); // start of current segment
  const barsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const statusRef = useRef<Status>('starting');
  const committedRef = useRef(false);
  statusRef.current = status;

  const elapsedMs = useCallback(
    () => accumRef.current + (startedAtRef.current != null ? Date.now() - startedAtRef.current : 0),
    [],
  );

  const stopTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  const cleanup = useCallback(() => {
    stopTick();
    try { recRef.current?.state !== 'inactive' && recRef.current?.stop(); } catch { /* already stopped */ }
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try { void ctxRef.current?.close(); } catch { /* ignore */ }
    ctxRef.current = null;
    analyserRef.current = null;
  }, [stopTick]);

  const sample = useCallback(() => {
    const analyser = analyserRef.current;
    let amp = 0;
    if (analyser) {
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      amp = Math.min(1, Math.sqrt(sum / buf.length) * 3.2); // RMS, scaled for visibility
    }
    const next = barsRef.current.slice(1);
    next.push(amp);
    barsRef.current = next;
    setBars(next);
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      if (statusRef.current !== 'recording') return;
      sample();
      const sec = elapsedMs() / 1000;
      setElapsed(sec);
      if (sec >= maxSec) commitRef.current?.(); // hit the cap → auto-save
    }, SAMPLE_MS);
  }, [elapsedMs, maxSec, sample, stopTick]);

  const beginRecorder = useCallback((stream: MediaStream) => {
    const mime = pickMimeType();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    recRef.current = rec;
    rec.start();
    accumRef.current = 0;
    startedAtRef.current = Date.now();
    barsRef.current = new Array(BAR_COUNT).fill(0);
    setBars(barsRef.current);
    setElapsed(0);
    setStatus('recording');
    startTick();
  }, [startTick]);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      beginRecorder(stream);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
    }
  }, [beginRecorder]);

  const commit = useCallback(() => {
    if (committedRef.current) return;
    const rec = recRef.current;
    if (!rec) { onCancel(); return; }
    committedRef.current = true;
    stopTick();
    const finalize = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try { void ctxRef.current?.close(); } catch { /* ignore */ }
      onSave(newAudioIdentifier(), blob);
    };
    rec.onstop = finalize;
    if (rec.state !== 'inactive') rec.stop();
    else finalize();
  }, [onCancel, onSave, stopTick]);

  // Let the interval reach commit without a stale closure.
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = commit;

  const togglePause = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (statusRef.current === 'recording') {
      accumRef.current = elapsedMs();
      startedAtRef.current = null;
      try { rec.state === 'recording' && rec.pause(); } catch { /* pause unsupported — UI still freezes */ }
      setStatus('paused');
    } else if (statusRef.current === 'paused') {
      startedAtRef.current = Date.now();
      try { rec.state === 'paused' && rec.resume(); } catch { /* ignore */ }
      setStatus('recording');
    }
  }, [elapsedMs]);

  const redo = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') { rec.onstop = null; try { rec.stop(); } catch { /* ignore */ } }
    const stream = streamRef.current;
    if (stream) beginRecorder(stream);
    else void start();
  }, [beginRecorder, start]);

  // Start on mount; tear everything down on unmount (covers X/backdrop cancel).
  useEffect(() => {
    void start();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recording = status === 'recording';
  const paused = status === 'paused';
  const active = recording || paused;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} aria-hidden="true" />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full sm:max-w-md bg-white dark:bg-surface-container-lowest rounded-t-3xl sm:rounded-3xl shadow-2xl px-6 pt-4 pb-7"
      >
        {/* Grab handle + header */}
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-outline-variant/50 sm:hidden" />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-on-surface truncate pr-2">{title}</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="p-1.5 -mr-1.5 rounded-full text-on-surface-variant hover:bg-surface-container-high active:scale-95 transition"
          >
            <X size={22} aria-hidden="true" />
          </button>
        </div>

        {status === 'denied' || status === 'error' ? (
          <div className="py-8 text-center">
            <p className="text-on-surface font-medium">
              {status === 'denied'
                ? 'Microphone access is needed to record a voice memo.'
                : "Recording isn't available on this device or browser."}
            </p>
            {status === 'denied' && (
              <p className="mt-2 text-sm text-on-surface-variant">
                Allow microphone access in your browser, then try again.
              </p>
            )}
            <div className="mt-6 flex justify-center gap-3">
              {status === 'denied' && (
                <button
                  onClick={() => { setStatus('starting'); void start(); }}
                  className="bg-primary text-on-primary font-bold px-6 py-3 rounded-full active:scale-95 transition"
                >
                  Try again
                </button>
              )}
              <button
                onClick={onCancel}
                className="bg-surface-container-high text-on-surface font-semibold px-6 py-3 rounded-full active:scale-95 transition"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Timer */}
            <div className="mt-2 flex items-center justify-center gap-2 tabular-nums">
              <span
                className={cn(
                  'inline-block h-2.5 w-2.5 rounded-full',
                  recording ? 'bg-red-500' : 'bg-outline-variant',
                  recording && !reduceMotion && 'animate-pulse',
                )}
                aria-hidden="true"
              />
              <span className="text-base font-semibold text-on-surface">{fmt(elapsed)}</span>
              <span className="text-base text-on-surface-variant">/ {fmt(maxSec)}</span>
            </div>

            {/* Waveform */}
            <div className="mt-5 mb-6 flex items-center justify-center gap-[3px] h-20" aria-hidden="true">
              {bars.map((amp, i) => (
                <div
                  key={i}
                  className={cn('w-[3px] rounded-full transition-[height] duration-75', active ? 'bg-primary' : 'bg-outline-variant')}
                  style={{ height: `${Math.max(4, amp * 72)}px`, opacity: active ? 0.55 + amp * 0.45 : 0.4 }}
                />
              ))}
              {/* Recording cursor at the leading (right) edge */}
              <div className={cn('w-[2px] h-16 rounded-full ml-0.5', recording ? 'bg-primary' : 'bg-transparent')} />
            </div>

            {/* Controls: Redo | Pause/Resume | Save */}
            <div className="flex items-center justify-between">
              <button
                onClick={redo}
                disabled={status === 'starting'}
                className="flex flex-col items-center gap-1 text-on-surface-variant disabled:opacity-40 active:scale-95 transition w-16"
              >
                <RotateCcw size={22} aria-hidden="true" />
                <span className="text-xs font-medium">Redo</span>
              </button>

              <button
                onClick={togglePause}
                disabled={status === 'starting'}
                aria-label={recording ? 'Pause' : 'Resume'}
                className="h-16 w-24 rounded-full border-2 border-outline-variant/60 flex items-center justify-center text-primary disabled:opacity-40 hover:bg-surface-container-high active:scale-95 transition"
              >
                {recording
                  ? <Pause size={26} aria-hidden="true" className="fill-current" />
                  : <Mic size={26} aria-hidden="true" />}
              </button>

              <button
                onClick={commit}
                disabled={status === 'starting'}
                className="flex flex-col items-center gap-1 text-primary font-semibold disabled:opacity-40 active:scale-95 transition w-16"
              >
                <Check size={22} aria-hidden="true" />
                <span className="text-xs">Save</span>
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
