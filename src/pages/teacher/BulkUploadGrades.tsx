import React, { useState, useEffect, useRef } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { getStudentsByClasses } from '../../lib/db/students';
import { bulkCreateExams } from '../../lib/db/bulk';
import { getCurrentTerm } from '../../lib/db/academic';
import { getClassAssignmentsForTeacher, getClassSubjectsForTeacher } from '../../lib/db/classes';
import { getSubjects } from '../../lib/db/subjects';
import { parseExcel, ParseResult, ParsedStudentRow, ParsedScore } from '../../lib/excel-parser';
import { MONTHS, Term } from '../../types';
import * as XLSX from 'xlsx';
import { Upload, CheckCircle, ChevronRight, ChevronLeft, FileSpreadsheet, AlertCircle, X, Download } from 'lucide-react';
import { cn } from '../../utils/cn';

type Step = 'config' | 'preview' | 'review';

interface ResolvedStudent {
  studentId: string;
  name: string;
  parentId: string | null;
}

interface SubjectLookup {
  id: string;
  name: string;
}

export function BulkUploadGrades() {
  const { session } = useRole();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [currentTerm, setCurrentTerm] = useState<Term | null>(null);
  const [allSubjects, setAllSubjects] = useState<SubjectLookup[]>([]);

  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [resolvedStudents, setResolvedStudents] = useState<ResolvedStudent[]>([]);
  const [step, setStep] = useState<Step>('config');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [parseError, setParseError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!session) return;
    const load = async () => {
      const term = await getCurrentTerm();
      setCurrentTerm(term);
      const assignments = await getClassAssignmentsForTeacher(session.userId);
      const uniqueClasses = Array.from(new Set(assignments.map(a => a.className)));
      setClasses(uniqueClasses);
      if (uniqueClasses.length > 0) setSelectedClass(uniqueClasses[0]);
      const subjects = await getSubjects();
      setAllSubjects(subjects);
    };
    load();
  }, [session]);

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) {
      setParseError('Please drop an Excel file (.xlsx or .xls)');
      return;
    }
    setFileName(file.name);
    setParseError('');
    setParsed(null);
    try {
      const buf = await file.arrayBuffer();
      const result = parseExcel(buf);
      if (result.students.length === 0) {
        setParseError('No student data found in the file. Check that the header row contains "Student Name".');
        return;
      }
      setParsed(result);
      addToast({ type: 'info', title: `Parsed ${result.studentCount} students, ${result.totalExams} scores across ${result.subjects.length} subjects` });
    } catch (err) {
      setParseError(String(err));
      addToast({ type: 'error', title: 'Failed to parse file', description: String(err) });
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError('');
    setParsed(null);
    try {
      const buf = await file.arrayBuffer();
      const result = parseExcel(buf);
      if (result.students.length === 0) {
        setParseError('No student data found in the file. Check that the header row contains "Student Name".');
        return;
      }
      setParsed(result);
      addToast({ type: 'info', title: `Parsed ${result.studentCount} students, ${result.totalExams} scores across ${result.subjects.length} subjects` });
    } catch (err) {
      setParseError(String(err));
      addToast({ type: 'error', title: 'Failed to parse file', description: String(err) });
    }
  };

  const subjectNameToId = (name: string): string | undefined => {
    const match = allSubjects.find(
      s => s.name.toLowerCase() === name.toLowerCase()
    );
    return match?.id;
  };

  const resolveAndReview = async () => {
    if (!parsed || !session) return;
    try {
      const students = await getStudentsByClasses([selectedClass]);
      const resolved: ResolvedStudent[] = parsed.students.map(p => {
        const match = students.find(
          s => s.name.toLowerCase().trim() === p.studentName.toLowerCase().trim()
        );
        return match
          ? { studentId: match.id, name: match.name, parentId: match.parentId }
          : { studentId: '', name: p.studentName, parentId: null };
      });
      setResolvedStudents(resolved);
      setStep('preview');
    } catch (err) {
      addToast({ type: 'error', title: 'Failed to load students', description: String(err) });
    }
  };

  const handleSubmit = async () => {
    if (!parsed || !session) return;
    setSubmitting(true);

    const examsToCreate: any[] = [];

    for (let si = 0; si < parsed.students.length; si++) {
      const student = parsed.students[si];
      const resolved = resolvedStudents[si];
      if (!resolved.studentId) continue;

      for (let bi = 0; bi < parsed.subjects.length; bi++) {
        const subjectName = parsed.subjects[bi];
        const subjectId = subjectNameToId(subjectName);
        if (!subjectId) continue;

        const scores = student.subjectScores[subjectName] || [];
        for (const sc of scores) {
          examsToCreate.push({
            studentId: resolved.studentId,
            subject: subjectName,
            subjectId,
            score: sc.score,
            total: sc.total,
            examType: sc.examType,
            month,
            status: 'pending',
            parentId: resolved.parentId,
            date,
            teacherId: session.userId,
            termId: currentTerm?.id,
          });
        }
      }
    }

    if (examsToCreate.length === 0) {
      addToast({ type: 'error', title: 'No valid exams to submit', description: 'Check that students and subjects are correctly matched' });
      setSubmitting(false);
      return;
    }

    try {
      await bulkCreateExams(examsToCreate);
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
        setParsed(null);
        setFileName('');
        setResolvedStudents([]);
      }, 3000);
    } catch (err) {
      setSubmitting(false);
      addToast({ type: 'error', title: 'Submission failed', description: String(err) });
    }
  };

  const unmatchedStudents = parsed && resolvedStudents.filter(r => !r.studentId);
  const totalExams = (() => {
    if (!parsed) return 0;
    return parsed.students.reduce((sum, s) =>
      sum + Object.values(s.subjectScores).reduce((a, b) => a + b.length, 0), 0);
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bulk Upload Grades</h1>
        <p className="text-slate-500 mt-1">
          Upload an Excel file with all subjects and assessment types at once.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {[
          { key: 'config', label: 'Configure & Upload', icon: FileSpreadsheet },
          { key: 'preview', label: 'Preview', icon: Upload },
          { key: 'review', label: 'Review & Submit', icon: CheckCircle },
        ].map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
            <button
              onClick={() => { if (s.key === 'config') setStep('config'); }}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all",
                step === s.key
                  ? 'bg-teal-100 text-teal-700 ring-2 ring-offset-1 ring-teal-200'
                  : step === 'review' && s.key !== 'config' ? 'bg-emerald-50 text-emerald-600'
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
            <h2 className="text-lg font-bold text-slate-800">Upload Configuration</h2>

            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Class</label>
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
                  <p className="text-sm text-slate-400 italic">No classes assigned</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Month</label>
                <select value={month} onChange={e => setMonth(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none bg-white">
                  {(currentTerm?.months?.length ? currentTerm.months : MONTHS).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Excel File</label>
              <div className="mb-2 flex justify-end">
                <button onClick={() => {
                  const subjects = ['English', 'Math', 'Science', 'Social', 'Somali'];
                  const labels = ['HW1 5','HW2 5','HW3 5','HW4 5','CPW1 15','CPW2 15','CPW3 15','CPW4 15','Att','20','10'];
                  const students = ['Student Name goes here', 'Enter student names as they appear in the system'];
                  const r1 = Array(1).fill('').concat(subjects.flatMap(s => Array(9).fill(s).concat(['MT','Akhlaaq'])));
                  const r2 = ['Student Name'].concat(subjects.flatMap(() => labels));
                  const data = [r1, r2, ...subjects.map((_, si) => [
                    students[si] || `Student ${si + 1}`,
                    ...Array(55).fill('')
                  ])];
                  const ws = XLSX.utils.aoa_to_sheet(data);
                  const wb = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(wb, ws, 'Grades');
                  XLSX.writeFile(wb, 'BulkUploadExample.xlsx');
                }}
                  className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-800 font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Download Example
                </button>
              </div>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
                onDrop={handleDrop}
                className={cn(
                  "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors",
                  fileName ? 'border-teal-300 bg-teal-50' : dragOver ? 'border-teal-500 bg-teal-50 scale-[1.02]' : 'border-slate-200 hover:border-teal-300 hover:bg-slate-50'
                )}
              >
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFile} className="hidden" />
                {fileName ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileSpreadsheet className="w-8 h-8 text-teal-600" />
                    <div className="text-left">
                      <p className="font-medium text-slate-800">{fileName}</p>
                      {parsed && (
                        <p className="text-sm text-teal-600">{parsed.studentCount} students, {parsed.subjects.length} subjects, {parsed.totalExams} scores</p>
                      )}
                    </div>
                    <button onClick={e => { e.stopPropagation(); setFileName(''); setParsed(null); setParseError(''); }}
                      className="p-1.5 rounded-full hover:bg-slate-200 text-slate-400">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div>
                    <FileSpreadsheet className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                    <p className="font-medium text-slate-600">Click to select an Excel file</p>
                    <p className="text-sm text-slate-400 mt-1">.xlsx or .xls format</p>
                  </div>
                )}
              </div>
              {parseError && (
                <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" /> {parseError}
                </p>
              )}
            </div>

            {parsed && (
              <div className="bg-teal-50 border border-teal-200 rounded-xl p-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div><span className="text-teal-600 text-xs font-medium">Class</span><p className="font-bold text-teal-900">{selectedClass || '—'}</p></div>
                  <div><span className="text-teal-600 text-xs font-medium">Subjects</span><p className="font-bold text-teal-900">{parsed.subjects.join(', ')}</p></div>
                  <div><span className="text-teal-600 text-xs font-medium">Students</span><p className="font-bold text-teal-900">{parsed.studentCount}</p></div>
                  <div><span className="text-teal-600 text-xs font-medium">Scores</span><p className="font-bold text-teal-900">{parsed.totalExams}</p></div>
                </div>
              </div>
            )}

            <button onClick={resolveAndReview} disabled={!parsed}
              className={cn("w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-all",
                parsed
                  ? 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-200'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              )}>
              Preview & Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && parsed && (
        <div className="space-y-4">
          <div className="bg-teal-50 border border-teal-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span><strong className="text-teal-800">{selectedClass}</strong></span>
            <span className="text-teal-600">•</span>
            <span className="text-teal-700">{month} — {date}</span>
            <span className="text-teal-600">•</span>
            <span className="text-teal-700">{parsed.totalExams} scores across {parsed.subjects.length} subjects</span>
          </div>

          {unmatchedStudents && unmatchedStudents.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-amber-800 text-sm">{unmatchedStudents.length} student(s) not found in the class roster</p>
                <p className="text-xs text-amber-700 mt-1">{unmatchedStudents.map(s => s.name).join(', ')}</p>
                <p className="text-xs text-amber-600 mt-1">These students will be skipped during submission.</p>
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500 uppercase sticky left-0 bg-slate-50">Student</th>
                    {parsed.subjects.map(subject => (
                      <th key={subject} colSpan={3} className="text-center px-2 py-2 text-xs font-semibold uppercase border-l border-slate-100"
                        style={{ minWidth: '200px' }}>
                        <span className="bg-teal-100 text-teal-700 px-2 py-0.5 rounded-md">{subject}</span>
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-slate-50/50 border-b border-slate-200">
                    <th className="sticky left-0 bg-slate-50/50"></th>
                    {parsed.subjects.map(subject => (
                        <React.Fragment key={`hdr-${subject}`}>
                          <th className="text-center px-1 py-1 text-[10px] font-medium text-slate-400 uppercase" colSpan={2}>Scores</th>
                          <th className="text-center px-1 py-1 text-[10px] font-medium text-slate-400 uppercase border-r border-slate-100">Avg</th>
                        </React.Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsed.students.map((student, si) => {
                    const resolved = resolvedStudents[si];
                    const matched = !!resolved?.studentId;
                    return (
                      <tr key={si} className={cn(matched ? 'hover:bg-slate-50' : 'opacity-50 bg-slate-50')}>
                        <td className="px-3 py-2 text-sm font-medium text-slate-800 sticky left-0 bg-white border-r border-slate-100">
                          <div className="flex items-center gap-2">
                            {matched ? (
                              <span>{student.studentName}</span>
                            ) : (
                              <span className="flex items-center gap-1"><X className="w-3 h-3 text-red-400" /> {student.studentName}</span>
                            )}
                          </div>
                        </td>
                        {parsed.subjects.map(subject => {
                          const scores = student.subjectScores[subject] || [];
                          const avg = scores.length > 0
                            ? Math.round(scores.reduce((s, sc) => s + (sc.score / sc.total) * 100, 0) / scores.length)
                            : null;
                          const types = ['HW1','HW2','HW3','HW4','CPW1','CPW2','CPW3','CPW4','Att','Quiz','Disc'];
                          return (
                            <React.Fragment key={`${si}-${subject}`}>
                              <td className="text-right px-1 py-2 text-[10px] text-slate-400 font-mono whitespace-nowrap border-r border-slate-50">
                                {types.map(t => <div key={t}>{t}</div>)}
                              </td>
                              <td className="text-left px-1 py-2 text-xs font-mono text-slate-700 whitespace-nowrap">
                                {types.map((_, i) => {
                                  const sc = scores[i];
                                  return <div key={i}>{sc ? `${sc.score}/${sc.total}` : <span className="text-slate-300">—</span>}</div>;
                                })}
                              </td>
                              <td className="text-center px-1 py-2 text-xs font-medium border-r border-slate-100">
                                {avg !== null ? (
                                  <span className={cn(avg >= 80 ? 'text-emerald-600' : avg >= 60 ? 'text-blue-600' : avg >= 40 ? 'text-amber-600' : 'text-red-600')}>
                                    {avg}%
                                  </span>
                                ) : '—'}
                              </td>
                            </React.Fragment>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button onClick={() => setStep('config')}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <button onClick={() => setStep('review')}
              className="flex items-center gap-2 px-5 py-2.5 bg-teal-600 text-white rounded-xl font-medium text-sm hover:bg-teal-700 shadow-lg shadow-teal-200 transition-all">
              Review & Submit <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 'review' && parsed && (
        <div className="max-w-4xl space-y-5">
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Review & Submit</h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="bg-teal-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-teal-700">{parsed.studentCount}</p>
                <p className="text-xs text-teal-600 mt-1">Students</p>
              </div>
              <div className="bg-indigo-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-indigo-700">{parsed.subjects.length}</p>
                <p className="text-xs text-indigo-600 mt-1">Subjects</p>
              </div>
              <div className="bg-violet-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-violet-700">{totalExams}</p>
                <p className="text-xs text-violet-600 mt-1">Total Scores</p>
              </div>
              <div className="bg-amber-50 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-amber-700">{month}</p>
                <p className="text-xs text-amber-600 mt-1">Month</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">HW (4)</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">CPW (4)</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Att</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Quiz</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Disc</th>
                    <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsed.subjects.map(subject => {
                    let hwCount = 0, cpwCount = 0, attCount = 0, quizCount = 0, discCount = 0;
                    let totalExamsForSubject = 0;
                    for (const student of parsed.students) {
                      const scores = student.subjectScores[subject] || [];
                      for (const sc of scores) {
                        if (sc.examType === 'Homework') hwCount++;
                        else if (sc.examType === 'Classwork') cpwCount++;
                        else if (sc.examType === 'Attendance') attCount++;
                        else if (sc.examType === 'Quiz') quizCount++;
                        else if (sc.examType === 'Discipline') discCount++;
                        totalExamsForSubject++;
                      }
                    }
                    return (
                      <tr key={subject} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-semibold text-slate-800 text-sm">{subject}</td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{hwCount}</td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{cpwCount}</td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{attCount}</td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{quizCount}</td>
                        <td className="px-4 py-3 text-center text-sm text-slate-600">{discCount}</td>
                        <td className="px-4 py-3 text-center font-bold text-sm text-teal-700">{totalExamsForSubject}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <button onClick={() => setStep('preview')}
              className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <button onClick={handleSubmit} disabled={submitting || submitted}
              className={cn("flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all",
                submitted
                  ? 'bg-emerald-100 text-emerald-700'
                  : submitting
                    ? 'bg-teal-400 text-white cursor-wait'
                    : 'bg-teal-600 text-white hover:bg-teal-700 shadow-lg shadow-teal-200'
              )}>
              {submitted ? (
                <><CheckCircle className="w-5 h-5" /> All Results Submitted!</>
              ) : (
                <><Upload className="w-5 h-5" /> Submit {totalExams} Scores</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

