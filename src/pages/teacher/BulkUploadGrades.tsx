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
import { submitBulkGrades, type BulkGradeChange, type BulkGradeSubmissionResult } from '../../lib/db/bulkGrades';
import { getStudentsByClasses } from '../../lib/db/students';
import { ASSESSMENT_GROUPS, blockDisplayName } from '../../lib/bulk-grades/assessments';
import {
  buildRosterWorkbook,
  parseRosterWorkbook,
  workbookFileName,
  type WorkbookParseResult,
} from '../../lib/bulk-grades/workbook';
import { resolveWorkbook, type ResolveResult, type ReviewDecision } from '../../lib/bulk-grades/resolve';
import type { AssessmentLabel } from '../../lib/excel-parser';
import type { Student, Subject, Term } from '../../types';
import { MONTHS } from '../../types';
import { cn } from '../../utils/cn';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type StepId = 'class' | 'assessment' | 'upload' | 'resolve' | 'review' | 'confirm';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'class', label: '1. Class & Subjects' },
  { id: 'assessment', label: '2. Assessment' },
  { id: 'upload', label: '3. Upload' },
  { id: 'resolve', label: '4. Resolve & Validate' },
  { id: 'review', label: '5. Review' },
  { id: 'confirm', label: '6. Confirm' },
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
  // Manual Needs-Review decisions keyed by workbook rowNumber. "use" picks a
  // student (re-runs the full validation pipeline); "exclude" drops the row.
  const [reviewDecisions, setReviewDecisions] = useState<Record<number, ReviewDecision>>({});

  // Step 6/7 — server preview
  const [serverPreview, setServerPreview] = useState<BulkGradeSubmissionResult | null>(null);
  const [approvedAcknowledged, setApprovedAcknowledged] = useState(false);
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
    setApprovedAcknowledged(false);
    setReviewDecisions({});
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

  const allSubjectsSelected = classSubjects.length > 0 && selectedSubjectIds.length === classSubjects.length;
  const toggleAllSubjects = () => {
    setSelectedSubjectIds(allSubjectsSelected ? [] : classSubjects.map(s => s.id));
    resetDownstream();
  };

  const toggleBlock = (label: AssessmentLabel) => {
    setSelectedBlocks(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label]);
    resetDownstream();
  };

  const allBlockLabels = useMemo(
    () => ASSESSMENT_GROUPS.flatMap(group => group.blocks.map(block => block.label)),
    [],
  );
  const allBlocksSelected = allBlockLabels.length > 0 && selectedBlocks.length === allBlockLabels.length;
  const toggleAllBlocks = () => {
    setSelectedBlocks(allBlocksSelected ? [] : allBlockLabels);
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
      decisions: reviewDecisions,
    });
  }, [parsed, currentTerm, selectedClass, selectedSubjects, roster, month, date, reviewDecisions]);

  const parseErrors = useMemo(() => (parsed ? parsed.issues.filter(i => i.severity === 'error') : []), [parsed]);
  const blockingCount = (parseErrors.length) + (resolveResult ? resolveResult.errors.length : 0);
  const pendingReviews = resolveResult ? resolveResult.reviewCount : 0;
  // Cannot advance to the server preview while any row still needs review, or
  // while there are blocking parse/authorization errors, or with nothing valid.
  const canValidate = Boolean(
    resolveResult && resolveResult.records.length > 0 && blockingCount === 0 && pendingReviews === 0,
  );

  // Needs-Review actions: pick a student ("use") or drop the row ("exclude").
  // Both re-run the SAME resolver pipeline via reviewDecisions.
  const useReviewStudent = (rowNumber: number, studentId: string) => {
    setReviewDecisions(prev => ({ ...prev, [rowNumber]: { action: 'use', studentId } }));
    setServerPreview(null);
    setApprovedAcknowledged(false);
  };
  const excludeReviewRow = (rowNumber: number) => {
    setReviewDecisions(prev => ({ ...prev, [rowNumber]: { action: 'exclude' } }));
    setServerPreview(null);
    setApprovedAcknowledged(false);
  };
  const undoReviewDecision = (rowNumber: number) => {
    setReviewDecisions(prev => {
      const next = { ...prev };
      delete next[rowNumber];
      return next;
    });
    setServerPreview(null);
    setApprovedAcknowledged(false);
  };

  // Server-computed change lists for the Review step (old -> new).
  const changes = serverPreview?.changes ?? [];
  const approvedChanges = useMemo(() => changes.filter(c => c.isApproved), [changes]);
  const updateChanges = useMemo(() => changes.filter(c => c.changeType === 'update' && !c.isApproved), [changes]);
  const newChanges = useMemo(() => changes.filter(c => c.changeType === 'new'), [changes]);
  const requiresApprovedAck = Boolean(serverPreview?.requiresApprovedAcknowledgement);
  const canConfirm = !requiresApprovedAck || approvedAcknowledged;

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
      setApprovedAcknowledged(false);
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-700">Subjects</h2>
                {classSubjects.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleAllSubjects}
                    className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100"
                  >
                    {allSubjectsSelected ? 'Clear all' : 'Select all subjects'}
                  </button>
                )}
              </div>
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
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-700">Assessment blocks</h2>
                <p className="mb-3 text-xs text-slate-500">Maximum scores come from the shared assessment definitions and are enforced by the server.</p>
              </div>
              <button
                type="button"
                onClick={toggleAllBlocks}
                className="shrink-0 rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100"
              >
                {allBlocksSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
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
              onClick={() => setStep('upload')}
              className={cn('flex items-center gap-2 rounded-xl px-5 py-3 font-semibold', canDownload ? 'bg-teal-600 text-white hover:bg-teal-700' : 'cursor-not-allowed bg-slate-100 text-slate-400')}
            >
              Continue <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — DOWNLOAD */}
      {/* STEP 3 — UPLOAD */}
      {step === 'upload' && (
        <div className="max-w-3xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Upload the completed workbook</h2>
              <p className="text-sm text-slate-600">Upload the {selectedClass} workbook filled in with grades. Need the template? Download the roster-prefilled example (Student IDs already filled in) — optional.</p>
            </div>
            <button
              onClick={download}
              disabled={!canDownload}
              className={cn('flex shrink-0 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold', canDownload ? 'border border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100' : 'cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400')}
              title="Download the roster-prefilled example workbook"
            >
              <Download className="h-4 w-4" /> Download example
            </button>
          </div>
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
            <button onClick={() => setStep('assessment')} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"><ChevronLeft className="h-4 w-4" /> Back</button>
          </div>
        </div>
      )}

      {/* STEP 5 — RESOLVE & VALIDATE */}
      {step === 'resolve' && parsed && resolveResult && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <CountCard label="Valid" count={resolveResult.validCount} color="teal" />
            <CountCard label="Errors" count={parseErrors.length + resolveResult.errors.length} color="red" />
            <CountCard label="Needs Review" count={resolveResult.reviewCount} color="amber" />
            <CountCard label="Excluded" count={resolveResult.excludedCount} color="slate" />
            <CountCard label="Students" count={resolveResult.validStudentCount} color="slate" />
          </div>

          {/* NEEDS REVIEW — actionable legacy / name-only matches. Choose a
              student or exclude each row before continuing. */}
          {resolveResult.reviews.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h3 className="font-bold text-amber-900">Needs Review ({resolveResult.reviews.length})</h3>
              <p className="mt-1 text-sm text-amber-800">
                {resolveResult.reviews.length} item{resolveResult.reviews.length === 1 ? '' : 's'} still need review.
                Choose a student or exclude each row before continuing.
              </p>
              <div className="mt-4 space-y-3">
                {resolveResult.reviews.map(review => (
                  <div key={review.rowNumber} className="rounded-xl border border-amber-200 bg-white p-4">
                    <div className="font-semibold text-slate-900">{review.studentName || '(no name)'}</div>
                    <div className="text-xs text-slate-500">{selectedClass}</div>
                    <p className="mt-1 text-sm text-slate-600">{review.message}</p>
                    {review.candidates.length > 1 && (
                      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">Possible matches</p>
                    )}
                    <div className="mt-2 space-y-1">
                      {review.candidates.map(candidate => (
                        <button
                          key={candidate.id}
                          onClick={() => useReviewStudent(review.rowNumber, candidate.id)}
                          className="block w-full rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-left text-sm hover:bg-teal-100"
                          title={`Match this row to ${candidate.name}`}
                        >
                          <span className="font-medium text-slate-800">{candidate.name}</span>{' '}
                          <span className="text-slate-500">({candidate.className})</span>
                          <span className="ml-1 font-semibold text-teal-700">— Use this student</span>
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => excludeReviewRow(review.rowNumber)}
                      className="mt-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Exclude row
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resolved review decisions — visible so the reviewer sees what happened. */}
          {Object.keys(reviewDecisions).length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-bold text-slate-700">Reviewed rows ({Object.keys(reviewDecisions).length})</h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {Object.entries(reviewDecisions).map(([rowNumber, decision]) => {
                  const row = parsed.students.find(s => s.rowNumber === Number(rowNumber));
                  const name = row?.studentName || `Row ${rowNumber}`;
                  const chosen = decision.action === 'use'
                    ? roster.find(s => s.id === decision.studentId)
                    : null;
                  return (
                    <li key={rowNumber} className="flex items-center justify-between gap-3">
                      <span>
                        Row {rowNumber}: <span className="font-medium text-slate-800">{name}</span>{' '}
                        {decision.action === 'use'
                          ? <span className="text-teal-700">→ matched to {chosen?.name ?? decision.studentId}</span>
                          : <span className="text-slate-500">→ excluded</span>}
                      </span>
                      <button onClick={() => undoReviewDecision(Number(rowNumber))} className="rounded p-1 text-slate-400 hover:bg-slate-100" title="Undo"><X className="h-4 w-4" /></button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {parseErrors.length > 0 && (
            <IssueList title={`Workbook errors (${parseErrors.length})`} tone="error" items={parseErrors.map(i => (i.cell ? `${i.cell}: ` : i.row ? `Row ${i.row}: ` : '') + i.message)} />
          )}
          {resolveResult.errors.length > 0 && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-red-900">
              <h2 className="font-bold">Authorization &amp; roster errors ({resolveResult.errors.length})</h2>
              <ul className="mt-2 space-y-2 text-sm">
                {resolveResult.errors.slice(0, 50).map((error, index) => (
                  <li key={index} className="flex items-start justify-between gap-3">
                    <span className="flex items-start gap-2">
                      <span aria-hidden className="mt-1 text-red-400">•</span>
                      <span>{error.message}</span>
                    </span>
                    {typeof error.removableRow === 'number' && (
                      <button
                        type="button"
                        onClick={() => excludeReviewRow(error.removableRow!)}
                        className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
                      >
                        Remove row {error.removableRow}
                      </button>
                    )}
                  </li>
                ))}
                {resolveResult.errors.length > 50 && <li>…and {resolveResult.errors.length - 50} more.</li>}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
            <span>{fileName} · {parsed.studentCount} rows · {parsed.subjects.length} subjects</span>
            <button onClick={() => { resetDownstream(); setStep('upload'); }} className="rounded p-1 hover:bg-slate-200"><X className="h-4 w-4" /></button>
          </div>

          {pendingReviews > 0 && (
            <p className="text-sm font-medium text-amber-700">
              {pendingReviews} item{pendingReviews === 1 ? '' : 's'} still need review. Choose a student or exclude each row before continuing.
            </p>
          )}

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
        <div className="max-w-4xl space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="text-xl font-bold text-slate-900">Review server-validated changes</h2>
            <p className="mt-1 text-slate-600">The server validated your roster, subjects, term, score limits, and duplicate keys, and computed every change below from the existing records. Nothing has been written yet.</p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <CountCard label="New grades" count={serverPreview.insertCount} color="teal" />
              <CountCard label="Grades changing" count={serverPreview.updateCount} color="amber" />
              <CountCard label="Records in upload" count={resolveResult.records.length} color="slate" />
            </div>
          </div>

          {approvedChanges.length > 0 && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-5">
              <h3 className="font-bold text-red-900">Approved grades being changed ({approvedChanges.length})</h3>
              <p className="mt-1 text-sm text-red-800">These grades were already <strong>approved</strong>. Uploading will replace them and return them to <strong>Pending</strong> review.</p>
              <ChangeTable changes={approvedChanges} showStatus />
            </div>
          )}

          {updateChanges.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-white p-5">
              <h3 className="font-bold text-amber-900">Existing grades changing ({updateChanges.length})</h3>
              <p className="mt-1 text-sm text-slate-600">Existing values shown come from the database, not the workbook.</p>
              <ChangeTable changes={updateChanges} showStatus />
            </div>
          )}

          {newChanges.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="font-bold text-slate-800">New grades ({newChanges.length})</h3>
              <ChangeTable changes={newChanges} />
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
            <SummaryItem label="Approved grades changing" value={String(serverPreview.approvedChangeCount)} />
            <SummaryItem label="Errors" value="0" />
          </dl>

          {requiresApprovedAck && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <input
                type="checkbox"
                checked={approvedAcknowledged}
                onChange={e => setApprovedAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-red-300 text-red-600 focus:ring-red-500"
              />
              <span>I understand that the {serverPreview.approvedChangeCount} approved grade{serverPreview.approvedChangeCount === 1 ? '' : 's'} shown in the review will be replaced and returned to <strong>Pending</strong> review.</span>
            </label>
          )}

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
                disabled={submitting || !canConfirm}
                title={!canConfirm ? 'Acknowledge the approved-grade changes above to continue.' : undefined}
                className={cn('flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white', submitting ? 'cursor-wait bg-teal-600 opacity-70' : canConfirm ? 'bg-teal-600 hover:bg-teal-700' : 'cursor-not-allowed bg-slate-300')}
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

function formatCellValue(score: number | null, entryState: string | null): string {
  if (entryState === 'absent') return 'Absent';
  if (entryState === 'not_applicable') return 'N/A';
  if (score == null) return '—';
  return String(score);
}

function ChangeTable({ changes, showStatus = false }: { changes: BulkGradeChange[]; showStatus?: boolean }) {
  if (!changes.length) return null;
  return (
    <div className="mt-3 max-h-80 overflow-auto rounded-xl border border-slate-200">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="px-3 py-2">Student</th>
            <th className="px-3 py-2">Subject</th>
            <th className="px-3 py-2">Assessment</th>
            <th className="px-3 py-2">Current</th>
            <th className="px-3 py-2">New</th>
            {showStatus && <th className="px-3 py-2">Status</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {changes.map((c, index) => (
            <tr key={`${c.studentId}-${c.subjectId}-${c.assessmentLabel}-${index}`} className="bg-white">
              <td className="px-3 py-2 font-medium text-slate-800">{c.studentName || c.studentId}</td>
              <td className="px-3 py-2 text-slate-700">{c.subject}</td>
              <td className="px-3 py-2 text-slate-700">{blockDisplayName(c.assessmentLabel)}</td>
              <td className="px-3 py-2 text-slate-500">{c.changeType === 'new' ? '—' : formatCellValue(c.existingScore, c.existingEntryState)}</td>
              <td className="px-3 py-2 font-semibold text-slate-900">
                {c.changeType === 'update' && <span className="text-slate-400">→ </span>}
                {formatCellValue(c.newScore, c.newEntryState)}
              </td>
              {showStatus && (
                <td className="px-3 py-2">
                  {c.isApproved
                    ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Approved → Pending</span>
                    : <span className="text-xs text-slate-500">{c.existingStatus || 'pending'} → Pending</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
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
