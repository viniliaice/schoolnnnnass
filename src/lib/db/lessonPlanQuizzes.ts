import { supabase } from '../supabase';
import { getQuizWithQuestions } from './quizzes';
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, Quiz, QuizQuestion } from '../../types';

import { QUIZ_GENERATION_DEFAULTS, validateGeneratedResponse, type GeneratedQuestion, type GeneratedQuiz } from '../quizGenerationValidation';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function optionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

type QuizGenerationPlan = Pick<LessonPlan, 'id' | 'teacher_id' | 'class_name' | 'week_label' | 'title'>;
type QuizGenerationPeriod = Pick<LessonPlanPeriod, 'day' | 'period_number' | 'subject' | 'is_free' | 'topic' | 'objective' | 'activities' | 'details'>;

interface CompactQuizPeriod {
  period_number: number;
  subject: string;
  topic: string;
  objective: string | null;
  activities: string;
  details: Array<Pick<PeriodActivity, 'activity'>>;
}

interface CompactQuizGenerationRequest {
  plan: Pick<QuizGenerationPlan, 'class_name' | 'title'>;
  subject: string;
  periods: CompactQuizPeriod[];
  quiz_count: number;
  questions_per_quiz: number;
  direct_answer_min: number;
}

/**
 * Keep the browser-to-Edge request independent of database row shape. IDs,
 * timestamps, teacher metadata, and detail fields not used in the prompt never
 * cross the worker boundary.
 */
export function buildQuizGenerationRequest(
  plan: QuizGenerationPlan,
  subject: string,
  subjectPeriods: QuizGenerationPeriod[],
): CompactQuizGenerationRequest {
  const bounded = (value: string | null | undefined, maxChars: number): string => {
    const raw = value || '';
    return raw.slice(0, maxChars * 4).replace(/\s+/g, ' ').trim().slice(0, maxChars);
  };
  const compactSubject = bounded(subject, 160);

  return {
    plan: {
      class_name: bounded(plan.class_name, 120),
      title: bounded(plan.title, 320),
    },
    subject: compactSubject,
    periods: subjectPeriods
      .slice(0, 24)
      .map((period) => ({
        period_number: period.period_number,
        // The stored value is commonly a database subject ID. The caller has
        // already selected these periods, so send only the educational label.
        subject: compactSubject,
        topic: bounded(period.topic, 180),
        objective: period.objective ? bounded(period.objective, 260) : null,
        activities: bounded(period.activities, 320),
        details: Array.isArray(period.details)
          ? period.details.slice(0, 4).map(({ activity }) => ({ activity: bounded(activity, 140) }))
          : [],
      })),
    quiz_count: QUIZ_GENERATION_DEFAULTS.quizCount,
    questions_per_quiz: QUIZ_GENERATION_DEFAULTS.questionsPerQuiz,
    direct_answer_min: QUIZ_GENERATION_DEFAULTS.directAnswerMinPerQuiz,
  };
}

async function fetchContext(planId: string): Promise<{ plan: QuizGenerationPlan; periods: QuizGenerationPeriod[] }> {
  const { data, error } = await supabase
    .from('lesson_plans')
    .select('id, teacher_id, class_name, week_label, title')
    .eq('id', planId)
    .single();
  if (error || !data) throw error || new Error('Plan not found');
  const plan = data as QuizGenerationPlan;

  const { data: periodsData, error: periodsError } = await supabase
    .from('lesson_plan_periods')
    .select('day, period_number, subject, is_free, topic, objective, activities, details')
    .eq('plan_id', planId);
  if (periodsError) throw periodsError;

  const dayOrder: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
  const periods = ((periodsData || []) as QuizGenerationPeriod[]).sort((a, b) => ((dayOrder[a.day] ?? 99) * 10 + a.period_number) - ((dayOrder[b.day] ?? 99) * 10 + b.period_number));
  return { plan, periods };
}

async function edgeFunctionErrorMessage(error: unknown): Promise<string> {
  const maybeError = error as { message?: string; context?: unknown };
  const base = maybeError?.message || 'Quiz generation function failed';
  const context = maybeError?.context;

  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      const detail = [body?.error, body?.code, body?.provider, body?.model].filter(Boolean).join(' · ');
      return detail ? `${base}: ${detail}` : base;
    } catch {
      try {
        const text = await context.clone().text();
        return text ? `${base}: ${text}` : base;
      } catch {
        return base;
      }
    }
  }

  return base;
}

function dbErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
  const parts = [e.message, e.code ? `code: ${e.code}` : '', e.details, e.hint]
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length ? parts.join(' · ') : JSON.stringify(err);
}

// Period `subject` values are normally subjects.id, but legacy plans and the
// CSV-import fallback (LessonPlanner.tsx) can store a display name, and admin
// can delete a subject, leaving stale ids. questions.source_subject_id has an
// FK to subjects(id), so resolve the stored value to a real id (or NULL).
function buildSubjectIdResolver(rows: Array<{ id: string; name?: string | null }>): (value: string) => string | null {
  const byId = new Set(rows.map((r) => r.id));
  const byName = new Map<string, string>();
  for (const r of rows) {
    const n = r.name?.trim().toLowerCase();
    if (n) byName.set(n, r.id);
  }
  return (value) => {
    const v = (value || '').trim();
    if (!v) return null;
    if (byId.has(v)) return v;
    return byName.get(v.toLowerCase()) ?? null;
  };
}

function buildSubjectLabelResolver(rows: Array<{ id: string; name?: string | null }>): (value: string) => string {
  const byId = new Map(rows.map((row) => [row.id, row.name?.trim() || 'Lesson subject'] as const));
  const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

  return (value) => {
    const storedValue = (value || '').trim();
    return byId.get(storedValue) || (uuidPattern.test(storedValue) ? 'Lesson subject' : storedValue) || 'Lesson subject';
  };
}

async function generateWithLLM(
  plan: QuizGenerationPlan,
  subject: string,
  subjectPeriods: QuizGenerationPeriod[],
): Promise<GeneratedQuiz[]> {
  const { data, error } = await supabase.functions.invoke('generate-lesson-quizzes', {
    body: buildQuizGenerationRequest(plan, subject, subjectPeriods),
  });
  if (error) {
    const message = await edgeFunctionErrorMessage(error);
    console.error('[lessonPlanQuizzes] edge function invoke failed', { subject, error: message.slice(0, 1000) });
    throw new Error(message);
  }

  try {
    return validateGeneratedResponse(data);
  } catch (err) {
    // The Edge Function validates the same response contract before returning.
    // Reinvoking the full generation here multiplies provider work without
    // recovering from schema drift, so retain client validation as a guard only.
    const message = err instanceof Error ? err.message : String(err);
    const quizzes = (data as { quizzes?: unknown })?.quizzes;
    const quizCount = Array.isArray(quizzes) ? quizzes.length : null;
    const questionCounts = Array.isArray(quizzes)
      ? quizzes.slice(0, 10).map((quiz) => {
          const questions = (quiz as { questions?: unknown })?.questions;
          return Array.isArray(questions) ? questions.length : null;
        })
      : [];
    console.error('[lessonPlanQuizzes] Edge/client validation mismatch', {
      validationResult: 'failed',
      quizCount,
      questionCounts,
    });
    throw new Error(`Quiz generation returned invalid structured output: ${message}`);
  }
}

function buildQuestionRow(plan: QuizGenerationPlan, quizId: string, subject: string, q: GeneratedQuestion, resolveSubjectId: (value: string) => string | null) {
  const isMcq = q.type === 'multiple_choice';
  return {
    id: id('q'),
    prompt: q.question,
    type: q.type,
    options: isMcq ? q.options!.map((text, index) => ({ label: optionLabel(index), text })) : null,
    correctAnswer: isMcq ? optionLabel(q.correctIndex!) : null,
    rubric: isMcq ? (q.explanation ?? null) : q.rubric!,
    teacherId: plan.teacher_id,
    createdAt: new Date().toISOString(),
    source_lesson_plan_id: plan.id,
    source_quiz_id: quizId,
    source_subject_id: resolveSubjectId(subject),
    source_class_name: plan.class_name,
    source_auto_generated: true,
  };
}

function buildQuizRow(plan: QuizGenerationPlan, subject: string, generated: GeneratedQuiz): Quiz {
  const openDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    id: id('quiz'),
    className: plan.class_name,
    subject,
    title: generated.title,
    description: `AI-generated from lesson plan ${plan.week_label}.`,
    openDate,
    dueDate,
    timeLimit: 10,
    questionOrder: 'created',
    teacherId: plan.teacher_id,
    status: 'draft',
    createdAt: new Date().toISOString(),
    lesson_plan_id: plan.id,
    auto_generated: true,
  };
}

async function cleanupGeneratedQuizzes(planId: string) {
  await supabase.from('quizzes').delete().eq('lesson_plan_id', planId).eq('auto_generated', true);
  await supabase.from('questions').delete().eq('source_lesson_plan_id', planId).eq('source_auto_generated', true);
}

export async function generateLessonPlanQuizzes(planId: string): Promise<Quiz[]> {
  const { plan, periods } = await fetchContext(planId);
  await cleanupGeneratedQuizzes(planId);

  try {
    const { data: subjectRows, error: subjectsError } = await supabase.from('subjects').select('id, name');
    if (subjectsError) throw subjectsError;
    const resolveSubjectId = buildSubjectIdResolver(subjectRows || []);
    const resolveSubjectLabel = buildSubjectLabelResolver(subjectRows || []);

    const subjects = unique(periods.filter((p) => !p.is_free && p.subject && p.subject !== '__FREE__').map((p) => p.subject!));
    const quizRows: Quiz[] = [];
    const questionRows: Array<ReturnType<typeof buildQuestionRow>> = [];
    const generatedByQuiz = new Map<string, GeneratedQuiz>();

    for (const subject of subjects) {
      const subjectPeriods = periods.filter((p) => p.subject === subject && !p.is_free);
      if (!subjectPeriods.length) continue;
      const generatedQuizzes = await generateWithLLM(plan, resolveSubjectLabel(subject), subjectPeriods);
      for (const generated of generatedQuizzes) {
        const quiz = buildQuizRow(plan, subject, generated);
        quizRows.push(quiz);
        generatedByQuiz.set(quiz.id, generated);
        questionRows.push(...generated.questions.map((question) => buildQuestionRow(plan, quiz.id, subject, question, resolveSubjectId)));
      }
    }

    if (quizRows.length === 0) return [];

    // Bulk writes are deliberately used here. The previous implementation posted
    // each question individually, which caused browser REST calls to /questions to
    // reset mid-run and left a partial single quiz saved for some plans.
    const { error: quizErr } = await supabase.from('quizzes').insert(quizRows);
    if (quizErr) throw quizErr;

    const { data: insertedQuestions, error: questionErr } = await supabase
      .from('questions')
      .insert(questionRows)
      .select('*');
    if (questionErr) throw questionErr;

    const questionOrder = new Map<string, number>();
    for (const [quizId, generated] of generatedByQuiz.entries()) {
      generated.questions.forEach((question, index) => {
        questionOrder.set(`${quizId}::${question.question}`, index);
      });
    }

    const junctionRows = (insertedQuestions || []).map((src: any) => ({
      id: id('qq'),
      quizId: src.source_quiz_id,
      questionId: src.id,
      orderIndex: questionOrder.get(`${src.source_quiz_id}::${src.prompt}`) ?? 0,
      points: 1,
      promptSnapshot: src.prompt,
      optionsSnapshot: src.type === 'multiple_choice' ? src.options : null,
      correctAnswerSnapshot: src.correctAnswer,
      typeSnapshot: src.type,
    }));

    const { error: junctionErr } = await supabase.from('quiz_questions').insert(junctionRows);
    if (junctionErr) throw junctionErr;

    return quizRows;
  } catch (err) {
    await cleanupGeneratedQuizzes(planId);
    // Log full error with raw for diagnostics (requirement 6). PostgrestError is
    // not an Error instance, so String(err) alone yields "[object Object]".
    const msg = dbErrorMessage(err);
    console.error('[generateLessonPlanQuizzes] final failure', { planId, error: msg, raw: err });
    throw new Error(msg);
  }
}

export async function fetchLessonPlanQuizPreviews(planId: string): Promise<Array<{ quiz: Quiz; questions: QuizQuestion[]; addedToBank: boolean }>> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('lesson_plan_id', planId)
    .eq('auto_generated', true)
    .order('createdAt', { ascending: true });
  if (error) throw error;

  const seen = new Set<string>();
  const previews = await Promise.all((data || []).filter((quiz) => {
    if (seen.has(quiz.id)) return false;
    seen.add(quiz.id);
    return true;
  }).map(async (quiz) => {
    const full = await getQuizWithQuestions(quiz.id);
    if (!full || full.questions.length === 0) return null;
    const { data: imported } = await supabase
      .from('questions')
      .select('id')
      .eq('teacherId', full.quiz.teacherId)
      .eq('source_quiz_id', full.quiz.id)
      .eq('source_auto_generated', false)
      .limit(1);
    return { quiz: full.quiz, questions: full.questions, addedToBank: !!imported?.length };
  }));

  return previews.filter(Boolean) as Array<{ quiz: Quiz; questions: QuizQuestion[]; addedToBank: boolean }>;
}

export async function addGeneratedQuizToBank(quizId: string): Promise<'added' | 'already_added'> {
  const full = await getQuizWithQuestions(quizId);
  if (!full) throw new Error('Quiz not found');
  const { quiz, questions } = full;
  const { data: existing } = await supabase
    .from('questions')
    .select('id')
    .eq('teacherId', quiz.teacherId)
    .eq('source_quiz_id', quizId)
    .eq('source_auto_generated', false)
    .limit(1);
  if (existing?.length) return 'already_added';

  const { data: subjectRows } = await supabase.from('subjects').select('id, name');
  const resolveSubjectId = buildSubjectIdResolver(subjectRows || []);

  const { data: sourceQuestions, error: sourceErr } = await supabase
    .from('questions')
    .select('*')
    .in('id', questions.map((q) => q.questionId));
  if (sourceErr) throw sourceErr;
  const sourceMap = new Map((sourceQuestions || []).map((q: any) => [q.id, q]));

  const rows = questions.map((q) => {
    const source = sourceMap.get(q.questionId) as any;
    return {
      id: id('qbank'),
      prompt: q.promptSnapshot,
      type: q.typeSnapshot,
      options: q.typeSnapshot === 'multiple_choice' ? (q.optionsSnapshot ?? null) : null,
      correctAnswer: q.correctAnswerSnapshot ?? null,
      rubric: q.typeSnapshot === 'direct_answer' ? (source?.rubric || 'Correct response must address the full prompt using accurate lesson vocabulary, a clear method, and evidence from the objective.') : (source?.rubric ?? null),
      teacherId: quiz.teacherId,
      createdAt: new Date().toISOString(),
      source_lesson_plan_id: quiz.lesson_plan_id ?? null,
      source_quiz_id: quizId,
      source_subject_id: resolveSubjectId(quiz.subject),
      source_class_name: quiz.className,
      source_auto_generated: false,
    };
  });

  const { error } = await supabase.from('questions').insert(rows);
  if (error) {
    if ((error as any).code === '23505') return 'already_added';
    throw error;
  }
  return 'added';
}
