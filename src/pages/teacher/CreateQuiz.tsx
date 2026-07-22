import { useState, useEffect, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById } from '../../lib/db/profiles';
import { getClasses } from '../../lib/db/classes';
import { getSubjects } from '../../lib/db/subjects';
import { getClassSubjectsForTeacher } from '../../lib/db/classes';
import {
  createQuestion, getQuestionsByTeacher, createQuiz,
  getQuizzesByTeacher, updateQuizStatus, deleteQuiz
} from '../../lib/db/quizzes';
import { Question, Subject } from '../../types';
import { useToast } from '../../context/ToastContext';
import { BookOpen, CheckCircle, ChevronRight, Plus, Trash2, X, HelpCircle, ListChecks, Play, Pause } from 'lucide-react';
import { cn } from '../../utils/cn';

type Step = 'config' | 'questions' | 'review';
type Tab = 'create' | 'manage';

interface QuestionPick {
  questionId: string;
  prompt: string;
  type: string;
  points: number;
}

export function CreateQuiz() {
  const { session } = useRole();
  const { addToast } = useToast();

  const [tab, setTab] = useState<Tab>('create');
  const [step, setStep] = useState<Step>('config');

  // Config
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [openDate, setOpenDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [timeLimit, setTimeLimit] = useState('');
  const [questionOrder, setQuestionOrder] = useState<'created' | 'randomized'>('randomized');

  // Question bank
  const [bankQuestions, setBankQuestions] = useState<Question[]>([]);
  const [pickedQuestions, setPickedQuestions] = useState<QuestionPick[]>([]);

  // Create new question modal
  const [showNewQuestion, setShowNewQuestion] = useState(false);
  const [newQPrompt, setNewQPrompt] = useState('');
  const [newQType, setNewQType] = useState<'multiple_choice' | 'direct_answer'>('multiple_choice');
  const [newQOptions, setNewQOptions] = useState([{ label: 'A', text: '' }, { label: 'B', text: '' }]);
  const [newQCorrect, setNewQCorrect] = useState('');
  const [newQRubric, setNewQRubric] = useState('');

  // Manage tab
  const [createdQuizzes, setCreatedQuizzes] = useState<any[]>([]);

  // Saving states
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!session) return;
    const load = async () => {
      if (session.role === 'teacher' || session.role === 'supervisor') {
        const me = await getUserById(session.userId);
        const cls = (me?.assignedClasses || []) as string[];
        setClasses(cls);
        if (cls.length > 0) setSelectedClass(cls[0]);
      } else {
        const all = await getClasses();
        setClasses(all);
        if (all.length > 0) setSelectedClass(all[0]);
      }
    };
    load();
  }, [session]);

  useEffect(() => {
    if (!session || !selectedClass) return;
    const load = async () => {
      if (session.role === 'admin') {
        const all = await getSubjects();
        setSubjects(all);
        if (all.length > 0) setSelectedSubject(all[0].id);
      } else {
        const subs = await getClassSubjectsForTeacher(session.userId, selectedClass);
        setSubjects(subs);
        if (subs.length > 0) setSelectedSubject(subs[0].id);
      }
    };
    load();
  }, [session, selectedClass]);

  const loadBank = useCallback(async () => {
    if (!session) return;
    const qs = await getQuestionsByTeacher(session.userId);
    setBankQuestions(qs);
  }, [session]);

  useEffect(() => {
    if (tab === 'create' && session) loadBank();
  }, [tab, session, loadBank]);

  const loadQuizzes = useCallback(async () => {
    if (!session) return;
    const qs = await getQuizzesByTeacher(session.userId);
    setCreatedQuizzes(qs);
  }, [session]);

  useEffect(() => {
    if (tab === 'manage' && session) loadQuizzes();
  }, [tab, session, loadQuizzes]);

  const addOption = () => {
    const label = String.fromCharCode(65 + newQOptions.length);
    setNewQOptions(prev => [...prev, { label, text: '' }]);
  };

  const removeOption = (label: string) => {
    setNewQOptions(prev => prev.filter(o => o.label !== label));
    if (newQCorrect === label) setNewQCorrect('');
  };

  const updateOption = (label: string, text: string) => {
    setNewQOptions(prev => prev.map(o => o.label === label ? { ...o, text } : o));
  };

  const handleCreateQuestion = async () => {
    if (!session || !newQPrompt.trim()) {
      addToast({ type: 'error', title: 'Prompt is required' });
      return;
    }
    if (newQType === 'multiple_choice') {
      if (newQOptions.some(o => !o.text.trim())) {
        addToast({ type: 'error', title: 'All options must have text' });
        return;
      }
      if (!newQCorrect) {
        addToast({ type: 'error', title: 'Select the correct answer' });
        return;
      }
    }
    try {
      const q = await createQuestion({
        prompt: newQPrompt.trim(),
        type: newQType,
        options: newQType === 'multiple_choice' ? newQOptions : null,
        correctAnswer: newQType === 'multiple_choice' ? newQCorrect : null,
        rubric: newQRubric.trim() || null,
        teacherId: session.userId,
      });
      setBankQuestions(prev => [q, ...prev]);
      setShowNewQuestion(false);
      setNewQPrompt('');
      setNewQType('multiple_choice');
      setNewQOptions([{ label: 'A', text: '' }, { label: 'B', text: '' }]);
      setNewQCorrect('');
      setNewQRubric('');
      addToast({ type: 'success', title: 'Question created' });
    } catch {
      addToast({ type: 'error', title: 'Failed to create question' });
    }
  };

  const togglePick = (q: Question) => {
    setPickedQuestions(prev => {
      const exists = prev.find(p => p.questionId === q.id);
      if (exists) return prev.filter(p => p.questionId !== q.id);
      return [...prev, { questionId: q.id, prompt: q.prompt, type: q.type, points: 1 }];
    });
  };

  const updatePoints = (questionId: string, points: number) => {
    setPickedQuestions(prev => prev.map(p => p.questionId === questionId ? { ...p, points } : p));
  };

  const getSubjectName = () => subjects.find(s => s.id === selectedSubject)?.name || '';

  const handleCreateQuiz = async () => {
    if (!session) return;
    if (!title.trim()) { addToast({ type: 'error', title: 'Title is required' }); return; }
    if (!openDate) { addToast({ type: 'error', title: 'Open date is required' }); return; }
    if (!dueDate) { addToast({ type: 'error', title: 'Due date is required' }); return; }
    if (pickedQuestions.length === 0) { addToast({ type: 'error', title: 'Add at least one question' }); return; }

    setSaving(true);
    try {
      await createQuiz({
        className: selectedClass,
        subject: getSubjectName(),
        title: title.trim(),
        description: description.trim() || null,
        openDate,
        dueDate,
        timeLimit: timeLimit ? parseInt(timeLimit) : null,
        questionOrder,
        teacherId: session.userId,
      }, pickedQuestions.map(p => ({ questionId: p.questionId, points: p.points })));
      addToast({ type: 'success', title: 'Quiz created' });
      setTitle('');
      setDescription('');
      setOpenDate('');
      setDueDate('');
      setTimeLimit('');
      setPickedQuestions([]);
      setStep('config');
    } catch {
      addToast({ type: 'error', title: 'Failed to create quiz' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (quizId: string, currentStatus: string) => {
    const next = currentStatus === 'draft' ? 'active' : currentStatus === 'active' ? 'closed' : 'active';
    try {
      await updateQuizStatus(quizId, next as any);
      addToast({ type: 'success', title: `Quiz ${next}` });
      loadQuizzes();
    } catch {
      addToast({ type: 'error', title: 'Failed to update status' });
    }
  };

  const handleDeleteQuiz = async (quizId: string) => {
    try {
      await deleteQuiz(quizId);
      addToast({ type: 'success', title: 'Quiz deleted' });
      loadQuizzes();
    } catch {
      addToast({ type: 'error', title: 'Failed to delete quiz' });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Create Quiz</h1>
        <p className="text-slate-500 mt-1">Build quizzes using your question bank</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setTab('create')}
          className={cn("px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
            tab === 'create' ? 'bg-white text-indigo-600 border border-b-0 border-slate-200 -mb-[3px]' : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <Plus className="w-4 h-4 inline mr-1" />
          New Quiz
        </button>
        <button
          onClick={() => setTab('manage')}
          className={cn("px-4 py-2 text-sm font-medium rounded-t-lg transition-colors",
            tab === 'manage' ? 'bg-white text-indigo-600 border border-b-0 border-slate-200 -mb-[3px]' : 'text-slate-500 hover:text-slate-700'
          )}
        >
          <ListChecks className="w-4 h-4 inline mr-1" />
          Manage Quizzes
        </button>
      </div>

      {tab === 'create' && (
        <>
          {/* Step indicator */}
          <div className="flex items-center gap-2">
            {[
              { key: 'config' as Step, label: 'Configure', icon: BookOpen },
              { key: 'questions' as Step, label: 'Questions', icon: HelpCircle },
              { key: 'review' as Step, label: 'Review', icon: CheckCircle },
            ].map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
                <button
                  onClick={() => s.key !== 'review' && setStep(s.key)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                    step === s.key
                      ? 'bg-indigo-100 text-indigo-700 ring-2 ring-offset-1 ring-indigo-200'
                      : step === 'config' || step === 'questions'
                        ? 'bg-white text-slate-400 border border-slate-200'
                        : 'bg-white text-slate-400 border border-slate-200'
                  )}
                >
                  <s.icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{s.label}</span>
                </button>
              </div>
            ))}
          </div>

          {step === 'config' && (
            <div className="max-w-3xl">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
                <h2 className="text-lg font-bold text-slate-800">Quiz Settings</h2>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Class</label>
                  <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                    {classes.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Subject</label>
                  <select value={selectedSubject} onChange={e => setSelectedSubject(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                    {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Title *</label>
                  <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                    placeholder="e.g., Math Quiz — Addition" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                </div>

                <div>
                  <label className="text-sm font-semibold text-slate-700 mb-2 block">Description</label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="Quiz instructions or notes..." rows={2}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none" />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Open Date *</label>
                    <input type="date" value={openDate} onChange={e => setOpenDate(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Due Date *</label>
                    <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Time Limit (minutes)</label>
                    <input type="number" value={timeLimit} onChange={e => setTimeLimit(e.target.value)}
                      placeholder="Optional" min="1" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">Question Order</label>
                    <select value={questionOrder} onChange={e => setQuestionOrder(e.target.value as any)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                      <option value="randomized">Randomized per student</option>
                      <option value="created">As created</option>
                    </select>
                  </div>
                </div>

                <button onClick={() => setStep('questions')}
                  className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700">
                  Next: Add Questions
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 'questions' && (
            <div className="space-y-6">
              {/* Question bank */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-slate-800">Question Bank</h2>
                  <button onClick={() => setShowNewQuestion(true)}
                    className="flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
                    <Plus className="w-4 h-4" />
                    New Question
                  </button>
                </div>

                {bankQuestions.length === 0 && (
                  <p className="text-slate-400 text-sm py-4 text-center">No questions yet. Create your first question.</p>
                )}

                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {bankQuestions.map(q => {
                    const picked = pickedQuestions.some(p => p.questionId === q.id);
                    return (
                      <div key={q.id} onClick={() => togglePick(q)}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors",
                          picked ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                        )}>
                        <input type="checkbox" checked={picked} onChange={() => {}} className="rounded border-slate-300" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate">{q.prompt}</p>
                          <p className="text-xs text-slate-500">{q.type === 'multiple_choice' ? 'Multiple Choice' : 'Direct Answer'}</p>
                        </div>
                        {picked && (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-slate-500">Points:</span>
                            <input type="number" min={1} value={pickedQuestions.find(p => p.questionId === q.id)?.points || 1}
                              onClick={e => e.stopPropagation()}
                              onChange={e => { e.stopPropagation(); updatePoints(q.id, parseInt(e.target.value) || 1); }}
                              className="w-16 rounded border border-slate-300 px-2 py-1 text-xs text-center" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Picked questions summary */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5">
                <h2 className="text-lg font-bold text-slate-800 mb-3">
                  Selected Questions ({pickedQuestions.length})
                </h2>
                {pickedQuestions.length === 0 ? (
                  <p className="text-slate-400 text-sm">Check questions from the bank above.</p>
                ) : (
                  <div className="space-y-2">
                    {pickedQuestions.map((p, i) => (
                      <div key={p.questionId} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400 font-mono w-5">{i + 1}.</span>
                          <span className="text-sm text-slate-900 truncate max-w-md">{p.prompt}</span>
                          <span className="text-xs text-slate-400">({p.points} pts)</span>
                        </div>
                        <button onClick={() => togglePick(bankQuestions.find(q => q.id === p.questionId)!)}
                          className="text-red-400 hover:text-red-600">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-3 mt-4">
                  <button onClick={() => setStep('config')}
                    className="px-4 py-2 rounded-xl text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">
                    Back
                  </button>
                  <button onClick={() => pickedQuestions.length === 0 ? addToast({ type: 'error', title: 'Select at least one question' }) : setStep('review')}
                    className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700">
                    Next: Review
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'review' && (
            <div className="max-w-3xl">
              <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
                <h2 className="text-lg font-bold text-slate-800">Review Quiz</h2>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-slate-500">Class:</span> <span className="font-medium">{selectedClass}</span></div>
                  <div><span className="text-slate-500">Subject:</span> <span className="font-medium">{getSubjectName()}</span></div>
                  <div><span className="text-slate-500">Open:</span> <span className="font-medium">{openDate}</span></div>
                  <div><span className="text-slate-500">Due:</span> <span className="font-medium">{dueDate}</span></div>
                  <div><span className="text-slate-500">Time Limit:</span> <span className="font-medium">{timeLimit ? `${timeLimit} min` : 'None'}</span></div>
                  <div><span className="text-slate-500">Order:</span> <span className="font-medium">{questionOrder === 'randomized' ? 'Randomized' : 'As created'}</span></div>
                </div>

                <div>
                  <h3 className="font-semibold text-slate-700 mb-2">Questions ({pickedQuestions.length})</h3>
                  <div className="space-y-1">
                    {pickedQuestions.map((p, i) => (
                      <div key={p.questionId} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg text-sm">
                        <span>{i + 1}. {p.prompt}</span>
                        <span className="text-xs text-slate-500">{p.points} pt{p.points !== 1 ? 's' : ''}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm text-slate-500 mt-2">Total: {pickedQuestions.reduce((s, p) => s + p.points, 0)} points</p>
                </div>

                <div className="flex items-center gap-3">
                  <button onClick={() => setStep('questions')}
                    className="px-4 py-2 rounded-xl text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">
                    Back
                  </button>
                  <button onClick={handleCreateQuiz} disabled={saving}
                    className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
                    <CheckCircle className="w-4 h-4" />
                    {saving ? 'Creating...' : 'Create Quiz'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'manage' && (
        <div className="space-y-4">
          {createdQuizzes.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
              <ListChecks className="w-8 h-8 mx-auto text-slate-300 mb-2" />
              <p className="text-slate-500">No quizzes created yet.</p>
            </div>
          )}
          {createdQuizzes.map(q => (
            <div key={q.id} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-slate-900">{q.title}</h3>
                <p className="text-xs text-slate-500">{q.subject} • {q.className} • {q.openDate} → {q.dueDate}</p>
                <span className={cn(
                  "inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium",
                  q.status === 'draft' && 'bg-slate-100 text-slate-600',
                  q.status === 'active' && 'bg-green-100 text-green-700',
                  q.status === 'closed' && 'bg-red-100 text-red-600'
                )}>{q.status}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggleStatus(q.id, q.status)}
                  className="p-2 rounded-lg text-indigo-500 hover:bg-indigo-50 transition-colors" title="Toggle status">
                  {q.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                <button onClick={() => handleDeleteQuiz(q.id)}
                  className="p-2 rounded-lg text-red-500 hover:bg-red-50 transition-colors" title="Delete quiz">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New question modal */}
      {showNewQuestion && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setShowNewQuestion(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">New Question</h2>
              <button onClick={() => setShowNewQuestion(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Type</label>
              <select value={newQType} onChange={e => setNewQType(e.target.value as any)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
                <option value="multiple_choice">Multiple Choice</option>
                <option value="direct_answer">Direct Answer</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Prompt *</label>
              <textarea value={newQPrompt} onChange={e => setNewQPrompt(e.target.value)}
                placeholder="Enter the question text..." rows={2}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none" />
            </div>

            {newQType === 'multiple_choice' && (
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-700 block">Options</label>
                {newQOptions.map(o => (
                  <div key={o.label} className="flex items-center gap-2">
                    <input type="radio" name="correct" checked={newQCorrect === o.label}
                      onChange={() => setNewQCorrect(o.label)} className="text-indigo-600" title="Correct answer" />
                    <span className="text-sm font-mono text-slate-500 w-5">{o.label}</span>
                    <input type="text" value={o.text} onChange={e => updateOption(o.label, e.target.value)}
                      placeholder={`Option ${o.label}`} className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm" />
                    {newQOptions.length > 2 && (
                      <button onClick={() => removeOption(o.label)} className="text-red-400 hover:text-red-600">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button onClick={addOption} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                  + Add option
                </button>
              </div>
            )}

            {newQType === 'direct_answer' && (
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-2 block">Grading Rubric</label>
                <textarea value={newQRubric} onChange={e => setNewQRubric(e.target.value)}
                  placeholder="What to look for in a correct answer..." rows={2}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none" />
              </div>
            )}

            <button onClick={handleCreateQuestion}
              className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700">
              Save Question
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
