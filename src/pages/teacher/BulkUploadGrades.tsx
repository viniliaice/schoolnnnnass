// Bulk Upload Grades — class-specific, roster-prefilled workflow.
//
// One class at a time. The teacher selects exactly ONE class, sees only the
// subjects they are authorized to teach in THAT class, picks assessment blocks,
// downloads a roster-prefilled workbook (Student IDs already filled in), enters
// grades, uploads, and reviews server-validated changes before confirming.
//
// The server (submit_bulk_grades RPC) is authoritative for every check. The
// workbook is never trusted: student identity, current class, teacher/class/
// subject authorization, score ranges, term/month/date, and duplicate keys are
// all re-validated server-side, atomically, with idempotency.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { getCurrentTerm } from '../../lib/db/academic';
import { getClassAssignmentsForTeacher, getClasses, getClassSubjectsForTeacher } from '../../lib/db/classes';
import { submitBulkGrades, type BulkGradeSubmissionResult } from '../../lib/db/bulkGrades';
import { getStudentsByClasses } from '../../lib/db/students';
import { ASSESSMENT_GROUPS, blockDisplayName } from '../../lib/bulk-grades/assessments';
import {
  buildRosterWorkbook,
  parseRosterWorkbook,
  workbookFileName,
  type WorkbookParseResult,
} from '../../lib/bulk-grades/workbook';
import { resolveWorkbook, type ResolveResult } from '../../lib/bulk-grades/resolve';
import type { AssessmentLabel } from '../../lib/excel-parser';
import type { Student, Subject, Term } from '../../types';
import { MONTHS } from '../../types';
import { cn } from '../../utils/cn';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type StepId = 'class' | 'assessment' | 'download' | 'upload' | 'resolve' | 'review' | 'confirm';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'class', label: '1. Class & Subjects' },
  { id: 'assessment', label: '2. Assessment' },
  { id: 'download', label: '3. Download Example' },
  { id: 'upload', label: '4. Upload' },
  { id: 'resolve', label: '5. Resolve & Validate' },
  { id: 'review', label: '6. Review' },
  { id: 'confirm', label: '7. Confirm' },
];

function createUploadKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function BulkUploadGrades() {
  const { session } = useRole();
  const { addToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<StepId>('class');

  // Step 1 — class & subjects
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('');
  const [classSubjects, setClassSubjects] = useState<Subject[]>([]);
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);
  const [roster, setRoster] = useState<Student[]>([]);

  // Step 2 — assessment config & blocks
  const [currentTerm, setCurrentTerm] = useState<Term | null>(null);
  const [month, setMonth] = useState(MONTHS[new Date().getMonth()]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [selectedBlocks, setSelectedBlocks] = useState<AssessmentLabel[]>([]);

  // Step 4/5 — upload & parse
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<WorkbookParseResult | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Step 6/7 — server preview
  const [serverPreview, setServerPreview] = useState<BulkGradeSubmissionResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadKey, setUploadKey] = useState(createUploadKey);

  const [loadError, setLoadError] = useState('');

  const isAdmin = session?.role === 'admin';

  const selectedSubjects = useMemo(
    () => classSubjects.filter(subject => selectedSubjectIds.includes(subject.id)),
    [classSubjects, selectedSubjectIds],
  );

  // ---- Load classes + current term ----------------------------------------
  useEffect(() => {
    if (!session) return;
    let active = true;
    (async () => {
      try {
        const [term, availableClasses] = await Promise.all([
          getCurrentTerm(),
          isAdmin
            ? getClasses()
            : getClassAssignmentsForTeacher(session.userId).then(a => Array.from(new Set(a.map(r => r.className)))),
        ]);
        if (!active) return;
        setCurrentTerm(term);
        setClasses(availableClasses.sort());
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load upload configuration.');
      }
    })();
    return () => { active = false; };
  }, [isAdmin, session]);

  // ---- Load subjects + roster for the selected class ----------------------
  useEffect(() => {
    if (!session || !selectedClass) {
      setClassSubjects([]);
      setRoster([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        const [subjects, students] = await Promise.all([
          getClassSubjectsForTeacher(isAdmin ? '' : session.userId, selectedClass),
          getStudentsByClasses([selectedClass], undefined, 10_000),
        ]);
        if (!active) return;
        setClassSubjects(Array.from(new Map(subjects.map(s => [s.id, s])).values()));
        setRoster(students);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load this class roster.');
      }
    })();
    return () => { active = false; };
  }, [isAdmin, selectedClass, session]);

  // Drop subject selections that are no longer authorized for the class.
  useEffect(() => {
    const allowed = new Set(classSubjects.map(s => s.id));
    setSelectedSubjectIds(prev => prev.filter(id => allowed.has(id)));
  }, [classSubjects]);

  const resetDownstream = () => {
    setParsed(null);
    setFileName('');
    setServerPreview(null);
  };

  const chooseClass = (className: string) => {
    setSelectedClass(className);
    setSelectedSubjectIds([]);
    resetDownstream();
  };

  const toggleSubject = (id: string) => {
    setSelectedSubjectIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    resetDownstream();
  };

  const toggleBlock = (label: AssessmentLabel) => {
    setSelectedBlocks(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]);
    resetDownstream();
  };

  // ---- Derived readiness --------------------------------------------------
  const canConfigureAssessment = Boolean(selectedClass && selectedSubjects.length > 0);
  const canDownload = Boolean(canConfigureAssessment && currentTerm && selectedBlocks.length > 0);

  const resolveResult = useMemo<ResolveResult | null>(() => {
    if (!parsed || !currentTerm || !selectedClass) return null;
    return resolveWorkbook(parsed, {
      className: selectedClass,
      authorizedSubjects: selectedSubjects,
      roster,
      termId: currentTerm.id,
      termName: currentTerm.name,
      month,
      date,
    });
  }, [parsed, currentTerm, selectedClass, selectedSubjects, roster, month, date]);

  const parseErrors = useMemo(() => (parsed ? parsed.issues.filter(i => i.severity === 'error') : []), [parsed]);
  const blockingCount = (parseErrors.length) + (resolveResult ? resolveResult.errors.length : 0);
  const canValidate = Boolean(resolveResult && resolveResult.records.length > 0 && blockingCount === 0);

  // ---- Download -----------------------------------------------------------
  const download = () => {
    if (!canDownload) return;
    try {
      const bytes = buildRosterWorkbook({
        className: selectedClass,
        subjects: selectedSubjects,
        blocks: selectedBlocks,
        roster,
        termName: currentTerm?.name,
        month,
        assessmentDate: date,
      });
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = workbookFileName(selectedClass, selectedSubjects.map(s => s.name));
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      addToast({ type: 'success', title: `Workbook ready for ${selectedClass}`, description: `${roster.length} students · ${selectedSubjects.length} subject(s).` });
      setStep('upload');
    } catch (error) {
      addToast({ type: 'error', title: 'Could not generate the workbook', description: error instanceof Error ? error.message : undefined });
    }
  };

  // ---- Upload / parse -----------------------------------------------------
  const ingestFile = async (file: File) => {
    setLoadError('');
    setServerPreview(null);
    if (!file.name.match(/\.xlsx?$/i)) {
      setLoadError('Please select an Excel workbook in .xlsx or .xls format.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setLoadError('This workbook is larger than 5 MB.');
      return;
    }
    try {
      const result = parseRosterWorkbook(await file.arrayBuffer());
      setFileName(file.name);
      setParsed(result);
      setUploadKey(createUploadKey());
      const errorCount = result.issues.filter(i => i.severity === 'error').length;
      if (errorCount > 0) {
        addToast({ type: 'error', title: `Workbook needs ${errorCount} correction${errorCount === 1 ? '' : 's'}`, description: 'Review the highlighted errors before submitting.' });
      } else {
        addToast({ type: 'success', title: 'File loaded successfully', description: `${result.studentCount} students · ${result.totalEntered} entered values.` });
      }
      setStep('resolve');
    } catch (error) {
      setParsed(null);
      setLoadError(error instanceof Error ? error.message : 'The workbook could not be read.');
    }
  };

  // ---- Server validate (no write) ----------------------------------------
  const runServerValidation = async () => {
    if (!resolveResult || !canValidate) return;
    setSubmitting(true);
    try {
      const result = await submitBulkGrades(resolveResult.records, uploadKey, false);
      setServerPreview(result);
      setStep('review');
    } catch (error) {
      addToast({ type: 'error', title: 'Could not validate this upload', description: error instanceof Error ? error.message : 'Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Confirm & commit (atomic) -----------------------------------------
  const confirmAndUpload = async () => {
    if (!resolveResult || !serverPreview) return;
    setSubmitting(true);
    try {
      const result = await submitBulkGrades(resolveResult.records, uploadKey, true);
      addToast({
        type: 'success',
        title: `Grades saved: ${result.insertCount} created, ${result.updateCount} updated`,
        description: result.uploadId ? `Upload reference: ${result.uploadId}` : undefined,
      });
      // Reset for the next class.
      setStep('class');
      setSelectedBlocks([]);
      setSelectedSubjectIds([]);
      resetDownstream();
      setUploadKey(createUploadKey());
    } catch (error) {
      addToast({ type: 'error', title: 'No grades were submitted', description: error instanceof Error ? error.message : 'Please correct the upload and try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const goToStep = (target: StepId) => {
    const order = STEPS.map(s => s.id);
    if (order.indexOf(target) <= order.indexOf(step)) setStep(target);
  };

  const monthOptions = currentTerm?.months?.length ? currentTerm.months : MONTHS;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bulk Upload Grades</h1>
        <p className="mt-1 text-slate-500">
          One class at a time. Download a roster-prefilled workbook for the selected class and subjects, enter grades, and confirm server-validated changes.
        </p>
      </div>

      <StepIndicator step={step} onStep={goToStep} />

      {loadError && (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="h-5 w-5 shrink-0" />{loadError}
        </div>
      )}

      {/* STEP 1 — CLASS & SUBJECTS */}
      {step === 'class' && (
        <div className="max-w-4xl space-y-6 rounded-2xl border border-slate-200 bg-white p-6">
          <section>
            <h2 className="text-sm font-semibold text-slate-700">Class</h2>
            <p className="mb-2 text-xs text-slate-500">Select exactly one class you are authorized to work with.</p>
            <div className="flex flex-wrap gap-2">
              {classes.map(className => (
                <button
                  key={className}
                  onClick={() => chooseClass(className)}
                  className={cn(
                    'rounded-xl border px-3 py-2 text-sm font-medium',
                    selectedClass === className ? 'border-teal-300 bg-teal-100 text-teal-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50',
                  )}
                >
                  {className}
                </button>
              ))}
              {!classes.length && <span className="text-sm text-slate-500">No uploadable classes are available for this account.</span>}
            </div>
          </section>

          {selectedClass && (
            <section>
              <h2 className="text-sm font-semibold text-slate-700">Subjects</h2>
              <p className="mb-2 text-xs text-slate-500">Only subjects you teach in {selectedClass} are shown. Choose which to include in this upload.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {classSubjects.map(subject => (
                  <label key={subject.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selectedSubjectIds.includes(subject.id)}
                      onChange={() => toggleSubject(subject.id)}
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    {subject.name}
                  </label>
                ))}
                {!classSubjects.length && <span className="text-sm text-slate-500">You are not assigned any subjects in {selectedClass}.</span>}
              </div>
              <p className="mt-2 text-xs text-slate-500">{roster.length} students currently in {selectedClass}.</p>
            </section>
          )}

          <div className="flex justify-end">
            <button
              disabled={!canConfigureAssessment}
              onClick={() => setStep('assessment')}
              className={cn('flex items-center gap-2 rounded-xl px-5 py-3 font-semibold', canConfigureAssessment ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}
            >
              Continue <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — ASSESSMENT CONFIG + BLOCKS */}
      {step === 'assessment' && (
        <div className="max-w-4xl space-y-6 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm font-semibold text-slate-700">Term
              <input disabled value={currentTerm?.name || 'No current term'} className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600" />
            </label>
            <label className="text-sm font-semibold text-slate-700">Month
              <select value={month} onChange={e => { setMonth(e.target.value); resetDownstream(); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2">
                {monthOptions.map(value => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label className="text-sm font-semibold text-slate-700">Assessment date
              <input type="date" value={date} onChange={e => { setDate(e.target.value); resetDownstream(); }} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2" />
            </label>
          </div>

          <section>
            <h2 className="text-sm font-semibold text-slate-700">Assessment blocks</h2>
            <p className="mb-3 text-xs text-slate-500">Maximum scores come from the shared assessment definitions and are enforced by the server.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {ASSESSMENT_GROUPS.map(group => (
                <div key={group.id} className="rounded-xl border border-slate-200 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.title}</p>
                  <div className="space-y-1.5">
                    {group.blocks.map(block => (
                      <label key={block.label} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={selectedBlocks.includes(block.label)}
                          onChange={() => toggleBlock(block.label)}
                          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                        />
                        <span>{blockDisplayName(block.label)}</span>
                        <span className="text-xs text-slate-400">/ {block.total}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="flex items-center justify-between">
            <button onClick={() => setStep('class')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
            <button
              disabled={!canDownload}
              onClick={() => setStep('download')}
              className={cn('flex items-center gap-2 rounded-xl px-5 py-3 font-semibold', canDownload ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}
            >
              Continue <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — DOWNLOAD */}
      {step === 'download' && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Download the class workbook</h2>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryItem label="Class" value={selectedClass} />
            <SummaryItem label="Students" value={String(roster.length)} />
            <SummaryItem label="Subjects" value={selectedSubjects.map(s => s.name).join(', ')} />
            <SummaryItem label="Assessment blocks" value={selectedBlocks.length ? selectedBlocks.map(blockDisplayName).join(', ') : '—'} />
          </dl>
          <p className="text-sm text-slate-600">
            The workbook is prefilled with the {roster.length}-student {selectedClass} roster. Student IDs are already filled in — you only enter grades.
          </p>
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('assessment')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
            <button onClick={download} disabled={!canDownload} className={cn('flex items-center gap-2 rounded-xl px-5 py-3 font-semibold', canDownload ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}>
              <Download className="h-4 w-4" /> Download {workbookFileName(selectedClass, selectedSubjects.map(s => s.name))}
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 — UPLOAD */}
      {step === 'upload' && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Upload the completed workbook</h2>
          <p className="text-sm text-slate-600">Upload the {selectedClass} workbook you downloaded and filled in.</p>
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void ingestFile(f); }}
            className={cn('cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center', dragOver ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:border-teal-300 hover:bg-slate-50')}
          >
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void ingestFile(f); e.target.value = ''; }} />
            <FileSpreadsheet className="mx-auto mb-3 h-10 w-10 text-teal-600" />
            <p className="font-semibold text-slate-800">{fileName || 'Select or drop the grade workbook'}</p>
            <p className="mt-1 text-sm text-slate-500">Excel only, maximum 5 MB.</p>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep('download')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
          </div>
        </div>
      )}

      {/* STEP 5 — RESOLVE & VALIDATE */}
      {step === 'resolve' && parsed && resolveResult && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <CountCard label="Valid" count={resolveResult.validCount} color="teal" />
            <CountCard label="Errors" count={parseErrors.length + resolveResult.errors.length} color="red" />
            <CountCard label="Needs review" count={resolveResult.needsReview.length} color="amber" />
            <CountCard label="Excluded" count={resolveResult.excludedCount} color="slate" />
            <CountCard label="Students" count={resolveResult.validStudentCount} color="slate" />
          </div>

          {parseErrors.length > 0 && (
            <IssueList title={`Workbook errors (${parseErrors.length})`} tone="error" items={parseErrors.map(i => (i.cell ? `${i.cell}: ` : i.row ? `Row ${i.row}: ` : '') + i.message)} />
          )}
          {resolveResult.errors.length > 0 && (
            <IssueList title={`Authorization & roster errors (${resolveResult.errors.length})`} tone="error" items={resolveResult.errors.map(e => e.message)} />
          )}
          {resolveResult.needsReview.length > 0 && (
            <IssueList title={`Needs review (${resolveResult.needsReview.length})`} tone="warning" items={resolveResult.needsReview.map(e => e.message)} />
          )}

          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
            <span>{fileName} · {parsed.studentCount} rows · {parsed.subjects.length} subjects</span>
            <button onClick={() => { resetDownstream(); setStep('upload'); }} className="rounded p-1 hover:bg-slate-200"><X className="h-4 w-4" /></button>
          </div>

          <div className="flex items-center justify-between">
            <button onClick={() => setStep('upload')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
            <button
              disabled={!canValidate || submitting}
              onClick={() => void runServerValidation()}
              className={cn('flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold', canValidate && !submitting ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}
            >
              {submitting ? 'Validating on server…' : `Validate ${resolveResult.records.length} records`} <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 6 — REVIEW (server preview) */}
      {step === 'review' && serverPreview && resolveResult && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Review server-validated changes</h2>
            <p className="mt-1 text-slate-600">The server validated your roster, subjects, term, score limits, and duplicate keys. Nothing has been written yet.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <CountCard label="New grades" count={serverPreview.insertCount} color="teal" />
            <CountCard label="Grades changing" count={serverPreview.updateCount} color="amber" />
            <CountCard label="Records in upload" count={resolveResult.records.length} color="slate" />
          </div>
          {serverPreview.updateCount > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>{serverPreview.updateCount} existing grade{serverPreview.updateCount === 1 ? '' : 's'} will be updated.</strong> Existing scores are replaced using the same student, subject, exam type, assessment label, and term. Approval status resets to pending.
            </div>
          )}
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('resolve')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
            <button onClick={() => setStep('confirm')} className="flex items-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-sm font-bold text-white hover:bg-teal-700">Continue to confirm <ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      )}

      {/* STEP 7 — CONFIRM */}
      {step === 'confirm' && serverPreview && resolveResult && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-xl font-bold text-slate-900">Upload Summary</h2>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryItem label="Class" value={selectedClass} />
            <SummaryItem label="Subjects" value={selectedSubjects.map(s => s.name).join(', ')} />
            <SummaryItem label="Students" value={String(resolveResult.validStudentCount)} />
            <SummaryItem label="Assessment blocks" value={selectedBlocks.map(blockDisplayName).join(', ')} />
            <SummaryItem label="New grades" value={String(serverPreview.insertCount)} />
            <SummaryItem label="Grades changing" value={String(serverPreview.updateCount)} />
            <SummaryItem label="Errors" value="0" />
            <SummaryItem label="Needs review" value={String(resolveResult.needsReview.length)} />
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => { setStep('class'); setSelectedBlocks([]); setSelectedSubjectIds([]); resetDownstream(); setUploadKey(createUploadKey()); }}
              disabled={submitting}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('review')} disabled={submitting} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
              <button
                onClick={() => void confirmAndUpload()}
                disabled={submitting}
                className={cn('flex items-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-sm font-bold text-white hover:bg-teal-700', submitting && 'cursor-wait opacity-70')}
              >
                {submitting ? <>Submitting atomically…</> : <><Upload className="h-4 w-4" /> Confirm &amp; Upload</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ step, onStep }: { step: StepId; onStep: (s: StepId) => void }) {
  const currentIndex = STEPS.findIndex(s => s.id === step);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium sm:text-sm">
      {STEPS.map((s, index) => {
        const active = s.id === step;
        const done = index < currentIndex;
        return (
          <React.Fragment key={s.id}>
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 text-slate-300" />}
            <button
              onClick={() => onStep(s.id)}
              disabled={index > currentIndex}
              className={cn(
                'flex items-center gap-1 rounded-full px-3 py-1.5',
                active ? 'bg-teal-100 text-teal-700' : done ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-400',
              )}
            >
              {done && <CheckCircle2 className="h-3.5 w-3.5" />}{s.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-slate-800">{value || '—'}</dd>
    </div>
  );
}

function CountCard({ label, count, color }: { label: string; count: number; color: 'teal' | 'amber' | 'slate' | 'red' }) {
  const classes = color === 'teal' ? 'bg-teal-50 text-teal-800'
    : color === 'amber' ? 'bg-amber-50 text-amber-800'
    : color === 'red' ? 'bg-red-50 text-red-800'
    : 'bg-slate-100 text-slate-800';
  return (
    <div className={cn('rounded-xl p-4 text-center', classes)}>
      <p className="text-2xl font-bold">{count}</p>
      <p className="text-xs font-medium">{label}</p>
    </div>
  );
}

function IssueList({ title, items, tone }: { title: string; items: string[]; tone: 'error' | 'warning' }) {
  if (!items.length) return null;
  const classes = tone === 'error' ? 'border-red-200 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900';
  return (
    <div className={cn('rounded-2xl border p-5', classes)}>
      <h2 className="font-bold">{title}</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        {items.slice(0, 50).map((message, index) => <li key={index}>{message}</li>)}
        {items.length > 50 && <li>…and {items.length - 50} more.</li>}
      </ul>
    </div>
  );
}
