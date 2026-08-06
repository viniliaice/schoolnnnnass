import type { QuestionType } from '../types';

export const QUIZ_GENERATION_DEFAULTS = {
  quizCount: 3,
  questionsPerQuiz: 4,
  directAnswerMinPerQuiz: 1,
} as const;

export interface GeneratedQuestion {
  type: QuestionType;
  question: string;
  options?: string[] | null;
  correctIndex?: number | null;
  explanation?: string | null;
  rubric?: string | null;
}

export interface GeneratedQuiz {
  title: string;
  questions: GeneratedQuestion[];
}

export interface GeneratedQuizResponse {
  quizzes: GeneratedQuiz[];
}

function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

export function validateGeneratedQuiz(input: GeneratedQuiz): GeneratedQuiz {
  if (!input.title?.trim()) throw new Error('Generated quiz is missing a title');
  if (!Array.isArray(input.questions) || input.questions.length < 3 || input.questions.length > 5) {
    throw new Error('Generated quiz must contain 3–5 questions');
  }
  const seen = new Set<string>();
  let directCount = 0;

  input.questions.forEach((q, index) => {
    const normalized = strip(q.question).toLowerCase();
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);

    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error(`Question ${index + 1} must have exactly 4 options`);
      if (new Set(q.options.map((o) => strip(o).toLowerCase())).size !== 4) throw new Error(`Question ${index + 1} options are not distinct`);
      if (!Number.isInteger(q.correctIndex) || q.correctIndex! < 0 || q.correctIndex! > 3) throw new Error(`Question ${index + 1} has invalid correctIndex`);
    } else if (q.type === 'direct_answer') {
      directCount += 1;
      if (q.options && q.options.length > 0) throw new Error(`Direct-answer question ${index + 1} must not have options`);
      if (!strip(q.rubric)) throw new Error(`Direct-answer question ${index + 1} must have a rubric`);
    } else {
      throw new Error(`Question ${index + 1} has invalid type`);
    }
  });

  if (directCount < QUIZ_GENERATION_DEFAULTS.directAnswerMinPerQuiz) {
    throw new Error('Generated quiz must include at least one direct-answer question');
  }
  return input;
}

export function validateGeneratedResponse(input: unknown): GeneratedQuiz[] {
  const quizzes = (input as GeneratedQuizResponse)?.quizzes;
  if (!Array.isArray(quizzes) || quizzes.length !== QUIZ_GENERATION_DEFAULTS.quizCount) {
    throw new Error(`LLM must return exactly ${QUIZ_GENERATION_DEFAULTS.quizCount} quizzes`);
  }
  return quizzes.map(validateGeneratedQuiz);
}
