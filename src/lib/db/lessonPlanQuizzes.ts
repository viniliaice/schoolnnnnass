import { supabase } from '../supabase';
import { getQuizWithQuestions } from './quizzes';
import type { LessonPlan, LessonPlanPeriod, Quiz, QuizQuestion } from '../../types';

import { QUIZ_GENERATION_DEFAULTS, validateGeneratedResponse, findOffendingQuestions, type GeneratedQuestion, type GeneratedQuiz } from '../quizGenerationValidation';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function optionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

async function fetchContext(planId: string) {
  const { data, error } = await supabase.from('lesson_plans').select('*').eq('id', planId).single();
  if (error || !data) throw error || new Error('Plan not found');
  const plan = data as LessonPlan;

  const [{ data: periodsData, error: periodsError }, { data: unitsData, error: unitsError }] = await Promise.all([
    supabase.from('lesson_plan_periods').select('*').eq('plan_id', planId),
    supabase.from('unit_plans').select('*').eq('class_name', plan.class_name),
  ]);
  if (periodsError) throw periodsError;
  if (unitsError) throw unitsError;

  const dayOrder: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
  const periods = ((periodsData || []) as LessonPlanPeriod[]).sort((a, b) => ((dayOrder[a.day] ?? 99) * 10 + a.period_number) - ((dayOrder[b.day] ?? 99) * 10 + b.period_number));
  return { plan, periods, unitPlans: unitsData || [] };
}

async function edgeFunctionErrorMessage(error: unknown): Promise<string> {
  const maybeError = error as { message?: string; context?: unknown };
  const base = maybeError?.message || 'Quiz generation function failed';
  const context = maybeError?.context;

  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      const detail = [body?.error, body?.code, body?.provider, body?.model].filter(Boolean).join(' · ');
      const excerpt = body?.raw_excerpt ? `\nRaw excerpt: ${String(body.raw_excerpt).slice(0, 800)}` : '';
      return detail ? `${base}: ${detail}${excerpt}` : base + excerpt;
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

const VALIDATION_RETRY_LIMIT = 2;

async function generateWithLLM(plan: LessonPlan, subject: string, subjectPeriods: LessonPlanPeriod[], unitPlans: unknown[]): Promise<GeneratedQuiz[]> {
  let lastRawData: unknown = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= VALIDATION_RETRY_LIMIT; attempt++) {
    const { data, error } = await supabase.functions.invoke('generate-lesson-quizzes', {
      body: {
        plan,
        subject,
        periods: subjectPeriods,
        unit_plans: unitPlans,
        quiz_count: QUIZ_GENERATION_DEFAULTS.quizCount,
        questions_per_quiz: QUIZ_GENERATION_DEFAULTS.questionsPerQuiz,
        direct_answer_min: QUIZ_GENERATION_DEFAULTS.directAnswerMinPerQuiz,
      },
    });
    if (error) {
      // Provider/transport failure — don't retry validation loop here; let caller decide.
      // But log raw for diagnostics if available.
      const msg = await edgeFunctionErrorMessage(error);
      console.error('[lessonPlanQuizzes] edge function invoke failed', { subject, attempt: attempt + 1, error: msg, raw: (error as any)?.context });
      throw new Error(msg);
    }

    lastRawData = data;

    try {
      const validated = validateGeneratedResponse(data);
      if (attempt > 0) console.log('[lessonPlanQuizzes] validation passed after retry', { subject, attempt: attempt + 1 });
      return validated;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const offending = findOffendingQuestions(data);
      const isDistinctError = /options are not distinct/i.test(msg);
      console.error('[lessonPlanQuizzes] validation failed', {
        subject,
        attempt: attempt + 1,
        error: msg,
        offending,
        rawExcerpt: JSON.stringify(data)?.slice(0, 3000),
      });

      // The edge function already runs a targeted repair internally: it re-prompts
      // the provider to regenerate ONLY the offending questions' options and
      // re-validates, before falling back to a full re-generation. If it still
      // fails, we retry the whole generation here a bounded number of times; each
      // re-invoke runs the edge's internal repair again.

      if (attempt === VALIDATION_RETRY_LIMIT) {
        console.error('[lessonPlanQuizzes] validation failed final — logging full raw response', {
          subject,
          error: msg,
          offending,
          rawFull: JSON.stringify(data)?.slice(0, 8000),
        });
        const friendly = `Quiz generation produced duplicate answer options (${msg}). The model was retried ${VALIDATION_RETRY_LIMIT} times and still returned duplicate options for question(s): ${offending.map(o => `quiz ${o.quizIndex + 1} Q${o.questionIndex + 1}`).join(', ') || 'unknown'}. Please try again — the next generation often succeeds, or contact support if it persists. Raw preview: ${JSON.stringify(data)?.slice(0, 600)}`;
        throw new Error(isDistinctError ? friendly : `Quiz generation returned invalid structured output: ${msg}. Raw preview: ${JSON.stringify(data)?.slice(0, 800)}`);
      }

      // Bounded retry: wait briefly then re-invoke whole generation.
      // Edge will again attempt its own repair internally.
      const backoff = 500 * (attempt + 1);
      console.log('[lessonPlanQuizzes] retrying whole generation', { subject, nextAttempt: attempt + 2, backoff });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Unreachable but type-safe
  throw new Error(`Quiz generation returned invalid structured output: ${lastError instanceof Error ? lastError.message : String(lastError)}. Raw: ${JSON.stringify(lastRawData)?.slice(0, 1000)}`);
}

function buildQuestionRow(plan: LessonPlan, quizId: string, subject: string, q: GeneratedQuestion, resolveSubjectId: (value: string) => string | null) {
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

function buildQuizRow(plan: LessonPlan, subject: string, generated: GeneratedQuiz): Quiz {
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
  const { plan, periods, unitPlans } = await fetchContext(planId);
  await cleanupGeneratedQuizzes(planId);

  try {
    const { data: subjectRows, error: subjectsError } = await supabase.from('subjects').select('id, name');
    if (subjectsError) throw subjectsError;
    const resolveSubjectId = buildSubjectIdResolver(subjectRows || []);

    const subjects = unique(periods.filter((p) => !p.is_free && p.subject && p.subject !== '__FREE__').map((p) => p.subject!));
    const quizRows: Quiz[] = [];
    const questionRows: Array<ReturnType<typeof buildQuestionRow>> = [];
    const generatedByQuiz = new Map<string, GeneratedQuiz>();

    for (const subject of subjects) {
      const subjectPeriods = periods.filter((p) => p.subject === subject && !p.is_free);
      if (!subjectPeriods.length) continue;
      const generatedQuizzes = await generateWithLLM(plan, subject, subjectPeriods, unitPlans);
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
