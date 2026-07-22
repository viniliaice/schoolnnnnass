import { supabase } from '../supabase';
import { Question, Quiz, QuizQuestion, QuizAttempt, Exam } from '../../types';
import { createExam } from './exams';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function seededShuffle<T>(arr: T[], seed: string): T[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff;
    const j = hash % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ─── Questions (bank) ───

export async function createQuestion(data: Omit<Question, 'id' | 'createdAt'>): Promise<Question> {
  const row = { id: id('q'), ...data, createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('questions').insert(row).select().single();
  if (error) throw error;
  return created;
}

export async function getQuestionsByTeacher(teacherId: string): Promise<Question[]> {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('teacherId', teacherId)
    .order('createdAt', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateQuestion(id: string, data: Partial<Question>): Promise<void> {
  const { error } = await supabase.from('questions').update(data).eq('id', id);
  if (error) throw error;
}

export async function deleteQuestion(id: string): Promise<void> {
  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) throw error;
}

// ─── Quizzes ───

export async function createQuiz(
  meta: Omit<Quiz, 'id' | 'createdAt' | 'status'>,
  questionRefs: { questionId: string; points: number }[]
): Promise<Quiz> {
  const questions = await supabase.from('questions').select('*').in('id', questionRefs.map(r => r.questionId));
  if (questions.error) throw questions.error;
  const questionMap = new Map((questions.data || []).map(q => [q.id, q]));

  const quizId = id('quiz');
  const quizRow = { id: quizId, ...meta, status: 'draft', createdAt: new Date().toISOString() };

  const { error: quizErr } = await supabase.from('quizzes').insert(quizRow);
  if (quizErr) throw quizErr;

  const junctionRows = questionRefs.map((ref, i) => {
    const src = questionMap.get(ref.questionId);
    if (!src) throw new Error(`Question ${ref.questionId} not found`);
    return {
      id: id('qq'),
      quizId,
      questionId: ref.questionId,
      orderIndex: i,
      points: ref.points,
      promptSnapshot: src.prompt,
      optionsSnapshot: src.options,
      correctAnswerSnapshot: src.correctAnswer,
      typeSnapshot: src.type,
    };
  });

  const { error: jErr } = await supabase.from('quiz_questions').insert(junctionRows);
  if (jErr) throw jErr;

  return { ...quizRow, status: 'draft' as const };
}

export async function getQuizzesByTeacher(teacherId: string): Promise<Quiz[]> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('teacherId', teacherId)
    .order('createdAt', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getQuizzesByClass(className: string): Promise<Quiz[]> {
  const { data, error } = await supabase
    .from('quizzes')
    .select('*')
    .eq('className', className)
    .order('createdAt', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getQuizWithQuestions(quizId: string): Promise<{ quiz: Quiz; questions: QuizQuestion[] } | null> {
  const { data: quiz, error: qErr } = await supabase.from('quizzes').select('*').eq('id', quizId).single();
  if (qErr || !quiz) return null;

  const { data: qq, error: jErr } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('quizId', quizId)
    .order('orderIndex');
  if (jErr) throw jErr;

  return { quiz, questions: qq || [] };
}

export async function updateQuizStatus(quizId: string, status: Quiz['status']): Promise<void> {
  const { error } = await supabase.from('quizzes').update({ status }).eq('id', quizId);
  if (error) throw error;
}

export async function deleteQuiz(quizId: string): Promise<void> {
  const { error } = await supabase.from('quizzes').delete().eq('id', quizId);
  if (error) throw error;
}

// ─── Attempts ───

export async function getActiveQuizForStudent(studentId: string, quizId: string): Promise<QuizAttempt | null> {
  const { data, error } = await supabase
    .from('quiz_attempts')
    .select('*')
    .eq('quizId', quizId)
    .eq('studentId', studentId)
    .eq('status', 'in_progress')
    .maybeSingle();
  if (error) throw error;
  return data as QuizAttempt | null;
}

export async function getAttemptByStudent(quizId: string, studentId: string): Promise<QuizAttempt | null> {
  const { data, error } = await supabase
    .from('quiz_attempts')
    .select('*')
    .eq('quizId', quizId)
    .eq('studentId', studentId)
    .maybeSingle();
  if (error) throw error;
  return data as QuizAttempt | null;
}

export async function startAttempt(quizId: string, studentId: string, questions: QuizQuestion[]): Promise<QuizAttempt> {
  const row = {
    id: id('qa'),
    quizId,
    studentId,
    answers: questions.map(q => ({ questionId: q.id, answer: '', pointsEarned: null, isCorrect: null })),
    totalEarned: 0,
    totalPossible: questions.reduce((s, q) => s + q.points, 0),
    startedAt: new Date().toISOString(),
    submittedAt: null,
    status: 'in_progress',
  };
  const { data, error } = await supabase.from('quiz_attempts').insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function saveAnswer(
  attemptId: string,
  questionId: string,
  answer: string,
  correctAnswer: string | null,
  points: number
): Promise<void> {
  const { data: attempt, error: fetchErr } = await supabase
    .from('quiz_attempts')
    .select('answers, totalEarned')
    .eq('id', attemptId)
    .single();
  if (fetchErr) throw fetchErr;

  const isCorrect = correctAnswer !== null ? answer === correctAnswer : null;
  const pointsEarned = isCorrect === true ? points : isCorrect === false ? 0 : null;

  const answers = (attempt.answers || []).map((a: any) =>
    a.questionId === questionId ? { ...a, answer, pointsEarned, isCorrect } : a
  );

  const totalEarned = (answers as any[]).reduce((s: number, a: any) => s + (a.pointsEarned || 0), 0);

  const { error } = await supabase
    .from('quiz_attempts')
    .update({ answers, totalEarned })
    .eq('id', attemptId);
  if (error) throw error;
}

export async function submitAttempt(attemptId: string): Promise<QuizAttempt> {
  const { data: attempt, error: fetchErr } = await supabase
    .from('quiz_attempts')
    .select('*')
    .eq('id', attemptId)
    .single();
  if (fetchErr) throw fetchErr;

  const answers = (attempt.answers || []).map((a: any) => {
    if (a.pointsEarned === null) {
      return { ...a, pointsEarned: 0, isCorrect: false };
    }
    return a;
  });
  const totalEarned = answers.reduce((s: number, a: any) => s + (a.pointsEarned || 0), 0);
  const hasDirect = answers.some((a: any) => a.isCorrect === null);

  const { data, error } = await supabase
    .from('quiz_attempts')
    .update({
      answers,
      totalEarned,
      submittedAt: new Date().toISOString(),
      status: hasDirect ? 'submitted' : 'graded',
    })
    .eq('id', attemptId)
    .select()
    .single();
  if (error) throw error;

  if (!hasDirect) {
    await syncAttemptToExam(data);
  }

  return data;
}

async function syncAttemptToExam(attempt: QuizAttempt): Promise<void> {
  const { data: quiz, error: quizErr } = await supabase
    .from('quizzes')
    .select('className, subject')
    .eq('id', attempt.quizId)
    .single();
  if (quizErr) return;

  const month = new Date().toLocaleString('en-US', { month: 'long' });
  const examData = {
    studentId: attempt.studentId,
    subject: quiz.subject,
    score: attempt.totalEarned,
    total: attempt.totalPossible,
    examType: 'Quiz' as const,
    month,
    status: 'pending' as const,
    parentId: null,
    date: new Date().toISOString().split('T')[0],
    teacherId: '',
  };

  try {
    await createExam(examData as any);
  } catch {
    // retry not needed — next sync attempt will pick it up
  }
}

// ─── Grading (teacher grades direct answers) ───

export async function getQuizzesWithPendingGrading(teacherId: string): Promise<{ quizId: string; title: string; subject: string; className: string; pendingCount: number }[]> {
  const { data: quizzes, error: qErr } = await supabase
    .from('quizzes')
    .select('id, title, subject, className')
    .eq('teacherId', teacherId);
  if (qErr) throw qErr;
  if (!quizzes || quizzes.length === 0) return [];

  const quizIds = quizzes.map(q => q.id);
  const { data: attempts } = await supabase
    .from('quiz_attempts')
    .select('quizId')
    .in('quizId', quizIds)
    .eq('status', 'submitted');

  const pendingCounts = new Map<string, number>();
  for (const a of (attempts || [])) {
    pendingCounts.set(a.quizId, (pendingCounts.get(a.quizId) || 0) + 1);
  }

  return quizzes
    .filter(q => (pendingCounts.get(q.id) || 0) > 0)
    .map(q => ({
      quizId: q.id,
      title: q.title,
      subject: q.subject,
      className: q.className,
      pendingCount: pendingCounts.get(q.id) || 0,
    }));
}

export async function getAttemptsForGrading(quizId: string): Promise<(QuizAttempt & { studentName?: string })[]> {
  const { data: attempts, error: aErr } = await supabase
    .from('quiz_attempts')
    .select('*')
    .eq('quizId', quizId)
    .in('status', ['submitted', 'graded'])
    .order('submittedAt', { ascending: true });
  if (aErr) throw aErr;

  const studentIds = [...new Set((attempts || []).map(a => a.studentId))];
  if (studentIds.length === 0) return [];
  const { data: students } = await supabase.from('students').select('id, name').in('id', studentIds);
  const nameMap = new Map((students || []).map(s => [s.id, s.name]));

  return (attempts || []).map(a => ({ ...a, studentName: nameMap.get(a.studentId) || '' }));
}

export async function gradeDirectAnswer(
  attemptId: string,
  questionId: string,
  score: number,
  feedback: string
): Promise<void> {
  const { data: attempt, error: fetchErr } = await supabase
    .from('quiz_attempts')
    .select('answers, quizId')
    .eq('id', attemptId)
    .single();
  if (fetchErr) throw fetchErr;

  const answers = (attempt.answers || []).map((a: any) =>
    a.questionId === questionId ? { ...a, pointsEarned: score, isCorrect: score > 0, feedback } : a
  );
  const totalEarned = answers.reduce((s: number, a: any) => s + (a.pointsEarned || 0), 0);
  const allGraded = answers.every((a: any) => a.pointsEarned !== null);

  const updates: any = { answers, totalEarned };
  if (allGraded) updates.status = 'graded';

  const { error } = await supabase.from('quiz_attempts').update(updates).eq('id', attemptId);
  if (error) throw error;

  if (allGraded) {
    const { data: updated } = await supabase.from('quiz_attempts').select('*').eq('id', attemptId).single();
    if (updated) await syncAttemptToExam(updated);
  }
}

// ─── Parent dashboard ───

export async function getQuizzesForStudent(studentId: string): Promise<(Quiz & { attempt?: QuizAttempt | null })[]> {
  const { data: student, error: sErr } = await supabase
    .from('students')
    .select('className')
    .eq('id', studentId)
    .single();
  if (sErr || !student) return [];

  const today = new Date().toISOString().split('T')[0];

  const { data: quizzes, error: qErr } = await supabase
    .from('quizzes')
    .select('*')
    .eq('className', student.className)
    .in('status', ['active', 'closed'])
    .lte('openDate', today)
    .order('dueDate');
  if (qErr) throw qErr;

  const { data: attempts } = await supabase
    .from('quiz_attempts')
    .select('*')
    .eq('studentId', studentId);
  const attemptMap = new Map((attempts || []).map(a => [a.quizId, a]));

  return (quizzes || []).map(q => ({ ...q, attempt: attemptMap.get(q.id) || null }));
}
