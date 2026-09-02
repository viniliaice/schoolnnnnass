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
  /**
   * 'agent' rules flag teacher-as-delivery-agent phrasing and are rescued when
   * the question has a narrative/content frame ("the teacher in the story") —
   * the student is then analysing content, not delivery. 'strict' rules cover
   * lesson artifacts and administrative metadata and are never frame-rescued.
   */
  kind: 'agent' | 'strict';
}

// The teacher is the one making a pedagogical choice: "... should the teacher
// use", "what did the teacher plan", "the teacher's strategy", etc. A bare
// mention of a teacher (a story character, a historical role) is NOT delivery.
const TEACHER_DELIVERY_AGENT_PATTERN = /\b(?:(?:should|could|would|must|can|will|shall)\s+(?:the\s+|a\s+|an\s+)?(?:teacher|instructor|educator)|(?:what|which|how|when|where|why)\s+(?:should|could|would|must|can|will|did|does|do)\s+(?:the\s+|a\s+|an\s+)?(?:teacher|instructor|educator)|(?:teacher|instructor|educator)(?:'s|s)?\s+(?:should|could|would|must|will|use|uses|used|do|does|did|plan|plans|planned|prepare|prepares|prepared|choose|chooses|chose|assign|assigns|assigned|teach|teaches|taught|deliver|delivers|delivered|present|presents|presented|demonstrate|demonstrates|demonstrated|manage|manages|managed|assess|assesses|assessed|grade|grades|graded|start|starts|started|begin|begins|began|continue|continues|continued)|(?:teacher|instructor|educator)(?:'s)?\s+(?:strateg(?:y|ies)|method|methods|technique|techniques|approach|resources?|materials?|lesson\s+plans?|planning|objective|delivery))\b/i;

// A teacher (or any mentioned person) inside supplied content the student is
// asked to comprehend: story, passage, history, experiment write-up, etc.
const NARRATIVE_CONTENT_FRAME = /\bin\s+(?:the\s+)?(?:story|passage|text|reading|novel|poem|book|article|play|scene|film|video|history|interview|conversation)\b/i;

const FORBIDDEN_ASSESSMENT_PATTERNS: ForbiddenAssessmentRule[] = [
  { kind: 'agent', pattern: TEACHER_DELIVERY_AGENT_PATTERN, objectivePattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i },
  { kind: 'strict', pattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i, objectivePattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i },
  { kind: 'strict', pattern: /\bworksheet(?:s)?\b/i, objectivePattern: /\bworksheet(?:s)?\b/i },
  { kind: 'strict', pattern: /\bworkbook(?:s)?\b/i, objectivePattern: /\bworkbook(?:s)?\b/i },
  { kind: 'strict', pattern: /\btextbook(?:s)?\b/i, objectivePattern: /\btextbook(?:s)?\b/i },
  { kind: 'strict', pattern: /\bhandout(?:s)?\b/i, objectivePattern: /\bhandout(?:s)?\b/i },
  // "Resource"/"materials" alone are legitimate academic words (natural
  // resources, properties of materials, library-skills questions); only the
  // instructional-delivery collocations are forbidden.
  { kind: 'strict', pattern: /\b(?:teaching|learning|classroom|lesson|school)\s+resources?\b|\bresources?\s+(?:for|used?\s+in|during)\s+(?:the\s+)?(?:lesson|class|period|activity|week)\b/i, objectivePattern: /\b(?:teaching|learning|classroom|lesson|school)\s+resources?\b|\bresources?\s+(?:for|used?\s+in|during)\s+(?:the\s+)?(?:lesson|class|period|activity|week)\b/i },
  { kind: 'strict', pattern: /\b(?:teaching|classroom|lesson)\s+materials?\b|\bmaterials?\s+(?:for|used?\s+in)\s+(?:the\s+)?(?:lesson|class|activity)\b/i, objectivePattern: /\b(?:teaching|classroom|lesson)\s+materials?\b|\bmaterials?\s+(?:for|used?\s+in)\s+(?:the\s+)?(?:lesson|class|activity)\b/i },
  { kind: 'strict', pattern: /\bslide(?:s|\s+number)?\b/i, objectivePattern: /\bslide(?:s|\s+number)?\b/i },
  { kind: 'strict', pattern: /\bpage(?:\s+\d+)?\b/i, objectivePattern: /\bpage(?:s|\s+\d+)?\b/i },
  { kind: 'strict', pattern: /\bchart(?:s)?\b/i, objectivePattern: /\bchart(?:s)?\b/i },
  { kind: 'strict', pattern: /\bdiagram(?:s)?\b/i, objectivePattern: /\bdiagram(?:s)?\b/i },
  { kind: 'strict', pattern: /\btable(?:s)?\b/i, objectivePattern: /\btable(?:s)?\b/i },
  { kind: 'strict', pattern: /\bimage(?:s)?\b/i, objectivePattern: /\bimage(?:s)?\b/i },
  // "Passage" is a normal reading-comprehension content word ("main idea of
  // the passage") and is allowed; delivery phrasing is caught by the agent rule.
  { kind: 'strict', pattern: /\blesson plan(?:ning)?\b/i, objectivePattern: /\blesson plan(?:ning)?\b/i },
  { kind: 'strict', pattern: /\blearning objective(?:s)?\b/i, objectivePattern: /\blearning objective(?:s)?\b/i },
  { kind: 'strict', pattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i, objectivePattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i },
  { kind: 'strict', pattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i, objectivePattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i },
  { kind: 'strict', pattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i, objectivePattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i },
  { kind: 'strict', pattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i, objectivePattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i },
  // Subtle instructional-planning phrasing without the word "teacher".
  { kind: 'strict', pattern: /\bwhat\s+comes\s+next\s+in\s+(?:the\s+)?(?:lesson|plan)\b|\bhow\s+should\s+(?:this|the)\s+lesson\s+be\s+(?:delivered|taught|introduced|presented)\b|\bwhich\s+(?:lesson[- ]?plan|planning)\s+step\b/i, objectivePattern: /\bwhat\s+comes\s+next\s+in\s+(?:the\s+)?(?:lesson|plan)\b|\bhow\s+should\s+(?:this|the)\s+lesson\s+be\s+(?:delivered|taught|introduced|presented)\b|\bwhich\s+(?:lesson[- ]?plan|planning)\s+step\b/i },
  { kind: 'strict', pattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i, objectivePattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i },
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

// Short intensifier prefixes that keep an option numeric, e.g. "about 100" or
// "at least 5". Anything longer or free-form stays non-numeric.
const APPROXIMATE_QUANTITY_PREFIX = /^(?:about|approx\.?|approximately|around|roughly|nearly|almost|exactly|circa|at least|at most|up to|over|under|above|below|more than|less than|fewer than|no more than|no less than)\s+/i;
const FRACTION_PATTERN = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;
const MIXED_FRACTION_PATTERN = /^([+-]?\d+)\s+(\d+)\/(\d+)$/;
const CURRENCY_CODE_PATTERN = /^(usd|eur|gbp|sar|aed|egp|kes|sos|etb|ugx|tzs)$/i;
const NUMERIC_OPTION_PATTERN = /^([$£€])?\s*([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*(%|[$£€])?(?:\s*([\p{L}°]{1,16}))?$/u;

/**
 * Parse an option that is a pure numeric value: 12, 3.5, 0.75, 010, 10.0,
 * 25%, $15, 10$, 15 USD, 2/5, 1 1/2, -3, 1,200, 10 000, 45°, "10 apples",
 * "about 100". Free-form sentences that merely contain a number ("World War II
 * began in 1939") do NOT parse and remain non-numeric.
 */
function parseNumericOption(value: string): NumericOption | null {
  const normalized = strip(value).replace(/[−–—]/g, '-').replace(/^~/, '');
  const withoutPrefix = normalized.replace(APPROXIMATE_QUANTITY_PREFIX, '');

  let numerator: number | null = null;
  let denominator: number | null = null;
  const simple = withoutPrefix.match(FRACTION_PATTERN);
  const mixed = withoutPrefix.match(MIXED_FRACTION_PATTERN);
  if (simple) {
    numerator = Number(simple[1]);
    denominator = Number(simple[2]);
  } else if (mixed) {
    numerator = Number(mixed[1]) * Number(mixed[2]) + Number(mixed[3]);
    denominator = Number(mixed[2]);
  }
  if (numerator !== null && denominator !== null) {
    if (denominator === 0) return null;
    const fractionValue = numerator / denominator;
    return Number.isFinite(fractionValue) ? { value: fractionValue, kind: 'number' } : null;
  }

  const match = withoutPrefix.match(NUMERIC_OPTION_PATTERN);
  if (!match) return null;
  const numericValue = Number(match[2].replace(/[ ,]/g, ''));
  if (!Number.isFinite(numericValue)) return null;

  const prefixSymbol = match[1] || null;
  const suffixMark = match[3] || null;
  const trailingWord = (match[4] || '').trim();
  const currencyCode = trailingWord ? trailingWord.match(CURRENCY_CODE_PATTERN) : null;
  const unitWord = trailingWord && !currencyCode ? trailingWord.toLowerCase() : '';

  if (prefixSymbol && suffixMark && prefixSymbol !== suffixMark) return null;
  if ((prefixSymbol || currencyCode) && suffixMark === '%') return null;
  if (suffixMark && suffixMark !== '%' && unitWord) return null;

  const bareSymbol = prefixSymbol ?? (suffixMark && suffixMark !== '%' ? suffixMark : null);
  if (prefixSymbol && currencyCode) return { value: numericValue, kind: `currency:${currencyCode[1].toLowerCase()}` };
  if (bareSymbol) {
    return { value: numericValue, kind: `currency:${bareSymbol.toLowerCase()}` };
  }
  if (suffixMark === '%' || ['percent', 'percentage', 'pct'].includes(unitWord)) {
    return { value: numericValue, kind: 'percent' };
  }
  if (currencyCode) return { value: numericValue, kind: `currency:${currencyCode[1].toLowerCase()}` };
  if (unitWord) return { value: numericValue, kind: `unit:${unitWord}` };
  return { value: numericValue, kind: 'number' };
}

/**
 * May two parsed numeric kinds share one question's option set? Decimals and
 * fractions are one abstract numeric type; concrete measurement units (days,
 * hours, km, m) are legitimately comparable with each other. Percentages and
 * each currency are their own types and must not be mixed with bare numbers.
 */
function compatibleNumericKinds(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith('unit:') && right.startsWith('unit:')) return true;
  return false;
}

interface ArithmeticExpression {
  result: number;
}

function parseArithmeticExpression(question: string): ArithmeticExpression | null {
  const normalized = question.replace(/[−–—]/g, '-');
  // "3/4 of 12" or "25% of 80" are multiplicative phrasings, not division: a
  // regex cannot reliably solve them, so skip rather than mis-solve them.
  if (/(?:\d+\s*\/\s*\d+|\d+\s*%)\s+of\s+\d/i.test(normalized)) return null;
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

/**
 * Semantic numeric-distractor rule (mirrors the Edge boundary validator).
 *
 * The question type is decided by the CORRECT ANSWER, not by counting digits:
 * - If the correct answer is non-numeric (a conceptual/definition question),
 *   any bare-numeric distractor ("12", "45%") is meaningless → reject.
 * - If the correct answer is numeric (a genuinely numeric/calculation/date/
 *   quantity/price question), numeric distractors are expected and allowed;
 *   the option set must simply stay one comparable numeric type with distinct
 *   values (fractions and decimals are the same type; different measurement
 *   units such as "24 hours" and "365 days" may be compared in one set).
 */
function validateNumericOptions(question: GeneratedQuestion, label: string): void {
  if (question.type !== 'multiple_choice' || !question.options) return;
  const options = question.options;
  const correctIndex = question.correctIndex;
  // CORRECT_INDEX shape is validated structurally; guard standalone callers.
  if (!Number.isInteger(correctIndex) || correctIndex! < 0 || correctIndex! >= options.length) return;

  const parsedOptions = options.map((option) => parseNumericOption(option));
  const numericCount = parsedOptions.filter(Boolean).length;
  if (numericCount === 0) return; // fully non-numeric question: nothing numeric to police

  const correctIsNumeric = parsedOptions[correctIndex!] !== null;
  if (!correctIsNumeric) {
    throw new Error(`${label} uses a numeric distractor on a non-numeric question`);
  }

  // Numeric question: every option must be numeric (no word-numbers or prose
  // mixed into an otherwise numeric set — those are malformed distractors).
  if (numericCount !== options.length) {
    throw new Error(`${label} mixes numeric answers with malformed numeric distractors`);
  }

  const numericOptions = parsedOptions as NumericOption[];
  for (let left = 0; left < numericOptions.length; left += 1) {
    for (let right = left + 1; right < numericOptions.length; right += 1) {
      if (!compatibleNumericKinds(numericOptions[left].kind, numericOptions[right].kind)) {
        throw new Error(`${label} numeric distractors must use the same value type`);
      }
      // Only values with the identical kind/unit are directly comparable.
      if (
        numericOptions[left].kind === numericOptions[right].kind
        && nearlyEqual(numericOptions[left].value, numericOptions[right].value)
      ) {
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
        if (!assessmentText.some((value) => rule.pattern.test(value))) continue;
        if (objectiveAllows(rule, context)) continue;
        // A teacher inside content the student is analysing ("the teacher in
        // the story discovered...") is academic content, not lesson delivery.
        if (rule.kind === 'agent' && NARRATIVE_CONTENT_FRAME.test(question.question)) continue;
        throw new Error(`${label} asks about teacher delivery, resources, or lesson planning`);
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

/**
 * User-facing cause sentences keyed by the allowlisted validation error code
 * the Edge Function reports. Never include generated quiz content; used so
 * the UI explains the ACTUAL failure (e.g. FORBIDDEN_CONTEXT) instead of a
 * hardcoded "duplicate answer options" guess.
 */
export const QUIZ_VALIDATION_FAILURE_HINTS: Record<string, string> = {
  FORBIDDEN_CONTEXT: 'One generated question focused on teacher or lesson-delivery content instead of student learning, so the quiz set was rejected.',
  NUMERIC_DISTRACTOR: 'A generated question had invalid numeric answer choices, so the quiz set was rejected.',
  ARITHMETIC_ANSWER: 'A generated calculation question had a wrong or ambiguous answer, so the quiz set was rejected.',
  DUPLICATE_QUESTION: 'The model returned duplicate questions, so the quiz set was rejected.',
  DUPLICATE_ANSWER_SET: 'The model returned duplicate answer options, so the quiz set was rejected.',
  PLACEHOLDER_OR_TRUNCATION: 'A generated question was incomplete or contained placeholder text, so the quiz set was rejected.',
  QUIZ_COUNT: 'The model returned the wrong number of quizzes, so the quiz set was rejected.',
  QUIZ_SHAPE: 'A generated quiz was structurally invalid, so the quiz set was rejected.',
  QUESTION_SHAPE: 'A generated question was structurally invalid, so the quiz set was rejected.',
  QUESTION_TYPE: 'The generated questions were in the wrong order or of the wrong type, so the quiz set was rejected.',
  OPTION_SHAPE: 'A generated question had invalid answer options, so the quiz set was rejected.',
  CORRECT_INDEX: 'A generated question had an invalid correct answer marker, so the quiz set was rejected.',
  DIRECT_ANSWER_SHAPE: 'A generated direct-answer question was malformed, so the quiz set was rejected.',
  UNKNOWN_VALIDATION: 'The model returned an invalid quiz set.',
};

const VALIDATION_CODE_HINT_PATTERN = new RegExp(
  `\\b(${Object.keys(QUIZ_VALIDATION_FAILURE_HINTS).join('|')})\\b`,
  'g',
);

/**
 * Derive the accurate user-facing cause from an error message string. The
 * Edge Function appends the allowlisted validationErrorCode to its error
 * detail, so scanning the message for codes is safe and content-free.
 * Returns null when no code is present (e.g. a transport failure).
 */
export function quizValidationFailureHint(message: string | null | undefined): string | null {
  if (!message) return null;
  const codes = message.match(VALIDATION_CODE_HINT_PATTERN);
  if (!codes || codes.length === 0) return null;
  return QUIZ_VALIDATION_FAILURE_HINTS[codes[codes.length - 1]] ?? QUIZ_VALIDATION_FAILURE_HINTS.UNKNOWN_VALIDATION;
}
