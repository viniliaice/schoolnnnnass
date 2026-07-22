import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { supabase } from '../../lib/supabase';
import { getStudentsByParent } from '../../lib/db/students';
import { getQuizzesForStudent } from '../../lib/db/quizzes';
import { Quiz, QuizAttempt } from '../../types';
import { HelpCircle, CheckCircle, Clock, ArrowRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import { TakeQuiz } from './TakeQuiz';

export function ParentQuizzes() {
  const { session } = useRole();
  const [quizzes, setQuizzes] = useState<(Quiz & { attempt?: QuizAttempt | null; studentId: string })[]>([]);
  const [selectedQuizId, setSelectedQuizId] = useState<string | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);

  const loadQuizzes = async () => {
    if (!session) return;
    const students = await getStudentsByParent(session.userId);
    if (students.length === 0) return;

    // Aggregate quizzes across ALL children
    const results = await Promise.all(students.map(s => getQuizzesForStudent(s.id)));
    const seen = new Set<string>();
    const merged: (Quiz & { attempt?: QuizAttempt | null; studentId: string })[] = [];
    results.forEach((qs, i) => {
      qs.forEach(q => {
        if (!seen.has(q.id)) {
          seen.add(q.id);
          merged.push({ ...q, studentId: students[i].id });
        }
      });
    });
    setQuizzes(merged);
  };

  useEffect(() => {
    loadQuizzes();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const channel = supabase
      .channel('parent-quizzes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quiz_attempts' }, loadQuizzes)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quizzes' }, loadQuizzes)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session]);

  const handleDone = () => {
    setSelectedQuizId(null);
    setSelectedStudentId(null);
    loadQuizzes();
  };

  if (selectedQuizId && selectedStudentId) {
    return (
      <div>
        <button onClick={handleDone}
          className="mb-4 text-sm text-indigo-600 hover:text-indigo-800">
          &larr; Back to quizzes
        </button>
        <TakeQuiz quizIdOverride={selectedQuizId} studentIdOverride={selectedStudentId} onDone={handleDone} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Quizzes</h1>
        <p className="text-slate-500 mt-1">Take active quizzes for your children</p>
      </div>

      {quizzes.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
          <HelpCircle className="w-8 h-8 mx-auto text-slate-300 mb-2" />
          <p className="text-slate-500">No active quizzes available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {quizzes.map(q => {
            const attempted = q.attempt && q.attempt.status !== 'in_progress';
            return (
              <div key={q.id} className={cn(
                "bg-white rounded-2xl border p-5",
                attempted ? 'border-slate-200 opacity-70' : 'border-slate-200 hover:border-indigo-200'
              )}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-bold text-slate-900">{q.title}</h3>
                    <p className="text-xs text-slate-500">{q.subject} &middot; {q.className}</p>
                  </div>
                  {q.timeLimit && (
                    <div className="flex items-center gap-1 text-xs text-slate-400">
                      <Clock className="w-3 h-3" />
                      {q.timeLimit} min
                    </div>
                  )}
                </div>

                <p className="text-xs text-slate-500 mb-4">
                  Due: {q.dueDate}
                </p>

                {attempted ? (
                  <div className="flex items-center gap-2 text-sm text-green-600 font-medium">
                    <CheckCircle className="w-4 h-4" />
                    Completed — {q.attempt!.totalEarned}/{q.attempt!.totalPossible}
                  </div>
                ) : (
                  <button onClick={() => { setSelectedQuizId(q.id); setSelectedStudentId(q.studentId); }}
                    className="flex items-center gap-2 text-sm text-indigo-600 font-medium hover:text-indigo-800">
                    Take Quiz
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
