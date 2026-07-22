import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useRole } from '../../context/RoleContext';
import { getQuizWithQuestions, getAttemptByStudent, startAttempt, saveAnswer, submitAttempt } from '../../lib/db/quizzes';
import { getStudentsByParent } from '../../lib/db/students';
import { useToast } from '../../context/ToastContext';
import { Clock, AlertTriangle, CheckCircle, ArrowLeft } from 'lucide-react';
import { cn } from '../../utils/cn';
import { QuizAttempt } from '../../types';

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

function shuffleChoices(options: { label: string; text: string }[], seed: string): { label: string; text: string }[] {
  return seededShuffle(options, seed);
}

interface TakeQuizProps {
  quizIdOverride?: string;
  studentIdOverride?: string;
  onDone?: () => void;
}

export function TakeQuiz({ quizIdOverride, studentIdOverride, onDone }: TakeQuizProps) {
  const params = useParams<{ quizId: string }>();
  const quizId = quizIdOverride || params.quizId;
  const { session } = useRole();
  const { addToast } = useToast();

  const [quiz, setQuiz] = useState<any>(null);
  const [questions, setQuestions] = useState<any[]>([]);
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load student
  useEffect(() => {
    if (!session) return;
    if (studentIdOverride) { setStudentId(studentIdOverride); return; }
    getStudentsByParent(session.userId).then(students => {
      if (students.length > 0) setStudentId(students[0].id);
    });
  }, [session, studentIdOverride]);

  // Load quiz
  useEffect(() => {
    if (!quizId || !studentId) return;
    const load = async () => {
      const data = await getQuizWithQuestions(quizId);
      if (!data) { addToast({ type: 'error', title: 'Quiz not found' }); return; }
      setQuiz(data.quiz);

      // Check existing attempt
      const existing = await getAttemptByStudent(quizId, studentId);
      if (existing) {
        if (existing.status === 'in_progress') {
          setAttempt(existing);
          const ansMap: Record<string, string> = {};
          for (const a of (existing.answers || []) as any[]) {
            ansMap[a.questionId] = a.answer || '';
          }
          setAnswers(ansMap);
        } else {
          setFinished(true);
          setAttempt(existing);
          return;
        }
      }

      // Shuffle questions per student
      const shuffleSeed = data.quiz.questionOrder === 'randomized'
        ? `${studentId}-${quizId}`
        : 'fixed';
      const shuffled = seededShuffle(data.questions, shuffleSeed);
      setQuestions(shuffled);

      // Shuffle MC choices per question per student
      const qsWithShuffledChoices = shuffled.map(q => ({
        ...q,
        shuffledOptions: q.optionsSnapshot
          ? shuffleChoices(q.optionsSnapshot, `${studentId}-${quizId}-${q.id}`)
          : null,
      }));
      setQuestions(qsWithShuffledChoices);

      // Start timer
      if (data.quiz.timeLimit && !existing) {
        setTimeLeft(data.quiz.timeLimit * 60);
      }
    };
    load();
  }, [quizId, studentId, addToast]);

  // Create attempt
  const handleStart = async () => {
    if (!studentId || !quizId) return;
    try {
      const att = await startAttempt(quizId, studentId, questions);
      setAttempt(att);
    } catch {
      addToast({ type: 'error', title: 'Failed to start quiz' });
    }
  };

  // Timer
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0 || finished) return;
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev === null || prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          handleSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [timeLeft, finished]);

  const handleAnswer = async (questionId: string, answer: string) => {
    setAnswers(prev => ({ ...prev, [questionId]: answer }));
    if (!attempt) return;
    const q = questions.find(q => q.id === questionId);
    if (!q) return;
    await saveAnswer(attempt.id, questionId, answer, q.correctAnswerSnapshot, q.points).catch(() => {});
  };

  const handleSubmit = async () => {
    if (!attempt || submitting) return;
    setSubmitting(true);
    try {
      // Save any unanswered answers as empty
      for (const q of questions) {
        if (!answers[q.id]) {
          await saveAnswer(attempt.id, q.id, '', q.correctAnswerSnapshot, q.points).catch(() => {});
        }
      }
      const updated = await submitAttempt(attempt.id);
      setAttempt(updated);
      if (timerRef.current) clearInterval(timerRef.current);
      setFinished(true);
    } catch {
      addToast({ type: 'error', title: 'Failed to submit quiz' });
    } finally {
      setSubmitting(false);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const currentQuestion = questions[currentIndex];

  if (!quiz) {
    return <div className="text-center py-12 text-slate-400">Loading quiz...</div>;
  }

  if (finished && attempt) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <button onClick={() => onDone ? onDone() : window.history.back()} className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </button>

        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-4">
          <CheckCircle className="w-16 h-16 mx-auto text-green-500" />
          <h2 className="text-2xl font-bold text-slate-900">Quiz Submitted!</h2>
          <p className="text-slate-500">{quiz.title}</p>
          <div className="inline-block bg-slate-50 rounded-2xl p-6">
            <p className="text-4xl font-bold text-indigo-600">{attempt.totalEarned}/{attempt.totalPossible}</p>
            <p className="text-sm text-slate-500 mt-1">Score</p>
          </div>
          {attempt.status === 'submitted' && (
            <p className="text-sm text-amber-600 flex items-center justify-center gap-1">
              <AlertTriangle className="w-4 h-4" />
              Some answers need teacher grading — check back later for full score
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!attempt) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <button onClick={() => onDone ? onDone() : window.history.back()} className="flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-800">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </button>

        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-4">
          <h2 className="text-2xl font-bold text-slate-900">{quiz.title}</h2>
          {quiz.description && <p className="text-slate-500">{quiz.description}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm text-slate-600 max-w-xs mx-auto">
            <div className="bg-slate-50 rounded-xl p-3">
              <p className="font-bold text-slate-900">{questions.length}</p>
              <p className="text-xs">Questions</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <p className="font-bold text-slate-900">{quiz.timeLimit ? `${quiz.timeLimit} min` : 'No limit'}</p>
              <p className="text-xs">Time Limit</p>
            </div>
          </div>
          <button onClick={handleStart}
            className="bg-indigo-600 text-white px-8 py-3 rounded-xl text-sm font-medium hover:bg-indigo-700">
            Start Quiz
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
        <div>
          <h2 className="font-bold text-slate-900">{quiz.title}</h2>
          <p className="text-xs text-slate-500">Question {currentIndex + 1} of {questions.length}</p>
        </div>
        {timeLeft !== null && (
          <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium",
            timeLeft < 60 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'
          )}>
            <Clock className="w-4 h-4" />
            {formatTime(timeLeft)}
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="bg-slate-100 rounded-full h-2 overflow-hidden">
        <div className="bg-indigo-500 h-full rounded-full transition-all duration-300"
          style={{ width: `${((currentIndex + 1) / questions.length) * 100}%` }} />
      </div>

      {/* Question */}
      {currentQuestion && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6">
          <p className="text-lg font-medium text-slate-900 mb-4">{currentQuestion.promptSnapshot}</p>
          <span className="text-xs text-slate-400">{currentQuestion.points} pt{currentQuestion.points > 1 ? 's' : ''}</span>

          {currentQuestion.typeSnapshot === 'multiple_choice' ? (
            <div className="mt-4 space-y-2">
              {(currentQuestion.shuffledOptions || []).map((opt: any) => {
                const selected = answers[currentQuestion.id] === opt.label;
                return (
                  <button key={opt.label}
                    onClick={() => handleAnswer(currentQuestion.id, opt.label)}
                    className={cn(
                      "w-full text-left p-3 rounded-xl border text-sm transition-all",
                      selected
                        ? 'border-indigo-400 bg-indigo-50 text-indigo-700 shadow-[0_0_0_3px_rgba(99,102,241,0.15)]'
                        : 'border-slate-200 hover:border-slate-300 text-slate-700'
                    )}>
                    <span className="font-mono mr-2">{opt.label}</span>
                    {opt.text}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="mt-4">
              <textarea
                value={answers[currentQuestion.id] || ''}
                onChange={e => handleAnswer(currentQuestion.id, e.target.value)}
                placeholder="Type your answer..."
                rows={4}
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm resize-none"
              />
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentIndex(prev => Math.max(0, prev - 1))}
          disabled={currentIndex === 0}
          className="px-4 py-2 rounded-xl text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-30"
        >
          Previous
        </button>

        <div className="flex gap-1">
          {questions.map((_, i) => (
            <button key={i}
              onClick={() => setCurrentIndex(i)}
              className={cn(
                "w-8 h-8 rounded-lg text-xs font-medium transition-colors",
                i === currentIndex && 'bg-indigo-100 text-indigo-700',
                answers[questions[i]?.id] && i !== currentIndex && 'bg-green-100 text-green-700',
                !answers[questions[i]?.id] && i !== currentIndex && 'bg-slate-100 text-slate-400'
              )}>
              {i + 1}
            </button>
          ))}
        </div>

        {currentIndex < questions.length - 1 ? (
          <button
            onClick={() => setCurrentIndex(prev => Math.min(questions.length - 1, prev + 1))}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
          >
            Next
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={submitting}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
            <CheckCircle className="w-4 h-4" />
            {submitting ? 'Submitting...' : 'Submit'}
          </button>
        )}
      </div>
    </div>
  );
}
