import { supabase } from '../supabase';
import { getQuizWithQuestions } from './quizzes';
import type { LessonPlan, LessonPlanPeriod, Quiz, QuizQuestion } from '../../types';

interface GeneratedQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
}

interface GeneratedQuiz {
  title: string;
  questions: GeneratedQuestion[];
}

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function gradeFromClass(className: string): string {
  return className.match(/(?:Grade|Year)\s*\d+/i)?.[0] || className;
}

function activityText(period: LessonPlanPeriod): string {
  const details = (period.details || []).map((d) => [d.activity, d.resource, d.place].filter(Boolean).join(' using ')).filter(Boolean);
  return strip(details.join('; ') || period.activities || 'class practice');
}

function validateGeneratedQuiz(input: GeneratedQuiz): GeneratedQuiz {
  if (!input.title?.trim()) throw new Error('Generated quiz is missing a title');
  if (!Array.isArray(input.questions) || input.questions.length < 3 || input.questions.length > 5) {
    throw new Error('Generated quiz must contain 3–5 questions');
  }
  const seen = new Set<string>();
  input.questions.forEach((q, index) => {
    const normalized = strip(q.question).toLowerCase();
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);
    if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error(`Question ${index + 1} must have exactly 4 options`);
    if (new Set(q.options.map((o) => strip(o).toLowerCase())).size !== 4) throw new Error(`Question ${index + 1} options are not distinct`);
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) throw new Error(`Question ${index + 1} has invalid correctIndex`);
  });
  return input;
}

function buildStructuredQuiz(plan: LessonPlan, subject: string, subjectPeriods: LessonPlanPeriod[], quizIndex: number): GeneratedQuiz {
  const grade = gradeFromClass(plan.class_name);
  const focus = subjectPeriods[(quizIndex - 1) % subjectPeriods.length];
  const topic = strip(focus.topic) || 'the lesson topic';
  const objective = strip(focus.objective) || `understand ${topic}`;
  const activity = activityText(focus);
  const questions: GeneratedQuestion[] = [
    {
      question: `In ${grade}, which task best demonstrates the objective: "${objective}"?`,
      options: [
        `Solving a new ${topic} example and explaining the steps`,
        `Copying the ${topic} title from the board`,
        `Reading silently without showing an answer`,
        `Waiting for the teacher to solve every example`,
      ],
      correctIndex: 0,
      explanation: `The correct option requires students to apply and explain the stated objective.`,
    },
    {
      question: `During ${activity}, what should the teacher check to confirm students understand ${topic}?`,
      options: [
        `Students can show the method and justify the answer`,
        `Students finish quickly without showing work`,
        `Students only repeat the page number`,
        `Students avoid using the lesson vocabulary`,
      ],
      correctIndex: 0,
      explanation: `Evidence of method and justification is aligned to the lesson objective.`,
    },
    {
      question: `Which question would best connect this period's activity to the unit objective for ${subject}?`,
      options: [
        `How does this example help us master ${topic}?`,
        `Who has the neatest notebook today?`,
        `What color is the worksheet?`,
        `Can we skip the independent practice?`,
      ],
      correctIndex: 0,
      explanation: `It asks students to connect the activity directly to the learning goal.`,
    },
  ];

  if (subjectPeriods.length > 1) {
    const second = subjectPeriods[1];
    questions.push({
      question: `How should students use feedback from ${strip(second.topic) || 'the next period'} to improve their understanding?`,
      options: [
        `Correct one mistake and explain the improved strategy`,
        `Erase all work without discussing it`,
        `Ignore partner or teacher comments`,
        `Memorize the answer without understanding it`,
      ],
      correctIndex: 0,
      explanation: `Using feedback to correct and explain promotes mastery.`,
    });
  }

  if (subjectPeriods.length > 2) {
    const third = subjectPeriods[2];
    questions.push({
      question: `Which exit-ticket prompt best assesses ${strip(third.topic) || topic}?`,
      options: [
        `Solve one new problem and write one sentence explaining the strategy`,
        `Write today's date only`,
        `Copy the objective exactly`,
        `Circle whether the lesson was fun`,
      ],
      correctIndex: 0,
      explanation: `A new problem plus explanation checks both skill and understanding.`,
    });
  }

  return validateGeneratedQuiz({
    title: `${plan.title} — ${subject} Quiz ${quizIndex}`,
    questions,
  });
}

async function createGeneratedQuestion(plan: LessonPlan, quizId: string, q: GeneratedQuestion, orderIndex: number) {
  const questionId = id('q');
  const options = q.options.map((text, index) => ({ label: String.fromCharCode(65 + index), text }));
  const correctAnswer = String.fromCharCode(65 + q.correctIndex);
  const row = {
    id: questionId,
    prompt: q.question,
    type: 'multiple_choice',
    options,
    correctAnswer,
    rubric: q.explanation ?? null,
    teacherId: plan.teacher_id,
    createdAt: new Date().toISOString(),
    source_lesson_plan_id: plan.id,
    source_quiz_id: quizId,
    source_auto_generated: true,
  };
  const { error } = await supabase.from('questions').insert(row);
  if (error) throw error;
  return { questionId, points: 1 };
}

export async function generateLessonPlanQuizzes(planId: string): Promise<Quiz[]> {
  const { data, error } = await supabase.from('lesson_plans').select('*').eq('id', planId).single();
  if (error || !data) throw error || new Error('Plan not found');
  const plan = data as LessonPlan;

  const { data: periodsData, error: periodsError } = await supabase.from('lesson_plan_periods').select('*').eq('plan_id', planId);
  if (periodsError) throw periodsError;
  const dayOrder: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
  const periods = ((periodsData || []) as LessonPlanPeriod[]).sort((a, b) => ((dayOrder[a.day] ?? 99) * 10 + a.period_number) - ((dayOrder[b.day] ?? 99) * 10 + b.period_number));

  await supabase.from('quizzes').delete().eq('lesson_plan_id', planId).eq('auto_generated', true);
  await supabase.from('questions').delete().eq('source_lesson_plan_id', planId).eq('source_auto_generated', true);

  const subjects = unique(periods.filter((p) => !p.is_free && p.subject && p.subject !== '__FREE__').map((p) => p.subject!));
  const created: Quiz[] = [];
  const openDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const subject of subjects) {
    const subjectPeriods = periods.filter((p) => p.subject === subject && !p.is_free);
    if (!subjectPeriods.length) continue;

    for (let quizIndex = 1; quizIndex <= 3; quizIndex += 1) {
      const generated = buildStructuredQuiz(plan, subject, subjectPeriods, quizIndex);
      const quizId = id('quiz');
      const quizRow = {
        id: quizId,
        className: plan.class_name,
        subject,
        title: generated.title,
        description: `Auto-generated from lesson plan ${plan.week_label}.`,
        openDate,
        dueDate,
        timeLimit: 10,
        questionOrder: 'created' as const,
        teacherId: plan.teacher_id,
        status: 'draft' as const,
        createdAt: new Date().toISOString(),
        lesson_plan_id: planId,
        auto_generated: true,
      };
      const { error: quizErr } = await supabase.from('quizzes').insert(quizRow);
      if (quizErr) throw quizErr;
      const quiz = quizRow as Quiz;

      const refs = [];
      for (let i = 0; i < generated.questions.length; i += 1) {
        refs.push(await createGeneratedQuestion(plan, quiz.id, generated.questions[i], i));
      }

      // createQuiz with an empty ref list cannot create junction rows, so insert
      // snapshots after question creation.
      const { data: questions, error: qErr } = await supabase.from('questions').select('*').in('id', refs.map((r) => r.questionId));
      if (qErr) throw qErr;
      const questionMap = new Map((questions || []).map((q) => [q.id, q]));
      const junctionRows = refs.map((ref, i) => {
        const src = questionMap.get(ref.questionId) as any;
        return {
          id: id('qq'),
          quizId: quiz.id,
          questionId: ref.questionId,
          orderIndex: i,
          points: 1,
          promptSnapshot: src.prompt,
          optionsSnapshot: src.options,
          correctAnswerSnapshot: src.correctAnswer,
          typeSnapshot: src.type,
        };
      });
      const { error: jErr } = await supabase.from('quiz_questions').insert(junctionRows);
      if (jErr) throw jErr;
      created.push(quiz);
    }
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

  const rows = questions.map((q) => ({
    id: id('qbank'),
    prompt: q.promptSnapshot,
    type: q.typeSnapshot,
    options: q.optionsSnapshot ?? null,
    correctAnswer: q.correctAnswerSnapshot ?? null,
    rubric: null,
    teacherId: quiz.teacherId,
    createdAt: new Date().toISOString(),
    source_lesson_plan_id: quiz.lesson_plan_id ?? null,
    source_quiz_id: quizId,
    source_auto_generated: false,
  }));
  const { error } = await supabase.from('questions').insert(rows);
  if (error) throw error;
  return 'added';
}
