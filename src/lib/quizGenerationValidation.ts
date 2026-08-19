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

export interface QuizQualityContext {
  learningObjectives?: Array<string | null | undefined>;
}

function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeAssessmentText(value: string): string {
  return strip(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(?:question|q)\s*\d+[.):\-]?\s*/i, '')
    // Keep arithmetic operators: 12 + 3 and 12 - 3 are not duplicates.
    .replace(/[^\p{L}\p{N}+*×÷/=-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateGeneratedQuizStructure(input: GeneratedQuiz): GeneratedQuiz {
  if (!input.title?.trim()) throw new Error('Generated quiz is missing a title');
  if (!Array.isArray(input.questions) || input.questions.length !== QUIZ_GENERATION_DEFAULTS.questionsPerQuiz) {
    throw new Error(`Generated quiz must contain exactly ${QUIZ_GENERATION_DEFAULTS.questionsPerQuiz} questions`);
  }
  const seen = new Set<string>();
  let directCount = 0;

  input.questions.forEach((q, index) => {
    const normalized = normalizeAssessmentText(q.question);
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);

    const expectedType = index < QUIZ_GENERATION_DEFAULTS.questionsPerQuiz - QUIZ_GENERATION_DEFAULTS.directAnswerMinPerQuiz
      ? 'multiple_choice'
      : 'direct_answer';
    if (q.type !== expectedType) {
      throw new Error(`Question ${index + 1} has invalid type or position`);
    }

    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((option) => !strip(option))) {
        throw new Error(`Question ${index + 1} must have exactly 4 non-empty options`);
      }
      if (new Set(q.options.map((option) => normalizeAssessmentText(option))).size !== 4) {
        throw new Error(`Question ${index + 1} options are not distinct`);
      }
      if (!Number.isInteger(q.correctIndex) || q.correctIndex! < 0 || q.correctIndex! > 3) {
        throw new Error(`Question ${index + 1} has invalid correctIndex`);
      }
    } else if (q.type === 'direct_answer') {
      directCount += 1;
      if (q.options && q.options.length > 0) throw new Error(`Direct-answer question ${index + 1} must not have options`);
      if (!strip(q.rubric)) throw new Error(`Direct-answer question ${index + 1} must have a rubric`);
    } else {
      throw new Error(`Question ${index + 1} has invalid type`);
    }
  });

  if (directCount !== QUIZ_GENERATION_DEFAULTS.directAnswerMinPerQuiz) {
    throw new Error('Generated quiz must include exactly one direct-answer question in the final position');
  }
  return input;
}

interface ForbiddenAssessmentRule {
  pattern: RegExp;
  /** Closely matching objective language; not a category-wide exemption. */
  objectivePattern: RegExp;
}

const FORBIDDEN_ASSESSMENT_PATTERNS: ForbiddenAssessmentRule[] = [
  { pattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i, objectivePattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i },
  { pattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i, objectivePattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i },
  { pattern: /\bworksheet(?:s)?\b/i, objectivePattern: /\bworksheet(?:s)?\b/i },
  { pattern: /\bworkbook(?:s)?\b/i, objectivePattern: /\bworkbook(?:s)?\b/i },
  { pattern: /\btextbook(?:s)?\b/i, objectivePattern: /\btextbook(?:s)?\b/i },
  { pattern: /\bhandout(?:s)?\b/i, objectivePattern: /\bhandout(?:s)?\b/i },
  { pattern: /\bresource(?:s)?\b/i, objectivePattern: /\bresource(?:s)?\b/i },
  { pattern: /\bslide(?:s|\s+number)?\b/i, objectivePattern: /\bslide(?:s|\s+number)?\b/i },
  { pattern: /\bpage(?:\s+\d+)?\b/i, objectivePattern: /\bpage(?:s|\s+\d+)?\b/i },
  { pattern: /\bchart(?:s)?\b/i, objectivePattern: /\bchart(?:s)?\b/i },
  { pattern: /\bdiagram(?:s)?\b/i, objectivePattern: /\bdiagram(?:s)?\b/i },
  { pattern: /\btable(?:s)?\b/i, objectivePattern: /\btable(?:s)?\b/i },
  { pattern: /\bimage(?:s)?\b/i, objectivePattern: /\bimage(?:s)?\b/i },
  { pattern: /\bpassage(?:s)?\b/i, objectivePattern: /\bpassage(?:s)?\b/i },
  { pattern: /\blesson plan(?:ning)?\b/i, objectivePattern: /\blesson plan(?:ning)?\b/i },
  { pattern: /\blearning objective(?:s)?\b/i, objectivePattern: /\blearning objective(?:s)?\b/i },
  { pattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i, objectivePattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i },
  { pattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i, objectivePattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i },
  { pattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i, objectivePattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i },
  { pattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i, objectivePattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i },
  { pattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i, objectivePattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i },
];

const PLACEHOLDER_PATTERN = /(?:\b(?:tbd|todo|lorem ipsum|placeholder|answer here|fill this in)\b|\[(?:insert|replace|add)[^\]]*\]|\b(?:insert|write)\s+(?:question|answer|option|text)\s+here\b|^\s*(?:question|option)\s*[a-d1-9](?:[.?:\-]|\s*$))/i;
const TRUNCATION_PATTERN = /(?:\[(?:context\s+)?truncated\]|(?:\.{3}|…|\betc\.)\s*$)/i;

function objectiveAllows(rule: ForbiddenAssessmentRule, context: QuizQualityContext): boolean {
  return (context.learningObjectives || []).some((objective) => (
    typeof objective === 'string' && rule.objectivePattern.test(objective)
  ));
}

interface NumericOption {
  value: number;
  kind: string;
}

function parseNumericOption(value: string): NumericOption | null {
  const normalized = strip(value).replace(/[−–—]/g, '-');
  const match = normalized.match(/^([$£€])?\s*([+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?)(%)?(?:\s*([\p{L}°]+))?$/u);
  if (!match) return null;
  const numericValue = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(numericValue)) return null;
  const unit = (match[4] || '').toLowerCase();
  const kind = match[1] ? `currency:${match[1]}` : match[3] ? 'percent' : unit ? `unit:${unit}` : 'number';
  return { value: numericValue, kind };
}

interface ArithmeticExpression {
  result: number;
}

function parseArithmeticExpression(question: string): ArithmeticExpression | null {
  const normalized = question.replace(/[−–—]/g, '-');
  const match = normalized.match(/(?:^|[^\d.])(-?\d+(?:\.\d+)?)\s*([+*×÷/]|\s[xX]\s|-)\s*(-?\d+(?:\.\d+)?)(?!\d|\.\d)/);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2].trim().toLowerCase();
  let result: number;
  if (operator === '+') result = left + right;
  else if (operator === '-') result = left - right;
  else if (operator === '*' || operator === '×' || operator === 'x') result = left * right;
  else {
    if (right === 0) throw new Error('Arithmetic question divides by zero');
    result = left / right;
  }
  if (!Number.isFinite(result)) throw new Error('Arithmetic question has a non-finite answer');
  return { result };
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function asksForArithmeticResult(question: string): boolean {
  return /\b(?:what is|calculate|compute|solve|evaluate|find (?:the )?(?:answer|value|result|sum|difference|product|quotient)|how (?:do|would|can|should) (?:you|a student)?\s*solve|explain how to solve)\b|(?:equals|equal to)\s*\?*\s*$/i.test(question);
}

function validateNumericOptions(question: GeneratedQuestion, label: string): void {
  if (question.type !== 'multiple_choice' || !question.options) return;
  const parsedOptions = question.options.map(parseNumericOption);
  const numericCount = parsedOptions.filter(Boolean).length;

  if (numericCount > 0 && numericCount < question.options.length) {
    throw new Error(`${label} mixes numeric answers with malformed numeric distractors`);
  }
  if (numericCount !== question.options.length) return;

  const numericOptions = parsedOptions as NumericOption[];
  if (new Set(numericOptions.map((option) => option.kind)).size !== 1) {
    throw new Error(`${label} numeric distractors must use the same value type`);
  }
  for (let left = 0; left < numericOptions.length; left += 1) {
    for (let right = left + 1; right < numericOptions.length; right += 1) {
      if (nearlyEqual(numericOptions[left].value, numericOptions[right].value)) {
        throw new Error(`${label} has duplicate numeric answer values`);
      }
    }
  }

  const expression = parseArithmeticExpression(question.question);
  if (!expression || !asksForArithmeticResult(question.question)) return;
  const matching = numericOptions
    .map((option, index) => nearlyEqual(option.value, expression.result) ? index : -1)
    .filter((index) => index >= 0);
  if (matching.length !== 1) throw new Error(`${label} must contain exactly one solved arithmetic answer`);
  if (question.correctIndex !== matching[0]) throw new Error(`${label} correctIndex does not match the solved arithmetic answer`);
}

function validateDirectArithmetic(question: GeneratedQuestion, label: string): void {
  if (question.type !== 'direct_answer' || !question.rubric || !asksForArithmeticResult(question.question)) return;
  const expression = parseArithmeticExpression(question.question);
  if (!expression) return;
  const rubricNumbers = question.rubric
    .match(/[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?/g)
    ?.map((value) => Number(value.replace(/,/g, ''))) || [];
  if (!rubricNumbers.some((value) => nearlyEqual(value, expression.result))) {
    throw new Error(`${label} rubric does not include the solved arithmetic answer`);
  }
}

/**
 * Deterministic, high-confidence quality checks run after shape validation.
 * They intentionally avoid trying to judge general subject truth with a large
 * natural-language rules engine.
 */
export function validateGeneratedQuizQuality(
  input: GeneratedQuizResponse | { quizzes: GeneratedQuiz[] },
  context: QuizQualityContext = {},
): void {
  const seenQuestions = new Set<string>();
  const seenAnswerSets = new Set<string>();

  input.quizzes.forEach((quiz, quizIndex) => {
    const titleLabel = `Quiz ${quizIndex + 1} title`;
    if (PLACEHOLDER_PATTERN.test(quiz.title) || TRUNCATION_PATTERN.test(quiz.title)) {
      throw new Error(`${titleLabel} contains placeholder or truncated text`);
    }

    quiz.questions.forEach((question, questionIndex) => {
      const label = `Quiz ${quizIndex + 1} question ${questionIndex + 1}`;
      const normalizedQuestion = normalizeAssessmentText(question.question);
      if (seenQuestions.has(normalizedQuestion)) throw new Error(`${label} duplicates a question from another quiz`);
      seenQuestions.add(normalizedQuestion);

      const assessmentText = [
        question.question,
        ...(question.options || []),
        question.rubric || '',
      ].filter(Boolean);
      if (assessmentText.some((value) => PLACEHOLDER_PATTERN.test(value) || TRUNCATION_PATTERN.test(value))) {
        throw new Error(`${label} contains placeholder or truncated text`);
      }
      for (const rule of FORBIDDEN_ASSESSMENT_PATTERNS) {
        if (assessmentText.some((value) => rule.pattern.test(value)) && !objectiveAllows(rule, context)) {
          throw new Error(`${label} asks about teacher delivery, resources, or lesson planning`);
        }
      }

      if (question.type === 'multiple_choice' && question.options) {
        const answerSet = question.options.map(normalizeAssessmentText).sort().join('|');
        if (seenAnswerSets.has(answerSet)) throw new Error(`${label} repeats an answer set from another question`);
        seenAnswerSets.add(answerSet);
      }

      validateNumericOptions(question, label);
      validateDirectArithmetic(question, label);
    });
  });
}

export function validateGeneratedQuiz(input: GeneratedQuiz, context: QuizQualityContext = {}): GeneratedQuiz {
  validateGeneratedQuizStructure(input);
  validateGeneratedQuizQuality({ quizzes: [input] }, context);
  return input;
}

export function validateGeneratedResponse(input: unknown, context: QuizQualityContext = {}): GeneratedQuiz[] {
  const quizzes = (input as GeneratedQuizResponse)?.quizzes;
  if (!Array.isArray(quizzes) || quizzes.length !== QUIZ_GENERATION_DEFAULTS.quizCount) {
    throw new Error(`LLM must return exactly ${QUIZ_GENERATION_DEFAULTS.quizCount} quizzes`);
  }
  quizzes.forEach(validateGeneratedQuizStructure);
  validateGeneratedQuizQuality({ quizzes }, context);
  return quizzes;
}

/** Returns list of offending question indices for legacy diagnostics. */
export function findOffendingQuestions(input: unknown): Array<{ quizIndex: number; questionIndex: number }> {
  const result: Array<{ quizIndex: number; questionIndex: number }> = [];
  const quizzes = (input as GeneratedQuizResponse)?.quizzes;
  if (!Array.isArray(quizzes)) return result;
  quizzes.forEach((quiz, quizIndex) => {
    if (!Array.isArray(quiz.questions)) return;
    quiz.questions.forEach((question, questionIndex) => {
      if (question.type === 'multiple_choice' && Array.isArray(question.options) && question.options.length === 4) {
        if (new Set(question.options.map((option) => normalizeAssessmentText(option))).size !== 4) {
          result.push({ quizIndex, questionIndex });
        }
      }
    });
  });
  return result;
}
