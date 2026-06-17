/**
 * Adapts a raw ESMira questionnaire (from api/studies.php) into the
 * PreloadedSession shape the survey engine consumes, and maps each ESMira
 * `responseType` to the chat UI's internal question type.
 *
 * ESMira web-renderable responseTypes and their CSV value formats (matched to
 * QuestionnaireSaver.php so submitted data is identical to the stock web client):
 *   likert        -> integer 1..likertSteps
 *   list_single   -> the chosen choice string
 *   list_multiple -> per-choice booleans under keys `name~1`..`name~N`
 *   binary        -> "0" (left) | "1" (right)
 *   text_input    -> free text
 *   number        -> numeric string
 *   time/duration -> "HH:MM"
 *   date          -> "YYYY-MM-DD"
 *   va_scale      -> integer 0..maxValue
 *   text          -> display-only (no stored value)  [cognitive link-outs live here]
 */

import type {
  EsmiraInput,
  EsmiraQuestionnaire,
  PreloadedQuestion,
  PreloadedSection,
  PreloadedSession,
} from '../types';

/** responseTypes that contribute a value AND render in this web UI. */
const RENDERABLE = new Set([
  'likert', 'list_single', 'list_multiple', 'binary',
  'text_input', 'number', 'time', 'duration', 'date', 'va_scale',
  'text', 'image',
]);

/** Fisher–Yates shuffle (per-session randomization of randomized pages). */
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Map a single ESMira input to a PreloadedQuestion, or null if unsupported. */
function mapInput(input: EsmiraInput): PreloadedQuestion | null {
  const rt = input.responseType;
  if (!RENDERABLE.has(rt)) return null;

  const base = {
    id: input.name,
    text: input.text ?? '',
    required: input.required ?? false,
    show_if: null,
    other_specify: null,
  };

  switch (rt) {
    case 'likert':
      return {
        ...base,
        type: 'likert',
        scale_min: 1,
        scale_max: input.likertSteps ?? 5,
        scale_min_label: input.leftSideLabel ?? '',
        scale_max_label: input.rightSideLabel ?? '',
      };
    case 'list_single':
      return { ...base, type: 'choice', options: input.listChoices ?? [] };
    case 'list_multiple':
      return { ...base, type: 'multi_choice', options: input.listChoices ?? [] };
    case 'binary':
      return {
        ...base,
        type: 'yesno',
        no_label: input.leftSideLabel || 'No',
        no_value: '0',
        yes_label: input.rightSideLabel || 'Yes',
        yes_value: '1',
      };
    case 'text_input':
      return { ...base, type: 'text' };
    case 'number':
      return { ...base, type: 'number', decimal: input.numberHasDecimal ?? false };
    case 'time':
    case 'duration':
      return { ...base, type: 'time' };
    case 'date':
      return { ...base, type: 'date' };
    case 'va_scale':
      return {
        ...base,
        type: 'va_scale',
        max_value: input.maxValue && input.maxValue > 1 ? input.maxValue : 100,
        scale_min_label: input.leftSideLabel ?? '',
        scale_max_label: input.rightSideLabel ?? '',
      };
    case 'image':
      return {
        ...base,
        type: 'info',
        is_html: true,
        text: `${input.text ?? ''}${input.url ? `<br/><img src="${input.url}" alt="" style="max-width:100%;border-radius:12px"/>` : ''}`,
      };
    case 'text':
    default:
      // Static text / cognitive link-out: display HTML, capture nothing.
      return { ...base, type: 'info', is_html: true };
  }
}

/** Build a PreloadedSession from a questionnaire (pages -> sections). */
export function adaptQuestionnaire(
  studyId: number,
  q: EsmiraQuestionnaire,
  nowMs: number,
): PreloadedSession {
  const questions: PreloadedQuestion[] = [];
  const sections: PreloadedSection[] = [];

  q.pages.forEach((page, pageIdx) => {
    let mapped = page.inputs.map(mapInput).filter((x): x is PreloadedQuestion => x !== null);
    if (page.randomized) mapped = shuffle(mapped);
    if (mapped.length === 0) return;

    const start = questions.length;
    sections.push({
      id: `page-${pageIdx}`,
      name: page.header ?? '',
      description: page.header ?? '',
      start,
      length: mapped.length,
      allow_change_all: false,
    });
    questions.push(...mapped);
  });

  return {
    session_id: `${studyId}-${q.internalId}-${nowMs}`,
    survey_id: String(q.internalId),
    survey_name: q.title,
    survey_description: '',
    questions,
    sections: sections.length ? sections : null,
    question_order: null,
    allow_response_editing: false,
    allow_change_all: false,
    answered: null,
    current_question_index: 0,
  };
}

/** Whether a question type contributes a value to the response payload. */
export function contributesValue(q: PreloadedQuestion): boolean {
  return q.type !== 'info';
}
