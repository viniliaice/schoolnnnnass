import { useState, useEffect, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById, getStudentsByClasses, bulkCreateExams, getCurrentTerm, getSubjects, getClassSubjectsForTeacher, upsertReportComment, getClassAssignmentsForTeacher } from '../../lib/database';
import { ExamType, EXAM_TYPES, MONTHS, SUBJECTS, Term, Subject } from '../../types';
import { Dialog } from '../../components/ui/Dialog';
import { useToast } from '../../context/ToastContext';
import {
  Upload, CheckCircle, ChevronRight, ChevronLeft, Users,
  ClipboardList, Sparkles, AlertCircle, RotateCcw
} from 'lucide-react';
import { cn } from '../../utils/cn';

interface StudentScore {
  studentId: string;
  studentName: string;
  className: string;
  parentId: string;
  score: string;
  included: boolean;
  comment?: string;
}

type Step = 'config' | 'scores' | 'review';

export function UploadResults() {
    // DEBUG: Log all class_subjects rows
    const handleDebugClassSubjects = async () => {
      await logAllClassSubjects();
      addToast({ type: 'info', title: 'Check console for class_subjects rows' });
    };
  const { session } = useRole();
  const { addToast } = useToast();

  // Config state
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  // subject state removed in favor of `selectedSubject` (id)
  const [examType, setExamType] = useState<ExamType>('CA');
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [total, setTotal] = useState('100');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  // New state for term and subject
  const [currentTerm, setCurrentTerm] = useState<Term | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubject, setSelectedSubject] = useState('');

  // Grid state
  const [studentScores, setStudentScores] = useState<StudentScore[]>([]);
  const [step, setStep] = useState<Step>('config');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Per-exam comment modal state
  const [commentModalOpen, setCommentModalOpen] = useState(false);
  const [commentingStudentId, setCommentingStudentId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  // Quick fill
  const [quickFillValue, setQuickFillValue] = useState('');

  useEffect(() => {
    if (!session) return;
    const loadData = async () => {
      // Get all class/subject assignments for this teacher
      const assignments = await getClassAssignmentsForTeacher(session.userId);
      const uniqueClasses = Array.from(new Set(assignments.map(a => a.className)));
      setClasses(uniqueClasses);
      if (uniqueClasses.length > 0) setSelectedClass(uniqueClasses[0]);

      // Load current term
      const term = await getCurrentTerm();
      setCurrentTerm(term);

      // Set subjects for the first class (if any)
      if (uniqueClasses.length > 0) {
        const classSubs = await getClassSubjectsForTeacher(session.userId, uniqueClasses[0]);
        setSubjects(classSubs);
        if (classSubs.length > 0) setSelectedSubject(classSubs[0].id);
      } else {
        setSubjects([]);
        setSelectedSubject('');
      }
    };
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const loadStudents = useCallback(async () => {
    if (!selectedClass) return;
    const students = await getStudentsByClasses([selectedClass]);
    setStudentScores(
      students.map(s => ({
        studentId: s.id,
        studentName: s.name,
        className: s.className,
        parentId: s.parentId,
        score: '',
        included: true,
      }))
    );
  }, [selectedClass]);

  // When selectedClass changes, update subjects to only those mapped for this teacher/class
  useEffect(() => {
    if (!session || !selectedClass) return;
    const updateSubjects = async () => {
      const classSubs = await getClassSubjectsForTeacher(session.userId, selectedClass);
      setSubjects(classSubs);
      if (classSubs.length > 0) setSelectedSubject(classSubs[0].id);
      else setSelectedSubject('');
    };
    updateSubjects();
  }, [session, selectedClass]);

  useEffect(() => {
    const load = async () => {
      await loadStudents();
    };
    load();
  }, [loadStudents]);

  const updateScore = (studentId: string, score: string) => {
    setStudentScores(prev =>
      prev.map(s => s.studentId === studentId ? { ...s, score } : s)
    );
  };

  const updateComment = (studentId: string, comment: string) => {
    setStudentScores(prev =>
      prev.map(s => s.studentId === studentId ? { ...s, comment } : s)
    );
  };

  const toggleIncluded = (studentId: string) => {
    setStudentScores(prev =>
      prev.map(s => s.studentId === studentId ? { ...s, included: !s.included } : s)
    );
  };

  const toggleAll = (included: boolean) => {
    setStudentScores(prev => prev.map(s => ({ ...s, included })));
  };

  const applyQuickFill = () => {
    if (!quickFillValue) return;
    setStudentScores(prev =>
      prev.map(s => s.included && !s.score ? { ...s, score: quickFillValue } : s)
    );
    setQuickFillValue('');
    addToast({ type: 'info', title: 'Quick fill applied to empty fields' });
  };

  const clearAllScores = () => {
    setStudentScores(prev => prev.map(s => ({ ...s, score: '' })));
    addToast({ type: 'info', title: 'All scores cleared' });
  };

  const includedStudents = studentScores.filter(s => s.included);
  const filledStudents = includedStudents.filter(s => s.score.trim() !== '');
  const totalNum = parseInt(total) || 100;

  const hasErrors = filledStudents.some(s => {
    const score = parseInt(s.score);
    return isNaN(score) || score < 0 || score > totalNum;
  });

  const canProceedToScores = selectedClass && selectedSubject && examType && month && total && parseInt(total) > 0;
  const canProceedToReview = filledStudents.length > 0 && !hasErrors;

  const goToScores = () => {
    if (!canProceedToScores) {
      addToast({ type: 'error', title: 'Please fill all configuration fields' });
      return;
    }
    loadStudents();
    setStep('scores');
  };

  const goToReview = () => {
    if (!canProceedToReview) {
      addToast({ type: 'error', title: 'Fix errors or enter at least one score' });
      return;
    }
    setStep('review');
  };

  const handleSubmitAll = async () => {
    setSubmitting(true);

      const examsToCreate = filledStudents.map(s => ({
        studentId: s.studentId,
        subject: subjects.find(sub => sub.id === selectedSubject)?.name || subjects[0]?.name || '',
        score: parseInt(s.score),
        total: totalNum,
        examType,
        month,
        status: 'pending' as const,
        parentId: s.parentId,
        date,
        teacherId: session!.userId,
        termId: currentTerm?.id,
        subjectId: selectedSubject,
        // comment removed, handled in report_comments
      }));

    const created = await bulkCreateExams(examsToCreate);
    // After creation, persist per-exam comments (link comment to examId)
    if (created && created.length > 0) {
      for (const ex of created) {
        const local = filledStudents.find(s => s.studentId === ex.studentId);
        if (local?.comment) {
          try {
            await upsertReportComment({
              studentId: ex.studentId,
              termId: ex.termId || currentTerm?.id || '',
              examId: ex.id,
              teacherComment: local.comment,
              teacherId: session!.userId,
            });
          } catch (err) {
            // ignore individual failures but log
            console.error('Failed to upsert report comment', err);
          }
        }
      }
    }

    setSubmitting(false);
    setSubmitted(true);
    addToast({
      type: 'success',
      title: `${examsToCreate.length} results submitted!`,
      description: 'All submissions are pending admin approval',
    });

    setTimeout(() => {
      setSubmitted(false);
      setStep('config');
      setStudentScores(prev => prev.map(s => ({ ...s, score: '', included: true })));
    }, 3000);
  };

  const getScoreColor = (score: string) => {
    const num = parseInt(score);
    if (isNaN(num)) return '';
    const pct = (num / totalNum) * 100;
    if (pct >= 80) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
    if (pct >= 60) return 'text-blue-700 bg-blue-50 border-blue-200';
    if (pct >= 40) return 'text-amber-700 bg-amber-50 border-amber-200';
    return 'text-red-700 bg-red-50 border-red-200';
  };

  const isScoreInvalid = (score: string) => {
    if (!score.trim()) return false;
    const num = parseInt(score);
    return isNaN(num) || num < 0 || num > totalNum;
  };

  // ─── RENDER ───
  return (
    <div className="space-y-6">
      {/* DEBUG: Button to log all class_subjects rows */}
      <button
        className="mb-2 px-3 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
        onClick={handleDebugClassSubjects}
      >
        Debug: Log class_subjects
      </button>
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Upload Exam Results</h1>
        <p className="text-slate-500 mt-1">
          Enter scores for an entire class at once. All submissions require admin approval.
        </p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center gap-2">
        {[
          { key: 'config', label: 'Configure', icon: ClipboardList },
          { key: 'scores', label: 'Enter Scores', icon: Users },
          { key: 'review', label: 'Review & Submit', icon: Sparkles },
        ].map((s, i) => (

          
          <div key={s.key} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
            <button
              onClick={() => {
                if (s.key === 'config') setStep('config');
                else if (s.key === 'scores' && canProceedToScores) setStep('scores');
                else if (s.key === 'review' && canProceedToReview) setStep('review');
              }}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                step === s.key
                  ? 'bg-teal-100 text-teal-700 ring-2 ring-offset-1 ring-teal-200'
                  : step === 'review' && s.key !== 'review' ? 'bg-emerald-50 text-emerald-600'
                  : 'bg-white text-slate-400 border border-slate-200'
              )}
            >
              <s.icon className="w-4 h-4" />
              <span className="hidden sm:inline">{s.label}</span>
            </button>
          </div>
        ))}
      </div>

      {/* ═══ STEP 1: CONFIGURATION ═══ */}
      {step === 'config' && (
        <div className="max-w-3xl">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5">
            <h2 className="text-lg font-bold text-slate-800">Exam Configuration</h2>

            {/* Class Selection */}
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Select Class</label>
              <div className="flex flex-wrap gap-2">
                {classes.map(cls => (
                  <button key={cls} onClick={() => setSelectedClass(cls)}
                    className={cn("px-4 py-2.5 rounded-xl text-sm font-medium transition-all border",
                      selectedClass === cls
                        ? 'bg-teal-100 text-teal-700 border-teal-300 ring-2 ring-offset-1 ring-teal-200'
                        : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                    )}>
                    {cls}
                  </button>
                ))}
                {classes.length === 0 && (
                  <p className="text-sm text-slate-400 italic">No classes assigned to you</p>
                )}
              </div>
            </div>

            {/* Subject & Type */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Subject</label>
                <select value={selectedSubject} onChange={e => setSelectedSubject(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none bg-white">
                  {subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Exam Type</label>
                <select value={examType} onChange={e => setExamType(e.target.value as ExamType)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none bg-white">
                  {EXAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {/* Month, Date, Total */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Month</label>
                <select value={month} onChange={e => setMonth(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none bg-white">
                  {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Total Marks</label>
                <input type="number" value={total} onChange={e => setTotal(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
              </div>
            </div>

            {/* Summary Card */}
            <div className="bg-teal-50 border border-teal-200 rounded-xl p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><span className="text-teal-600 text-xs font-medium">Class</span><p className="font-bold text-teal-900">{selectedClass || '—'}</p></div>
                <div><span className="text-teal-600 text-xs font-medium">Subject</span><p className="font-bold text-teal-900">{subjects.find(s => s.id === selectedSubject)?.name || '—'}</p></div>
                <div><span className="text-teal-600 text-xs font-medium">Type</span><p className="font-bold text-teal-900">{examType}</p></div>
                <div><span className="text-teal-600 text-xs font-medium">Students</span><p className="font-bold text-teal-900">{studentScores.length}</p></div>
              </div>
            </div>

            <button
              onClick={goToScores}
              disabled={!canProceedToScores}
              className={cn(
                "w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-all",
                canProceedToScores
                  ? 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              )}
            >
              Continue to Score Entry <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ═══ STEP 2: SCORE ENTRY GRID ═══ */}
      {step === 'scores' && (
        <div className="space-y-4">
          {/* Config summary bar */}
          <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span><strong className="text-teal-800">{selectedClass}</strong></span>
            <span className="text-teal-600">•</span>
            <span><strong className="text-teal-800">{subjects.find(s => s.id === selectedSubject)?.name || '—'}</strong></span>
            <span className="text-teal-600">•</span>
            <span className="text-teal-700">{examType} — {month}</span>
            <span className="text-teal-600">•</span>
            <span className="text-teal-700">Out of {total}</span>
          </div>

          {/* Toolbar */}
          <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={studentScores.every(s => s.included)}
                onChange={e => toggleAll(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span className="text-xs font-medium text-slate-600">Select All</span>
            </div>

            <div className="h-6 w-px bg-slate-200" />

            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder="Quick fill score"
                value={quickFillValue}
                onChange={e => setQuickFillValue(e.target.value)}
                className="w-32 px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none"
              />
              <button onClick={applyQuickFill}
                className="px-3 py-1.5 bg-teal-50 text-teal-700 rounded-lg text-xs font-medium hover:bg-teal-100 transition-colors">
                Fill Empty
              </button>
            </div>

            <div className="h-6 w-px bg-slate-200" />

            <button onClick={clearAllScores}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-100 transition-colors">
              <RotateCcw className="w-3.5 h-3.5" /> Clear All
            </button>

            <div className="ml-auto text-xs text-slate-500">
              <span className="font-bold text-teal-700">{filledStudents.length}</span> / {includedStudents.length} scores entered
            </div>
          </div>

          {/* Score Grid */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="w-12 px-4 py-3"></th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">#</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Student Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Class</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">
                      Score / {total}
                    </th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">%</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {studentScores.map((s, idx) => {
                    const scoreNum = parseInt(s.score);
                    const pct = !isNaN(scoreNum) ? Math.round((scoreNum / totalNum) * 100) : null;
                    const invalid = isScoreInvalid(s.score);

                    return (
                      <tr
                        key={s.studentId}
                        className={cn(
                          "transition-colors",
                          !s.included ? 'opacity-40 bg-slate-50' : 'hover:bg-slate-50'
                        )}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={s.included}
                            onChange={() => toggleIncluded(s.studentId)}
                            className="w-4 h-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                          />
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-400 font-mono">{idx + 1}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-xs flex-shrink-0">
                              {s.studentName.split(' ').map(n => n[0]).join('').substring(0, 2)}
                            </div>
                            <span className="font-semibold text-slate-800 text-sm">{s.studentName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md text-xs font-medium">
                            {s.className}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-center">
                            <input
                              type="number"
                              min="0"
                              max={totalNum}
                              placeholder="—"
                              value={s.score}
                              onChange={e => updateScore(s.studentId, e.target.value)}
                              disabled={!s.included}
                              className={cn(
                                "w-20 text-center px-3 py-2 rounded-xl border text-sm font-bold transition-all outline-none",
                                invalid
                                  ? 'border-red-300 bg-red-50 text-red-700 focus:ring-2 focus:ring-red-200'
                                  : s.score
                                    ? getScoreColor(s.score) + ' focus:ring-2 focus:ring-teal-200'
                                    : 'border-slate-200 focus:ring-2 focus:ring-teal-200 focus:border-teal-400'
                              )}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === 'Tab') {
                                  const nextIdx = idx + 1;
                                  if (nextIdx < studentScores.length) {
                                    const nextRow = document.querySelector(`[data-score-row="${nextIdx}"]`) as HTMLInputElement;
                                    if (nextRow) { e.preventDefault(); nextRow.focus(); }
                                  }
                                }
                              }}
                              data-score-row={idx}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {pct !== null && !invalid ? (
                            <span className={cn("font-bold text-sm",
                              pct >= 80 ? 'text-emerald-600' :
                              pct >= 60 ? 'text-blue-600' :
                              pct >= 40 ? 'text-amber-600' : 'text-red-600'
                            )}>
                              {pct}%
                            </span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button onClick={() => {
                            setCommentDraft(s.comment || '');
                            setCommentingStudentId(s.studentId);
                            setCommentModalOpen(true);
                          }} className="px-2 py-1 text-xs rounded-lg bg-slate-50 hover:bg-slate-100">{s.comment ? 'Edit' : 'Add'}</button>
                        </td>
                        
                        <td className="px-4 py-3 text-center">
                          {invalid ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                              <AlertCircle className="w-3.5 h-3.5" /> Invalid
                            </span>
                          ) : s.score && s.included ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                              <CheckCircle className="w-3.5 h-3.5" /> Ready
                            </span>
                          ) : !s.included ? (
                            <span className="text-xs text-slate-400">Skipped</span>
                          ) : (
                            <span className="text-xs text-slate-400">Waiting</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {studentScores.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="font-medium">No students found in this class</p>
              </div>
            )}
          </div>

          {/* Navigation Buttons */}
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('config')}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <button
              onClick={goToReview}
              disabled={!canProceedToReview}
              className={cn(
                "flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all",
                canProceedToReview
                  ? 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              )}
            >
              Review & Submit <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ═══ STEP 3: REVIEW & SUBMIT ═══ */}
      {step === 'review' && (
        <div className="max-w-4xl space-y-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Review Submission</h2>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="bg-teal-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-teal-700">{filledStudents.length}</p>
                <p className="text-xs text-teal-600 mt-1">Students</p>
              </div>
              <div className="bg-indigo-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-indigo-700">{subjects.find(s => s.id === selectedSubject)?.name || '—'}</p>
                <p className="text-xs text-indigo-600 mt-1">Subject</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-violet-700">{examType}</p>
                <p className="text-xs text-violet-600 mt-1">Exam Type</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-amber-700">{month}</p>
                <p className="text-xs text-amber-600 mt-1">Month</p>
              </div>
            </div>

            {/* Results table */}
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">#</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Score</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">%</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filledStudents.map((s, idx) => {
                    const scoreNum = parseInt(s.score);
                    const pct = Math.round((scoreNum / totalNum) * 100);
                    const grade = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';
                    return (
                      <tr key={s.studentId} className="hover:bg-slate-50">
                        <td className="px-4 py-3 text-sm text-slate-400 font-mono">{idx + 1}</td>
                        <td className="px-4 py-3">
                          <span className="font-semibold text-slate-800 text-sm">{s.studentName}</span>
                        </td>
                        <td className="px-4 py-3 text-center font-bold text-sm text-slate-800">
                          {s.score} / {total}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("font-bold text-sm",
                            pct >= 80 ? 'text-emerald-600' :
                            pct >= 60 ? 'text-blue-600' :
                            pct >= 40 ? 'text-amber-600' : 'text-red-600'
                          )}>
                            {pct}%
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn("px-2.5 py-1 rounded-full text-xs font-bold",
                            grade === 'A' ? 'bg-emerald-100 text-emerald-700' :
                            grade === 'B' ? 'bg-blue-100 text-blue-700' :
                            grade === 'C' ? 'bg-teal-100 text-teal-700' :
                            grade === 'D' ? 'bg-amber-100 text-amber-700' :
                            'bg-red-100 text-red-700'
                          )}>
                            {grade}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Class average */}
            {filledStudents.length > 0 && (() => {
              const avg = Math.round(filledStudents.reduce((sum, s) => sum + ((parseInt(s.score) / totalNum) * 100), 0) / filledStudents.length);
              return (
                <div className="mt-4 bg-slate-50 rounded-xl p-4 flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-600">Class Average</span>
                  <span className={cn("text-xl font-bold",
                    avg >= 80 ? 'text-emerald-600' :
                    avg >= 60 ? 'text-blue-600' :
                    avg >= 40 ? 'text-amber-600' : 'text-red-600'
                  )}>
                    {avg}%
                  </span>
                </div>
              );
            })()}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('scores')}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all">
              <ChevronLeft className="w-4 h-4" /> Edit Scores
            </button>
            <button
              onClick={handleSubmitAll}
              disabled={submitting || submitted}
              className={cn(
                "flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all",
                submitted
                  ? 'bg-emerald-100 text-emerald-700'
                  : submitting
                    ? 'bg-teal-400 text-white cursor-wait'
                    : 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-200'
              )}
            >
              {submitted ? (
                <><CheckCircle className="w-5 h-5" /> All Results Submitted!</>
              ) : (
                <><Upload className="w-5 h-5" /> Submit {filledStudents.length} Results</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Comment Modal */}
      <Dialog open={commentModalOpen} onClose={() => setCommentModalOpen(false)} title="Add Comment" description="Add a comment for this student's exam result">
        <div className="space-y-4">
          <textarea
            value={commentDraft}
            onChange={e => setCommentDraft(e.target.value)}
            placeholder="Enter your comment..."
            rows={4}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setCommentModalOpen(false)}
              className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (commentingStudentId) {
                  updateComment(commentingStudentId, commentDraft);
                }
                setCommentModalOpen(false);
                setCommentingStudentId(null);
                setCommentDraft('');
              }}
              className="px-4 py-2 bg-teal-600 text-white rounded-xl text-sm font-medium hover:bg-teal-700 transition-colors"
            >
              Save Comment
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
