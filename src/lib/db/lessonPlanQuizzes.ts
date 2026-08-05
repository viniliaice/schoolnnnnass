import { supabase } from '../supabase';
import { createQuestion, createQuiz, getQuizWithQuestions } from './quizzes';
import type { LessonPlan, LessonPlanPeriod, Quiz, QuizQuestion } from '../../types';

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function firstSentence(text: string): string {
  return text.split(/[.!?]/).map((s) => s.trim()).find(Boolean) || text.trim();
}

function questionPrompt(period: LessonPlanPeriod, n: number): string {
  const topic = period.topic || 'the lesson topic';
  const objective = period.objective || `understand ${topic}`;
  if (n === 1) return `Which statement best shows understanding of ${topic}?`;
  if (n === 2) return `Apply this objective in one example: ${firstSentence(objective)}.`;
  return `What is one key step or idea students should remember about ${topic}?`;
}

function optionsFor(period: LessonPlanPeriod, n: number) {
  const topic = period.topic || 'this topic';
  return [
    { label: 'A', text: `A correct explanation or example of ${topic}` },
    { label: 'B', text: `An unrelated fact that does not use ${topic}` },
    { label: 'C', text: 'Skipping the task without showing work' },
    { label: 'D', text: 'Copying an answer without explaining it' },
  ].map((option, index) => n === 3 && index === 0 ? { ...option, text: `The main concept from ${topic}` } : option);
}

export async function generateLessonPlanQuizzes(planId: string): Promise<Quiz[]> {
  const { data, error } = await supabase
    .from('lesson_plans')
    .select('*')
    .eq('id', planId)
    .single();
  if (error || !data) throw error || new Error('Plan not found');
  const plan = data as LessonPlan;

  const { data: periodsData, error: periodsError } = await supabase
    .from('lesson_plan_periods')
    .select('*')
    .eq('plan_id', planId);
  if (periodsError) throw periodsError;
  const dayOrder: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
  const periods = ((periodsData || []) as LessonPlanPeriod[]).sort((a, b) => ((dayOrder[a.day] ?? 99) * 10 + a.period_number) - ((dayOrder[b.day] ?? 99) * 10 + b.period_number));

  await supabase.from('quizzes').delete().eq('lesson_plan_id', planId).eq('auto_generated', true);

  const subjects = unique(periods.filter((p) => !p.is_free && p.subject && p.subject !== '__FREE__').map((p) => p.subject!));
  const created: Quiz[] = [];
  const openDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const subject of subjects) {
    const subjectPeriods = periods.filter((p) => p.subject === subject && !p.is_free).slice(0, 3);
    if (!subjectPeriods.length) continue;

    for (let quizIndex = 1; quizIndex <= 3; quizIndex += 1) {
      const refs = [];
      for (let i = 0; i < Math.min(3, subjectPeriods.length); i += 1) {
        const period = subjectPeriods[i];
        const question = await createQuestion({
          prompt: questionPrompt(period, quizIndex),
          type: 'multiple_choice',
          options: optionsFor(period, quizIndex),
          correctAnswer: 'A',
          rubric: null,
          teacherId: plan.teacher_id,
        });
        refs.push({ questionId: question.id, points: 1 });
      }

      const quiz = await createQuiz({
        className: plan.class_name,
        subject,
        title: `${plan.title} — Quiz ${quizIndex}`,
        description: `Auto-generated from lesson plan ${plan.week_label}.`,
        openDate,
        dueDate,
        timeLimit: 10,
        questionOrder: 'created',
        teacherId: plan.teacher_id,
        lesson_plan_id: planId,
        auto_generated: true,
      }, refs);
      created.push(quiz);
    }
  }

  return created;
}

export async function fetchLessonPlanQuizPreviews(planId: string): Promise<Array<{ quiz: Quiz; questions: QuizQuestion[] }>> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('lesson_plan_id', planId)
    .eq('auto_generated', true)
    .order('createdAt', { ascending: true });
  if (error) throw error;

  const previews = await Promise.all((data || []).map(async (quiz) => {
    const full = await getQuizWithQuestions(quiz.id);
    return full ? { quiz: full.quiz, questions: full.questions } : null;
  }));

  return previews.filter(Boolean) as Array<{ quiz: Quiz; questions: QuizQuestion[] }>;
}
