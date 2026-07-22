import { useState, useEffect, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { supabase } from '../../lib/supabase';
import { getQuizzesWithPendingGrading, getAttemptsForGrading, getQuizWithQuestions, gradeDirectAnswer } from '../../lib/db/quizzes';
import { QuizAttempt, QuizQuestion } from '../../types';
import { useToast } from '../../context/ToastContext';
import { CheckCircle, ChevronRight, ClipboardCheck, Users, ArrowLeft } from 'lucide-react';
import { cn } from '../../utils/cn';

type View = 'list' | 'students' | 'grade';

export function GradeQuizzes() {
  const { session } = useRole();
  const { addToast } = useToast();

  const [quizzes, setQuizzes] = useState<{ quizId: string; title: string; subject: string; className: string; pendingCount: number }[]>([]);
  const [selectedQuiz, setSelectedQuiz] = useState<any>(null);
  const [attempts, setAttempts] = useState<(QuizAttempt & { studentName?: string })[]>([]);
  const [selectedAttempt, setSelectedAttempt] = useState<QuizAttempt & { studentName?: string } | null>(null);
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>([]);
  const [grades, setGrades] = useState<Record<string, { score: number; feedback: string }>>({});
  const [view, setView] = useState<View>('list');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    getQuizzesWithPendingGrading(session.userId).then(setQuizzes);
    const channel = supabase
      .channel('grade-quizzes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quiz_attempts' }, () =>
        getQuizzesWithPendingGrading(session.userId).then(setQuizzes)
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session]);

  const openQuiz = async (quiz: { quizId: string }) => {
    const qq = await getQuizWithQuestions(quiz.quizId);
    if (!qq) return;
    setSelectedQuiz(qq.quiz);
    const atts = await getAttemptsForGrading(quiz.quizId);
    setAttempts(atts);
    setQuizQuestions(qq.questions);
    setView('students');
  };

  const openStudent = (attempt: QuizAttempt & { studentName?: string }) => {
    setSelectedAttempt(attempt);
    const initialGrades: Record<string, { score: number; feedback: string }> = {};
    for (const a of (attempt.answers || []) as any[]) {
      initialGrades[a.questionId] = { score: a.pointsEarned || 0, feedback: a.feedback || '' };
    }
    setGrades(initialGrades);
    setView('grade');
  };

  const setGrade = (questionId: string, field: 'score' | 'feedback', value: string) => {
    setGrades(prev => ({
      ...prev,
      [questionId]: { ...prev[questionId], [field]: field === 'score' ? parseInt(value) || 0 : value },
    }));
  };

  const handleSubmitGrade = async () => {
    if (!selectedAttempt) return;
    setSaving(true);
    try {
      const directQuestions = quizQuestions.filter(q => q.typeSnapshot === 'direct_answer');
      for (const q of directQuestions) {
        const g = grades[q.id];
        if (g) {
          await gradeDirectAnswer(selectedAttempt.id, q.id, g.score, g.feedback);
        }
      }
      addToast({ type: 'success', title: 'Grades saved' });
      setView('students');
      const atts = await getAttemptsForGrading(selectedQuiz!.id);
      setAttempts(atts);
    } catch {
      addToast({ type: 'error', title: 'Failed to save grades' });
    } finally {
      setSaving(false);
    }
  };

  const getQuestionForAnswer = (questionId: string) =>
    quizQuestions.find(q => q.id === questionId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Grade Quizzes</h1>
        <p className="text-slate-500 mt-1">Review and grade student quiz submissions</p>
      </div>

      {view === 'list' && (
        <div className="space-y-4">
          {quizzes.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
              <ClipboardCheck className="w-8 h-8 mx-auto text-slate-300 mb-2" />
              <p className="text-slate-500">No quizzes with pending submissions.</p>
            </div>
          )}
          {quizzes.map(q => (
            <div key={q.quizId} onClick={() => openQuiz(q)}
              className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between cursor-pointer hover:border-indigo-200 transition-colors">
              <div>
                <h3 className="font-semibold text-slate-900">{q.title}</h3>
                <p className="text-xs text-slate-500">{q.subject} • {q.className}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-amber-600">{q.pendingCount} pending</span>
                <ChevronRight className="w-4 h-4 text-slate-300" />
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'students' && selectedQuiz && (
        <div className="space-y-4">
          <button onClick={() => setView('list')}
            className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800">
            <ArrowLeft className="w-4 h-4" /> Back to quizzes
          </button>
          <h2 className="text-lg font-bold text-slate-800">{selectedQuiz.title} — Submissions</h2>

          {attempts.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
              <Users className="w-8 h-8 mx-auto text-slate-300 mb-2" />
              <p className="text-slate-500">No submissions yet.</p>
            </div>
          )}
          {attempts.map(a => (
            <div key={a.id} onClick={() => openStudent(a)}
              className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between cursor-pointer hover:border-indigo-200 transition-colors">
              <div>
                <p className="font-medium text-slate-900">{a.studentName || a.studentId}</p>
                <p className="text-xs text-slate-500">
                  Score: {a.totalEarned}/{a.totalPossible} • Status: {a.status}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-300" />
            </div>
          ))}
        </div>
      )}

      {view === 'grade' && selectedAttempt && (
        <div className="max-w-3xl space-y-4">
          <button onClick={() => setView('students')}
            className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800">
            <ArrowLeft className="w-4 h-4" /> Back to students
          </button>

          <h2 className="text-lg font-bold text-slate-800">
            {selectedAttempt.studentName || selectedAttempt.studentId}
          </h2>

          {quizQuestions.map((q, i) => {
            const answer = (selectedAttempt.answers || []).find((a: any) => a.questionId === q.id);
            const isDirect = q.typeSnapshot === 'direct_answer';
            return (
              <div key={q.id} className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-medium text-slate-900">Q{i + 1}. {q.promptSnapshot}</h3>
                  <span className="text-xs text-slate-400">{q.points} pts</span>
                </div>

                {q.typeSnapshot === 'multiple_choice' ? (
                  <div className="space-y-1">
                    {(q.optionsSnapshot || []).map((opt: any) => {
                      const isSelected = answer?.answer === opt.label;
                      const isCorrectAnswer = q.correctAnswerSnapshot === opt.label;
                      return (
                        <div key={opt.label} className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-lg text-sm",
                          isSelected && isCorrectAnswer && 'bg-green-50 text-green-700 border border-green-200',
                          isSelected && !isCorrectAnswer && 'bg-red-50 text-red-700 border border-red-200',
                          !isSelected && isCorrectAnswer && 'bg-green-50/50 text-green-600',
                          !isSelected && !isCorrectAnswer && 'bg-slate-50 text-slate-600'
                        )}>
                          <span className="font-mono text-xs w-5">{opt.label}</span>
                          <span>{opt.text}</span>
                          {isSelected && <span className="text-xs ml-auto font-medium">Selected</span>}
                          {isCorrectAnswer && <span className="text-xs ml-auto font-medium text-green-600">Correct</span>}
                        </div>
                      );
                    })}
                    <p className="text-xs text-slate-400 mt-2">
                      {answer?.isCorrect ? 'Correct' : 'Incorrect'} • +{answer?.pointsEarned || 0}/{q.points} pts
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-slate-50 p-3 rounded-lg">
                      <p className="text-xs text-slate-500 mb-1">Student's answer:</p>
                      <p className="text-sm text-slate-900">{answer?.answer || '(no answer)'}</p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-semibold text-slate-700 block mb-1">Score (out of {q.points})</label>
                        <input type="number" min={0} max={q.points}
                          value={grades[q.id]?.score || 0}
                          onChange={e => setGrade(q.id, 'score', e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-slate-700 block mb-1">Feedback</label>
                        <input type="text"
                          value={grades[q.id]?.feedback || ''}
                          onChange={e => setGrade(q.id, 'feedback', e.target.value)}
                          placeholder="Optional feedback..."
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {quizQuestions.some(q => q.typeSnapshot === 'direct_answer') && (
            <button onClick={handleSubmitGrade} disabled={saving}
              className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              <CheckCircle className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Grades'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
