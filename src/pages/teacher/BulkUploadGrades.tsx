import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { getCurrentTerm } from '../../lib/db/academic';
import { getClassAssignmentsForTeacher, getClasses, getClassSubjectsForTeacher } from '../../lib/db/classes';
import { submitBulkGrades, type BulkGradeRecord, type BulkGradeSubmissionResult } from '../../lib/db/bulkGrades';
import { getStudentsByClasses } from '../../lib/db/students';
import { parseExcel, type ParseIssue, type ParseResult, type ParsedStudentRow } from '../../lib/excel-parser';
import type { Student, Subject, Term } from '../../types';
import { MONTHS } from '../../types';
import { cn } from '../../utils/cn';

type Step = 'config' | 'preview' | 'review';

type ResolvedStudent = {
  row: ParsedStudentRow;
  student: Student | null;
  candidates: Student[];
  reason?: string;
};

type SubjectBinding = {
  uploadedName: string;
  subject: Subject | null;
  reason?: string;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TEMPLATE_SUBJECTS = ['English', 'Math', 'Science', 'Social', 'Somali', 'Arabic', 'Tarabiya'];
const TEMPLATE_LABELS = ['HW1 5', 'HW2 5', 'HW3 5', 'HW4 5', 'CPW1 15', 'CPW2 15', 'CPW3 15', 'CPW4 15', 'Att 20', 'MT 20', 'Akhlaaq 10'];

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function subjectAliases(name: string): string[] {
  const canonical = normalized(name);
  const aliases: Record<string, string[]> = {
    math: ['mathematics'],
    mathematics: ['math'],
    social: ['social studies'],
    'social studies': ['social'],
    tarabiya: ['tarbiya', 'tarbiyah'],
    tarbiya: ['tarabiya', 'tarbiyah'],
  };
  return [canonical, ...(aliases[canonical] || [])];
}

function createUploadKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function candidateStudents(name: string, students: Student[]): Student[] {
  const wanted = normalized(name);
  if (!wanted) return [];
  const wantedWords = new Set(wanted.split(' '));
  return students.filter(student => {
    const candidate = normalized(student.name);
    if (candidate.includes(wanted) || wanted.includes(candidate)) return true;
    const overlap = candidate.split(' ').filter(word => wantedWords.has(word)).length;
    return overlap >= Math.min(2, wantedWords.size);
  }).slice(0, 5);
}

function downloadTemplate() {
  const topRow = ['', '', ...TEMPLATE_SUBJECTS.flatMap(subject => [subject, ...Array(8).fill(''), 'MT', 'Akhlaaq'])];
  const headerRow = ['Student ID', 'Student Name', ...TEMPLATE_SUBJECTS.flatMap(() => TEMPLATE_LABELS)];
  const worksheet = XLSX.utils.aoa_to_sheet([topRow, headerRow]);
  worksheet['!merges'] = TEMPLATE_SUBJECTS.map((_, index) => {
    const start = 2 + index * TEMPLATE_LABELS.length;
    return { s: { r: 0, c: start }, e: { r: 0, c: start + 8 } };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Grades');
  XLSX.writeFile(workbook, 'BulkUploadGradesTemplate.xlsx');
}

export function BulkUploadGrades() {
  const { session } = useRole();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('config');
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [classSubjects, setClassSubjects] = useState<Subject[]>([]);
  const [currentTerm, setCurrentTerm] = useState<Term | null>(null);
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [roster, setRoster] = useState<Student[]>([]);
  const [manualMatches, setManualMatches] = useState<Record<number, string>>({});
  const [loadError, setLoadError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [serverPreview, setServerPreview] = useState<BulkGradeSubmissionResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadKey, setUploadKey] = useState(createUploadKey);

  const isAdmin = session?.role === 'admin';

  useEffect(() => {
    if (!session) return;
    let active = true;
    const load = async () => {
      try {
        const [term, availableClasses] = await Promise.all([
          getCurrentTerm(),
          isAdmin
            ? getClasses()
            : getClassAssignmentsForTeacher(session.userId).then(assignments => Array.from(new Set(assignments.map(a => a.className)))),
        ]);
        if (!active) return;
        setCurrentTerm(term);
        setClasses(availableClasses);
        setSelectedClass(previous => previous && availableClasses.includes(previous) ? previous : availableClasses[0] || '');
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load upload configuration.');
      }
    };
    load();
    return () => { active = false; };
  }, [isAdmin, session]);

  useEffect(() => {
    if (!session || !selectedClass) {
      setClassSubjects([]);
      return;
    }
    let active = true;
    const loadClassContext = async () => {
      try {
        const [subjects, students] = await Promise.all([
          // An empty teacher id intentionally loads all assigned subjects for
          // an admin-selected class. The RPC remains the authorization source.
          getClassSubjectsForTeacher(isAdmin ? '' : session.userId, selectedClass),
          getStudentsByClasses([selectedClass], undefined, 10_000),
        ]);
        if (!active) return;
        setClassSubjects(subjects);
        setRoster(students);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load this class roster.');
      }
    };
    loadClassContext();
    return () => { active = false; };
  }, [isAdmin, selectedClass, session]);

  const ingestFile = async (file: File) => {
    setLoadError('');
    setServerPreview(null);
    setManualMatches({});
    if (!file.name.match(/\.xlsx?$/i)) {
      setLoadError('Please select an Excel workbook in .xlsx or .xls format.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setLoadError('This workbook is larger than 5 MB. Split it into smaller class uploads.');
      return;
    }
    try {
      const result = parseExcel(await file.arrayBuffer());
      setFileName(file.name);
      setParsed(result);
      setUploadKey(createUploadKey());
      const errorCount = result.issues.filter(issue => issue.severity === 'error').length;
      if (errorCount > 0) {
        addToast({ type: 'error', title: `Workbook needs ${errorCount} correction${errorCount === 1 ? '' : 's'}`, description: 'Review the highlighted sheet errors before submitting.' });
      } else {
        addToast({ type: 'success', title: `Parsed ${result.studentCount} students and ${result.totalExams} assessment records` });
      }
    } catch (error) {
      setParsed(null);
      setLoadError(error instanceof Error ? error.message : 'The workbook could not be read.');
    }
  };

  const resolvedStudents = useMemo<ResolvedStudent[]>(() => {
    if (!parsed) return [];
    const byId = new Map(roster.map(student => [student.id.trim(), student]));
    return parsed.students.map(row => {
      if (row.studentId) {
        const student = byId.get(row.studentId.trim()) || null;
        return student
          ? { row, student, candidates: [] }
          : { row, student: null, candidates: [], reason: `Student ID "${row.studentId}" is not in ${selectedClass}.` };
      }
      const exactMatches = roster.filter(student => normalized(student.name) === normalized(row.studentName));
      if (exactMatches.length === 1) return { row, student: exactMatches[0], candidates: [] };
      const selected = manualMatches[row.rowNumber];
      const candidates = exactMatches.length > 1 ? exactMatches : candidateStudents(row.studentName, roster);
      const manuallySelected = selected ? roster.find(student => student.id === selected) || null : null;
      if (manuallySelected) return { row, student: manuallySelected, candidates };
      return {
        row,
        student: null,
        candidates,
        reason: exactMatches.length > 1
          ? `"${row.studentName}" matches more than one roster student; choose the correct Student ID.`
          : candidates.length
            ? `"${row.studentName}" is a legacy name match. Confirm the correct student before submission.`
            : `No roster student matches legacy name "${row.studentName}".`,
      };
    });
  }, [manualMatches, parsed, roster, selectedClass]);

  const subjectBindings = useMemo<SubjectBinding[]>(() => {
    if (!parsed) return [];
    return parsed.subjects.map(uploadedName => {
      const aliases = subjectAliases(uploadedName);
      const matches = classSubjects.filter(subject => aliases.includes(normalized(subject.name)));
      return matches.length === 1
        ? { uploadedName, subject: matches[0] }
        : { uploadedName, subject: null, reason: matches.length > 1 ? `"${uploadedName}" matches multiple assigned subjects.` : `"${uploadedName}" is not assigned to ${selectedClass}.` };
    });
  }, [classSubjects, parsed, selectedClass]);

  const bindingBySubject = useMemo(() => new Map(subjectBindings.map(binding => [normalized(binding.uploadedName), binding])), [subjectBindings]);

  const clientIssues = useMemo<ParseIssue[]>(() => {
    const issues: ParseIssue[] = parsed ? [...parsed.issues] : [];
    if (!selectedClass) issues.push({ severity: 'error', code: 'INVALID_TEMPLATE', message: 'Select a class before reviewing this upload.' });
    if (!currentTerm) issues.push({ severity: 'error', code: 'INVALID_TEMPLATE', message: 'A current term is required before grades can be uploaded.' });
    subjectBindings.filter(binding => !binding.subject).forEach(binding => {
      issues.push({ severity: 'error', code: 'MISSING_SUBJECT', message: binding.reason || `Could not resolve ${binding.uploadedName}.`, subjectName: binding.uploadedName });
    });
    resolvedStudents.filter(result => !result.student).forEach(result => {
      issues.push({ severity: 'error', code: 'MISSING_STUDENT_ID', message: result.reason || `Could not resolve student on row ${result.row.rowNumber}.`, row: result.row.rowNumber });
    });
    return issues;
  }, [currentTerm, parsed, resolvedStudents, selectedClass, subjectBindings]);

  const records = useMemo<BulkGradeRecord[]>(() => {
    if (!parsed || !currentTerm) return [];
    const output: BulkGradeRecord[] = [];
    for (const result of resolvedStudents) {
      if (!result.student) continue;
      for (const score of result.row.scores) {
        const binding = bindingBySubject.get(normalized(score.subjectName));
        if (!binding?.subject) continue;
        output.push({
          studentId: result.student.id,
          subjectId: binding.subject.id,
          assessmentLabel: score.assessmentLabel,
          examType: score.examType,
          score: score.score,
          total: score.total,
          entryState: score.entryState,
          month,
          date,
          termId: currentTerm.id,
        });
      }
    }
    return output;
  }, [bindingBySubject, currentTerm, date, month, parsed, resolvedStudents]);

  const duplicateRecordIssues = useMemo<ParseIssue[]>(() => {
    const seen = new Set<string>();
    const issues: ParseIssue[] = [];
    for (const record of records) {
      const key = [record.studentId, record.subjectId, record.examType, record.assessmentLabel, record.termId].join('|');
      if (seen.has(key)) {
        issues.push({ severity: 'error', code: 'INVALID_TEMPLATE', message: `This workbook contains duplicate ${record.assessmentLabel} records for the same student, subject, and term.` });
      }
      seen.add(key);
    }
    return issues;
  }, [records]);

  const allIssues = [...clientIssues, ...duplicateRecordIssues];
  const blockingIssues = allIssues.filter(issue => issue.severity === 'error');
  const canReview = Boolean(parsed && records.length > 0 && blockingIssues.length === 0);

  const checkExistingRecords = async () => {
    if (!canReview) return;
    setSubmitting(true);
    try {
      const result = await submitBulkGrades(records, uploadKey, false);
      setServerPreview(result);
      setStep('review');
    } catch (error) {
      addToast({ type: 'error', title: 'Could not validate this upload', description: error instanceof Error ? error.message : 'Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const submit = async () => {
    if (!serverPreview) return;
    setSubmitting(true);
    try {
      const result = await submitBulkGrades(records, uploadKey, true);
      addToast({
        type: 'success',
        title: `Grade upload completed: ${result.insertCount} created, ${result.updateCount} updated`,
        description: result.uploadId ? `Upload reference: ${result.uploadId}` : undefined,
      });
      setStep('config');
      setParsed(null);
      setFileName('');
      setServerPreview(null);
      setManualMatches({});
      setUploadKey(createUploadKey());
    } catch (error) {
      addToast({ type: 'error', title: 'No grades were submitted', description: error instanceof Error ? error.message : 'Please correct the upload and try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const issuesBySeverity = (severity: 'error' | 'warning') => allIssues.filter(issue => issue.severity === severity);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bulk Upload Grades</h1>
          <p className="mt-1 text-slate-500">Validated subject blocks: HW1–HW4, CPW1–CPW4, Attendance, MT, and per-subject Akhlaaq.</p>
        </div>
        <button onClick={downloadTemplate} className="flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-700 hover:bg-teal-100">
          <Download className="h-4 w-4" /> Download ID template
        </button>
      </div>

      <div className="flex items-center gap-2 text-sm font-medium">
        {['Configure & upload', 'Resolve & preview', 'Review & confirm'].map((label, index) => {
          const active = (step === 'config' && index === 0) || (step === 'preview' && index === 1) || (step === 'review' && index === 2);
          return <React.Fragment key={label}>{index > 0 && <ChevronRight className="h-4 w-4 text-slate-300" />}<span className={cn('rounded-full px-3 py-1.5', active ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-500')}>{label}</span></React.Fragment>;
        })}
      </div>

      {loadError && <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertCircle className="h-5 w-5 shrink-0" />{loadError}</div>}

      {step === 'config' && (
        <div className="max-w-4xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3"><p className="mb-2 text-sm font-semibold text-slate-700">Class</p><div className="flex flex-wrap gap-2">
              {classes.map(className => <button key={className} onClick={() => { setSelectedClass(className); setServerPreview(null); }} className={cn('rounded-xl border px-3 py-2 text-sm font-medium', selectedClass === className ? 'border-teal-300 bg-teal-100 text-teal-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>{className}</button>)}
              {!classes.length && <span className="text-sm text-slate-500">No uploadable classes are available for this account.</span>}
            </div></div>
            <label className="text-sm font-semibold text-slate-700">Term<input disabled value={currentTerm?.name || 'No current term'} className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600" /></label>
            <label className="text-sm font-semibold text-slate-700">Month<select value={month} onChange={event => setMonth(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">{(currentTerm?.months?.length ? currentTerm.months : MONTHS).map(value => <option key={value}>{value}</option>)}</select></label>
            <label className="text-sm font-semibold text-slate-700">Assessment date<input type="date" value={date} onChange={event => setDate(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" /></label>
          </div>

          <div onClick={() => fileInputRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={event => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files?.[0]; if (file) void ingestFile(file); }} className={cn('cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center', dragOver ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:border-teal-300 hover:bg-slate-50')}>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void ingestFile(file); event.target.value = ''; }} />
            <FileSpreadsheet className="mx-auto mb-3 h-10 w-10 text-teal-600" />
            <p className="font-semibold text-slate-800">{fileName || 'Select or drop a grade workbook'}</p>
            <p className="mt-1 text-sm text-slate-500">Excel only, maximum 5 MB. New uploads require Student ID and Student Name.</p>
          </div>

          {parsed && <div className="flex items-center justify-between rounded-xl bg-teal-50 p-4 text-sm text-teal-900"><span>{parsed.studentCount} student rows · {parsed.subjects.length} subjects · {parsed.totalExams} entered assessment values</span><button onClick={() => { setParsed(null); setFileName(''); setServerPreview(null); }} className="rounded p-1 hover:bg-teal-100"><X className="h-4 w-4" /></button></div>}
          <button disabled={!parsed || !selectedClass} onClick={() => setStep('preview')} className={cn('flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 font-semibold', parsed && selectedClass ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}>Resolve & preview <ChevronRight className="h-4 w-4" /></button>
        </div>
      )}

      {step === 'preview' && parsed && (
        <div className="space-y-5">
          <IssuePanel title="Fix before submission" issues={issuesBySeverity('error')} tone="error" />
          <IssuePanel title="Review warnings" issues={issuesBySeverity('warning')} tone="warning" />

          {parsed.usesLegacyNameIdentity && resolvedStudents.some(result => !result.student && result.candidates.length) && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="font-bold text-amber-900">Manual legacy-name confirmations required</h2>
              <div className="mt-3 space-y-3">
                {resolvedStudents.filter(result => !result.student && result.candidates.length).map(result => (
                  <label key={result.row.rowNumber} className="block text-sm text-amber-900">Row {result.row.rowNumber}: <strong>{result.row.studentName}</strong>
                    <select value={manualMatches[result.row.rowNumber] || ''} onChange={event => { setManualMatches(previous => ({ ...previous, [result.row.rowNumber]: event.target.value })); setServerPreview(null); }} className="mt-1 block w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-slate-800">
                      <option value="">Choose confirmed roster student…</option>
                      {result.candidates.map(student => <option key={student.id} value={student.id}>{student.name} — {student.id}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm"><thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Workbook row</th><th className="px-4 py-3">Student resolution</th><th className="px-4 py-3">Records</th><th className="px-4 py-3">States</th></tr></thead>
              <tbody className="divide-y divide-slate-100">{resolvedStudents.map(result => <tr key={result.row.rowNumber}><td className="px-4 py-3">{result.row.rowNumber}</td><td className="px-4 py-3"><strong>{result.row.studentName || result.row.studentId}</strong><div className={result.student ? 'text-emerald-700' : 'text-red-700'}>{result.student ? `${result.student.name} · ${result.student.id}` : result.reason}</div></td><td className="px-4 py-3">{result.row.scores.length}</td><td className="px-4 py-3 text-slate-600">{result.row.scores.reduce((state, score) => ({ ...state, [score.entryState]: (state[score.entryState] || 0) + 1 }), {} as Record<string, number>).scored || 0} scored · {result.row.scores.filter(score => score.entryState !== 'scored').length} non-scored</td></tr>)}</tbody>
            </table>
          </div>

          <div className="flex items-center justify-between"><button onClick={() => setStep('config')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button><button disabled={!canReview || submitting} onClick={() => void checkExistingRecords()} className={cn('flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold', canReview && !submitting ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}>{submitting ? 'Checking existing records…' : `Review ${records.length} valid records`}<ChevronRight className="h-4 w-4" /></button></div>
        </div>
      )}

      {step === 'review' && serverPreview && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <div><h2 className="text-xl font-bold text-slate-900">Confirm grade upload</h2><p className="mt-1 text-slate-600">The server has validated your authorized roster, subjects, term, score limits, and duplicate keys. The write has not happened yet.</p></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><CountCard label="New records" count={serverPreview.insertCount} color="teal" /><CountCard label="Existing records to update" count={serverPreview.updateCount} color="amber" /><CountCard label="Records in upload" count={records.length} color="slate" /></div>
          {serverPreview.updateCount > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><strong>This will update {serverPreview.updateCount} existing assessment record{serverPreview.updateCount === 1 ? '' : 's'}.</strong> Existing scores will be replaced using the same student, subject, exam type, assessment label, and term key.</div>}
          <div className="flex justify-between"><button onClick={() => setStep('preview')} disabled={submitting} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button><button onClick={() => void submit()} disabled={submitting} className={cn('flex items-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-sm font-bold text-white hover:bg-teal-700', submitting && 'cursor-wait opacity-70')}><Upload className="h-4 w-4" />{submitting ? 'Submitting atomically…' : serverPreview.updateCount ? `Confirm update of ${serverPreview.updateCount} records` : `Submit ${serverPreview.insertCount} records`}</button></div>
        </div>
      )}
    </div>
  );
}

function IssuePanel({ title, issues, tone }: { title: string; issues: ParseIssue[]; tone: 'error' | 'warning' }) {
  if (!issues.length) return null;
  const classes = tone === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  return <div className={cn('rounded-2xl border p-5', classes)}><h2 className="font-bold">{title} ({issues.length})</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{issues.map((issue, index) => <li key={`${issue.code}-${issue.cell || issue.row || index}`}>{issue.cell ? `${issue.cell}: ` : issue.row ? `Row ${issue.row}: ` : ''}{issue.message}</li>)}</ul></div>;
}

function CountCard({ label, count, color }: { label: string; count: number; color: 'teal' | 'amber' | 'slate' }) {
  const classes = color === 'teal' ? 'bg-teal-50 text-teal-800' : color === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-800';
  return <div className={cn('rounded-xl p-4 text-center', classes)}><p className="text-2xl font-bold">{count}</p><p className="text-xs font-medium">{label}</p></div>;
}
