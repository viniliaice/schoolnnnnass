import { supabase } from '../supabase';
import { getQuizWithQuestions } from './quizzes';
import type { LessonPlan, LessonPlanPeriod, Quiz, QuizQuestion } from '../../types';

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

async function generateWithLLM(plan: LessonPlan, subject: string, subjectPeriods: LessonPlanPeriod[], unitPlans: unknown[]): Promise<GeneratedQuiz[]> {
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
  if (error) throw error;
  return validateGeneratedResponse(data);
}

async function insertGeneratedQuestion(plan: LessonPlan, quizId: string, subject: string, q: GeneratedQuestion) {
  const questionId = id('q');
  const isMcq = q.type === 'multiple_choice';
  const options = isMcq ? q.options!.map((text, index) => ({ label: optionLabel(index), text })) : null;
  const correctAnswer = isMcq ? optionLabel(q.correctIndex!) : null;
  const row = {
    id: questionId,
    prompt: q.question,
    type: q.type,
    options,
    correctAnswer,
    rubric: isMcq ? (q.explanation ?? null) : q.rubric!,
    teacherId: plan.teacher_id,
    createdAt: new Date().toISOString(),
    source_lesson_plan_id: plan.id,
    source_quiz_id: quizId,
    source_subject_id: subject,
    source_class_name: plan.class_name,
    source_auto_generated: true,
  };
  const { error } = await supabase.from('questions').insert(row);
  if (error) throw error;
  return { questionId, points: 1 };
}

async function saveGeneratedQuiz(plan: LessonPlan, subject: string, generated: GeneratedQuiz): Promise<Quiz> {
  const quizId = id('quiz');
  const openDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const quizRow = {
    id: quizId,
    className: plan.class_name,
    subject,
    title: generated.title,
    description: `AI-generated from lesson plan ${plan.week_label}.`,
    openDate,
    dueDate,
    timeLimit: 10,
    questionOrder: 'created' as const,
    teacherId: plan.teacher_id,
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    lesson_plan_id: plan.id,
    auto_generated: true,
  };
  const { error: quizErr } = await supabase.from('quizzes').insert(quizRow);
  if (quizErr) throw quizErr;

  const refs = [];
  for (const question of generated.questions) refs.push(await insertGeneratedQuestion(plan, quizId, subject, question));

  const { data: questions, error: qErr } = await supabase.from('questions').select('*').in('id', refs.map((r) => r.questionId));
  if (qErr) throw qErr;
  const questionMap = new Map((questions || []).map((q) => [q.id, q]));
  const junctionRows = refs.map((ref, i) => {
    const src = questionMap.get(ref.questionId) as any;
    return {
      id: id('qq'),
      quizId,
      questionId: ref.questionId,
      orderIndex: i,
      points: 1,
      promptSnapshot: src.prompt,
      optionsSnapshot: src.type === 'multiple_choice' ? src.options : null,
      correctAnswerSnapshot: src.correctAnswer,
      typeSnapshot: src.type,
    };
  });
  const { error: jErr } = await supabase.from('quiz_questions').insert(junctionRows);
  if (jErr) throw jErr;
  return quizRow as Quiz;
}

export async function generateLessonPlanQuizzes(planId: string): Promise<Quiz[]> {
  const { plan, periods, unitPlans } = await fetchContext(planId);
  await supabase.from('quizzes').delete().eq('lesson_plan_id', planId).eq('auto_generated', true);
  await supabase.from('questions').delete().eq('source_lesson_plan_id', planId).eq('source_auto_generated', true);

  const subjects = unique(periods.filter((p) => !p.is_free && p.subject && p.subject !== '__FREE__').map((p) => p.subject!));
  const created: Quiz[] = [];

  for (const subject of subjects) {
    const subjectPeriods = periods.filter((p) => p.subject === subject && !p.is_free);
    if (!subjectPeriods.length) continue;
    const generatedQuizzes = await generateWithLLM(plan, subject, subjectPeriods, unitPlans);
    for (const generated of generatedQuizzes) created.push(await saveGeneratedQuiz(plan, subject, generated));
  }

  return created;
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
      source_subject_id: quiz.subject,
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
