/**
 * SurveyInputs — renders the current question's input controls inside a
 * chat-style card. Ported from the iEMAbot PWA's OfflineSurveyPanel, adapted to
 * ESMira's web-renderable input set (native time/date/number/va_scale pickers
 * instead of iEMAbot's webview tokens). Plain `text` questions are answered via
 * the footer (handled in App), matching the iEMAbot chat experience.
 */

import { useState } from 'react';
import { motion } from 'motion/react';
import { ChevronRight, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import type { PreloadedQuestion } from '../types';

const OPTION_ICONS: Record<string, string> = {
  'Work': '💼', 'Household': '🏠', 'Self-care': '🧴', 'Relaxation': '😌',
  'Sport/physical activity': '🏃', 'Eating/drinking': '🍽️',
  'Traveling/on the way': '🚗', 'In a conversation': '💬',
  'Something else': '📝', 'Nothing': '💤',
  'Indoors': '🏠', 'Home': '🏠', 'Work/Office': '🏢',
  'School/University': '🎓', 'Outdoors': '🌳', 'In transit': '🚌',
  'Shop/Errands': '🛒', 'Restaurant/Cafe': '☕',
  "Someone else's home": '🏡', 'Gym/Sports facility': '🏋️', 'Other': '📍',
};

interface Props {
  question: PreloadedQuestion;
  progress: number;
  textSizeClass: string;
  reduceMotion: boolean;
  onRespond: (id: string, value: string) => void;
  onContinueInfo: () => void;
}

export function SurveyInputs({
  question,
  progress,
  textSizeClass,
  reduceMotion,
  onRespond,
  onContinueInfo,
}: Props) {
  return (
    <div className="pb-4 pt-2 self-start max-w-[85%] w-[85%]">
      {/* Progress bar */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-surface-container-high rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${progress * 100}%` }}
            transition={{ duration: reduceMotion ? 0 : 0.3 }}
          />
        </div>
        <span className="text-[10px] font-bold text-on-surface-variant">
          {Math.round(progress * 100)}%
        </span>
      </div>

      <motion.div
        key={question.id}
        initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="self-start w-full"
      >
        <div className="bg-white dark:bg-surface-container-lowest border-l-4 border-primary p-5 rounded-xl rounded-tl-none shadow-lg w-full">
          {question.type === 'info' ? (
            <div
              className={cn('text-on-surface leading-relaxed esmira-rich', textSizeClass)}
              dangerouslySetInnerHTML={{ __html: question.text }}
            />
          ) : (
            <p className={cn('font-semibold text-on-surface leading-snug mb-2 whitespace-pre-wrap', textSizeClass)}>
              {question.text}
            </p>
          )}
          {question.type !== 'info' && !question.required && (
            <p className="text-xs text-on-surface-variant italic mb-2">(Optional)</p>
          )}

          {question.type === 'likert' && <LikertInput question={question} onRespond={onRespond} />}
          {question.type === 'yesno' && <YesNoInput question={question} onRespond={onRespond} />}
          {question.type === 'choice' && question.options && <ChoiceList question={question} onRespond={onRespond} />}
          {question.type === 'multi_choice' && question.options && <MultiChoice question={question} onRespond={onRespond} />}
          {question.type === 'number' && <NumberInput question={question} onRespond={onRespond} />}
          {question.type === 'time' && <TimeInput question={question} onRespond={onRespond} />}
          {question.type === 'date' && <DateInput question={question} onRespond={onRespond} />}
          {question.type === 'va_scale' && <VaScale question={question} onRespond={onRespond} />}
          {question.type === 'text' && (
            <p className="text-sm text-on-surface-variant mt-2">Type your response below.</p>
          )}
          {question.type === 'info' && (
            <button
              onClick={onContinueInfo}
              className="w-full mt-4 bg-primary text-on-primary font-bold py-3 rounded-full flex items-center justify-center gap-2 hover:brightness-110 transition-all active:scale-95"
            >
              Continue
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

function LikertInput({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const min = question.scale_min ?? 1;
  const max = question.scale_max ?? 5;
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <>
      {(question.scale_min_label || question.scale_max_label) && (
        <p className="text-xs text-on-surface-variant mb-4">
          ({question.scale_min_label && `${min} = ${question.scale_min_label}`}
          {question.scale_min_label && question.scale_max_label && ', '}
          {question.scale_max_label && `${max} = ${question.scale_max_label}`})
        </p>
      )}
      <div className="flex justify-between items-center mt-2 px-1 gap-1">
        {values.map((val) => (
          <button
            key={val}
            onClick={() => onRespond(question.id, String(val))}
            className="w-10 h-10 rounded-full bg-surface-container-high hover:bg-primary hover:text-on-primary transition-all font-bold flex items-center justify-center active:scale-90"
          >
            {val}
          </button>
        ))}
      </div>
    </>
  );
}

function YesNoInput({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const opts = [
    { label: question.yes_label || 'Yes', value: question.yes_value ?? 'Yes', primary: true },
    { label: question.no_label || 'No', value: question.no_value ?? 'No', primary: false },
  ];
  return (
    <div className="flex gap-3 mt-4">
      {opts.map((o) => (
        <button
          key={o.value}
          onClick={() => onRespond(question.id, o.value)}
          className={cn(
            'flex-1 py-3 px-4 rounded-full font-bold text-sm transition-all active:scale-95',
            o.primary ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-on-surface',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChoiceList({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  return (
    <div className="relative mt-4">
      <div className="flex flex-col gap-2 max-h-60 overflow-y-auto thick-scrollbar pr-2 pb-6">
        {question.options!.map((opt) => (
          <button
            key={opt}
            onClick={() => onRespond(question.id, opt)}
            className="w-full flex items-center justify-between px-4 py-3 bg-surface-container-low hover:bg-surface-container-high rounded-xl transition-colors text-left group shrink-0"
          >
            <span className="font-medium text-sm">
              {OPTION_ICONS[opt] && <span className="mr-2">{OPTION_ICONS[opt]}</span>}
              {opt}
            </span>
            <ChevronRight size={16} className="text-outline-variant group-hover:text-primary" />
          </button>
        ))}
      </div>
      <div className="absolute bottom-0 left-0 right-2 h-8 bg-gradient-to-t from-white dark:from-surface-container-lowest to-transparent pointer-events-none rounded-b-xl" />
    </div>
  );
}

function MultiChoice({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (opt: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(opt) ? next.delete(opt) : next.add(opt);
      return next;
    });
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex flex-col gap-2 max-h-60 overflow-y-auto thick-scrollbar pr-2">
        {question.options!.map((opt) => {
          const on = selected.has(opt);
          return (
            <button
              key={opt}
              onClick={() => toggle(opt)}
              className={cn(
                'w-full flex items-center justify-between px-4 py-3 rounded-xl transition-colors text-left shrink-0',
                on ? 'bg-primary text-on-primary' : 'bg-surface-container-low hover:bg-surface-container-high',
              )}
            >
              <span className="font-medium text-sm">{opt}</span>
              {on && <Check size={16} />}
            </button>
          );
        })}
      </div>
      <button
        onClick={() => onRespond(question.id, Array.from(selected).join(','))}
        className="w-full mt-2 bg-primary text-on-primary font-bold py-3 rounded-full transition-all active:scale-95 hover:brightness-110"
      >
        Done
      </button>
    </div>
  );
}

function NumberInput({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <ConfirmRow disabled={val.trim() === ''} onConfirm={() => onRespond(question.id, val.trim())}>
      <input
        type="number"
        step={question.decimal ? '0.5' : '1'}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="flex-1 bg-surface-container-low rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        placeholder="Enter a number"
      />
    </ConfirmRow>
  );
}

function TimeInput({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <ConfirmRow disabled={!val} onConfirm={() => onRespond(question.id, val)}>
      <input
        type="time"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="flex-1 bg-surface-container-low rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
    </ConfirmRow>
  );
}

function DateInput({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <ConfirmRow disabled={!val} onConfirm={() => onRespond(question.id, val)}>
      <input
        type="date"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="flex-1 bg-surface-container-low rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
    </ConfirmRow>
  );
}

function VaScale({ question, onRespond }: { question: PreloadedQuestion; onRespond: (id: string, v: string) => void }) {
  const max = question.max_value ?? 100;
  const [val, setVal] = useState(Math.round(max / 2));
  return (
    <div className="mt-4 flex flex-col gap-3">
      {(question.scale_min_label || question.scale_max_label) && (
        <div className="flex justify-between text-xs text-on-surface-variant">
          <span>{question.scale_min_label}</span>
          <span>{question.scale_max_label}</span>
        </div>
      )}
      <input
        type="range"
        min={0}
        max={max}
        value={val}
        onChange={(e) => setVal(Number(e.target.value))}
        className="w-full accent-primary"
      />
      <div className="text-center font-bold text-on-surface">{val}</div>
      <button
        onClick={() => onRespond(question.id, String(val))}
        className="w-full bg-primary text-on-primary font-bold py-3 rounded-full transition-all active:scale-95 hover:brightness-110"
      >
        Confirm
      </button>
    </div>
  );
}

function ConfirmRow({ children, disabled, onConfirm }: { children: React.ReactNode; disabled: boolean; onConfirm: () => void }) {
  return (
    <div className="mt-4 flex items-center gap-2">
      {children}
      <button
        onClick={onConfirm}
        disabled={disabled}
        className="bg-primary text-on-primary font-bold p-3 rounded-full transition-all active:scale-95 hover:brightness-110 disabled:opacity-40 disabled:active:scale-100"
        aria-label="Confirm"
      >
        <Check size={18} />
      </button>
    </div>
  );
}
