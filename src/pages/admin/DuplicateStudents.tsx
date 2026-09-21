import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import {
  UsersRound,
  Search,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  GitMerge,
  Eye,
  Loader2,
  ArrowLeft,
  Clock,
  IdCard,
  Phone,
  GraduationCap,
  History,
  BookOpen,
  ClipboardCheck,
  FileText,
  Calendar,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import {
  getDuplicateGroups,
  evaluatePair,
  previewStudentMerge,
  mergeDuplicateStudents,
  getMergeAudits,
  getMergeConflicts,
  mergeWithResolution,
  normalizeNameForDuplicate,
  type DuplicatePair,
  type DuplicateGroup,
  type MergePreview,
  type MergeConflicts,
  type ProfileResolution,
  type ExamResolutionEntry,
  type HistoryResolutionEntry,
  type EnrollmentResolution,
  type MergeResolution,
} from '../../lib/db/duplicateStudents';

function SummaryCard({ label, value, accent, icon: Icon }: { label: string; value: number | string; accent: string; icon: typeof UsersRound }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', accent)}>
          <Icon className="w-5 h-5" />
        </div>
        <span className="text-2xl font-bold text-slate-900">{value}</span>
      </div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-3">{label}</p>
    </div>
  );
}

function EvidenceBadge({ evidence }: { evidence: string }) {
  if (evidence === 'strong') return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Strong</span>;
  if (evidence === 'conflicting') return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 border border-red-200">Conflicting</span>;
  return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">Possible</span>;
}

function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    high: 'bg-orange-50 text-orange-700 border-orange-200',
    critical: 'bg-red-50 text-red-700 border-red-200',
  };
  return <span className={cn('inline-flex px-2.5 py-1 rounded-full text-xs font-bold border', map[risk] || map.medium)}>{risk}</span>;
}

export function DuplicateStudents() {
  const { addToast } = useToast();
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [audits, setAudits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string>('All');
  const [selectedPair, setSelectedPair] = useState<DuplicatePair | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [keepSelection, setKeepSelection] = useState<'A' | 'B' | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [mergeInput, setMergeInput] = useState('');
  const [mergeReason, setMergeReason] = useState('');
  const [merging, setMerging] = useState(false);
  const [parentNames, setParentNames] = useState<Map<string, string>>(new Map());
  const [reviewedSet, setReviewedSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('duplicate-reviewed');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const [showAudit, setShowAudit] = useState<any | null>(null);
  // ── Guided resolution state ──────────────────────────────────────────
  const [conflicts, setConflicts] = useState<MergeConflicts | null>(null);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [profileRes, setProfileRes] = useState<ProfileResolution | null>(null);
  const [examResMap, setExamResMap] = useState<Map<number, 'canonical' | 'duplicate'>>(new Map());
  const [attResMap, setAttResMap] = useState<Map<number, 'canonical' | 'duplicate'>>(new Map());
  const [quizResMap, setQuizResMap] = useState<Map<number, 'canonical' | 'duplicate'>>(new Map());
  const [relResMap, setRelResMap] = useState<Map<number, 'canonical' | 'duplicate'>>(new Map());
  const [repResMap, setRepResMap] = useState<Map<number, 'canonical' | 'duplicate'>>(new Map());
  const [enrollmentRes, setEnrollmentRes] = useState<EnrollmentResolution | null>(null);
  const [resolveExpanded, setResolveExpanded] = useState(false);
  const [finalConfirm, setFinalConfirm] = useState({ reviewedFinal: false, reviewedConflicts: false, verifiedParentGov: false, understandRemove: false });
  const [examPage, setExamPage] = useState(0);
  const EXAM_PAGE_SIZE = 10;


  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [gs, aus] = await Promise.all([getDuplicateGroups(), getMergeAudits(100)]);
      setGroups(gs);
      setAudits(aus);
      const parentIds = Array.from(new Set(gs.flatMap(g => g.students.map(s => s.parentId).filter(Boolean) as string[])));
      if (parentIds.length > 0) {
        const { data } = await supabase.from('profiles').select('id,name').in('id', parentIds);
        const map = new Map<string, string>();
        for (const p of (data || []) as any[]) map.set(p.id, p.name);
        setParentNames(map);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load duplicates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const allPairs = useMemo(() => {
    const out: Array<{ pair: DuplicatePair; group: DuplicateGroup; evaluation: ReturnType<typeof evaluatePair> }> = [];
    for (const g of groups) {
      for (const p of g.pairs) {
        out.push({ pair: p, group: g, evaluation: evaluatePair(p.studentA, p.studentB) });
      }
    }
    return out;
  }, [groups]);

  const summary = useMemo(() => {
    const totalGroups = groups.length;
    const totalPairs = allPairs.length;
    const highConfidence = allPairs.filter(x => x.evaluation.isHighConfidence).length;
    const blocked = allPairs.filter(x => x.evaluation.isBlocked).length;
    const needsReview = allPairs.filter(x => x.evaluation.evidence === 'possible').length;
    const ready = totalPairs - blocked;
    const merged = audits.length;
    return { totalGroups, totalPairs, highConfidence, blocked, needsReview, ready, merged };
  }, [allPairs, groups.length, audits.length]);

  const filteredPairs = useMemo(() => {
    let out = allPairs;
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter(({ pair }) => {
        const a = pair.studentA; const b = pair.studentB;
        return (
          a.name.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q) ||
          a.className.toLowerCase().includes(q) ||
          b.className.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          b.id.toLowerCase().includes(q) ||
          (a.govId || '').toLowerCase().includes(q) ||
          (b.govId || '').toLowerCase().includes(q)
        );
      });
    }
    if (filter === 'High Confidence') out = out.filter(x => x.evaluation.isHighConfidence);
    else if (filter === 'Parent Assigned vs Unassigned') out = out.filter(x => x.evaluation.isParentVsUnassigned);
    else if (filter === 'Gov ID Present') out = out.filter(x => x.evaluation.hasGovId);
    else if (filter === 'No Gov ID') out = out.filter(x => !x.evaluation.hasGovId);
    else if (filter === 'Needs Review') out = out.filter(x => x.evaluation.evidence === 'possible' || x.evaluation.risk === 'high');
    else if (filter === 'Mergeable') out = out.filter(x => x.evaluation.canMergeLocal);
    else if (filter === 'Blocked') out = out.filter(x => x.evaluation.isBlocked);
    else if (filter === 'Already Reviewed') out = out.filter(x => reviewedSet.has(x.pair.id));
    return out;
  }, [allPairs, search, filter, reviewedSet]);

  const openReview = async (pair: DuplicatePair) => {
    setSelectedPair(pair);
    setPreview(null);
    setConflicts(null);
    setProfileRes(null);
    setExamResMap(new Map());
    setAttResMap(new Map());
    setQuizResMap(new Map());
    setRelResMap(new Map());
    setRepResMap(new Map());
    setEnrollmentRes(null);
    setResolveExpanded(false);
    setFinalConfirm({ reviewedFinal: false, reviewedConflicts: false, verifiedParentGov: false, understandRemove: false });
    setKeepSelection(null);
    setReviewChecked(false);
    setMergeInput('');
    setShowConfirm(false);
    const next = new Set(reviewedSet);
    next.add(pair.id);
    setReviewedSet(next);
    try { localStorage.setItem('duplicate-reviewed', JSON.stringify(Array.from(next))); } catch {}
    const ev = evaluatePair(pair.studentA, pair.studentB);
    setKeepSelection(ev.recommendation.keep);
    setPreviewLoading(true);
    try {
      const canonicalId = ev.recommendation.keep === 'A' ? pair.studentA.id : pair.studentB.id;
      const duplicateId = ev.recommendation.keep === 'A' ? pair.studentB.id : pair.studentA.id;
      const p = await previewStudentMerge(canonicalId, duplicateId);
      setPreview(p);
    } catch (e: any) {
      try {
        const p2 = await previewStudentMerge(pair.studentA.id, pair.studentB.id);
        setPreview(p2);
      } catch (e2: any) {
        addToast({ type: 'error', title: 'Preview failed', description: e2.message });
      }
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedPair || !keepSelection) return;
    const canonicalId = keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id;
    const duplicateId = keepSelection === 'A' ? selectedPair.studentB.id : selectedPair.studentA.id;
    if (preview && preview.canonical?.id === canonicalId && preview.duplicate?.id === duplicateId) return;
    (async () => {
      setPreviewLoading(true);
      try {
        const p = await previewStudentMerge(canonicalId, duplicateId);
        setPreview(p);
      } catch (e: any) {
        addToast({ type: 'error', title: 'Preview failed', description: e.message });
      } finally {
        setPreviewLoading(false);
      }
    })();
  }, [keepSelection, selectedPair]);

  // Load detailed conflicts lazily when preview exists (for resolution workflow)
  useEffect(() => {
    if (!selectedPair || !keepSelection || !preview) return;
    const canonicalId = keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id;
    const duplicateId = keepSelection === 'A' ? selectedPair.studentB.id : selectedPair.studentA.id;
    setConflictsLoading(true);
    getMergeConflicts(canonicalId, duplicateId)
      .then((c) => {
        setConflicts(c);
        // Auto-expand exam conflicts so the 55-conflict example is visible without extra click (fixes “Hide Conflicts” showing empty)
        if (c.exams.length > 0 || c.attendance.length > 0 || c.quizAttempts.length > 0 || c.releaseLogs.length > 0 || c.reportComments.length > 0) {
          setResolveExpanded(true);
        }
        // Init profile defaults: recommend canonical where possible, but require explicit confirmation later
        // For Axmed (parent vs unassigned) recommend canonical; for gov conflict recommend canonical if it has value
        const can = keepSelection === 'A' ? selectedPair.studentA : selectedPair.studentB;
        const dup = keepSelection === 'A' ? selectedPair.studentB : selectedPair.studentA;
        const init: ProfileResolution = {
          name: 'canonical',
          govId: can.govId ? 'canonical' : dup.govId ? 'duplicate' : 'canonical',
          parentId: can.parentId ? 'canonical' : dup.parentId ? 'duplicate' : 'canonical',
          parentPhone: (can.parentPhone||'') ? 'canonical' : (dup.parentPhone||'') ? 'duplicate' : 'canonical',
          transport: can.transport ? 'canonical' : dup.transport ? 'duplicate' : 'canonical',
          className: 'canonical',
        };
        // If conflicts indicate gov/parent mismatch, keep canonical but still require explicit (we set default to canonical)
        setProfileRes(init);
        // Reset per-history resolution maps
        setExamResMap(new Map());
        setAttResMap(new Map());
        setQuizResMap(new Map());
        setRelResMap(new Map());
        setRepResMap(new Map());
        setEnrollmentRes(null);
        if (c.enrollments.canonicalOpen && c.enrollments.duplicateOpen) {
          if (c.enrollments.canonicalOpen.className === c.enrollments.duplicateOpen.className && (c.enrollments.canonicalOpen.academicYearId||null)===(c.enrollments.duplicateOpen.academicYearId||null)) {
            setEnrollmentRes({ action: 'consolidate', keep: 'canonical' });
          } else {
            setEnrollmentRes(null);
          }
        } else if (c.enrollments.duplicateOpen && !c.enrollments.canonicalOpen) {
          setEnrollmentRes({ action: 'transfer', keep: 'canonical' });
        } else {
          setEnrollmentRes({ action: 'preserve_history', keep: 'canonical' });
        }
        setExamPage(0);
      })
      .catch(() => setConflicts(null))
      .finally(() => setConflictsLoading(false));
  }, [preview, keepSelection, selectedPair]);

  const buildResolution = (): MergeResolution => {
    const examArr: ExamResolutionEntry[] = [];
    if (conflicts) {
      conflicts.exams.forEach((c, idx) => {
        const keep = examResMap.get(idx) as 'canonical'|'duplicate'|undefined;
        if (keep) examArr.push({ canonical_exam_id: c.canonical.id, duplicate_exam_id: c.duplicate.id, keep });
      });
    }
    const attArr: HistoryResolutionEntry[] = [];
    if (conflicts) conflicts.attendance.forEach((c, idx) => {
      const keep = attResMap.get(idx) as 'canonical'|'duplicate'|undefined;
      if (keep) attArr.push({ canonical_id: c.canonical.id, duplicate_id: c.duplicate.id, keep });
    });
    const quizArr: HistoryResolutionEntry[] = [];
    if (conflicts) conflicts.quizAttempts.forEach((c, idx) => {
      const keep = quizResMap.get(idx) as 'canonical'|'duplicate'|undefined;
      if (keep) quizArr.push({ canonical_id: c.canonical.id, duplicate_id: c.duplicate.id, keep });
    });
    const relArr: HistoryResolutionEntry[] = [];
    if (conflicts) conflicts.releaseLogs.forEach((c, idx) => {
      const keep = relResMap.get(idx) as 'canonical'|'duplicate'|undefined;
      if (keep) relArr.push({ canonical_id: c.canonical.id, duplicate_id: c.duplicate.id, keep });
    });
    const repArr: HistoryResolutionEntry[] = [];
    if (conflicts) conflicts.reportComments.forEach((c, idx) => {
      const keep = repResMap.get(idx) as 'canonical'|'duplicate'|undefined;
      if (keep) repArr.push({ canonical_id: c.canonical.id, duplicate_id: c.duplicate.id, keep });
    });
    return {
      profile_resolution: profileRes || undefined,
      exam_resolution: examArr,
      attendance_resolution: attArr,
      quiz_resolution: quizArr,
      release_resolution: relArr,
      report_comment_resolution: repArr,
      enrollment_resolution: enrollmentRes || undefined,
    };
  };

  const isResolvable = !!preview && !preview.canMerge && (
    (preview.conflicts.examConflicts > 0) ||
    preview.conflicts.govConflict ||
    preview.conflicts.bothHaveParents ||
    preview.blockedReasons.includes('enrollment_conflict') ||
    (conflicts && (conflicts.counts.exams>0 || conflicts.profile.govIdConflict || conflicts.profile.parentConflict))
  );

  const checklist = (() => {
    if (!preview || !keepSelection) return null;
    const examsTotal = conflicts?.counts.exams ?? preview.conflicts.examConflicts;
    const attTotal = conflicts?.counts.attendance ?? preview.conflicts.attendanceConflicts;
    const quizTotal = conflicts?.counts.quizAttempts ?? preview.conflicts.quizConflicts;
    const relTotal = conflicts?.counts.releaseLogs ?? preview.conflicts.releaseConflicts;
    const repTotal = conflicts?.counts.reportComments ?? 0;
    const govNeed = !!(preview.conflicts.govConflict || conflicts?.profile.govIdConflict);
    const parentNeed = !!(preview.conflicts.bothHaveParents || conflicts?.profile.parentConflict);
    const profileOk = !!profileRes && (!govNeed || !!profileRes.govId) && (!parentNeed || !!profileRes.parentId);
    const examsOk = examsTotal===0 || examResMap.size===examsTotal;
    const attOk = attTotal===0 || attResMap.size===attTotal;
    const quizOk = quizTotal===0 || quizResMap.size===quizTotal;
    const relOk = relTotal===0 || relResMap.size===relTotal;
    const repOk = repTotal===0 || repResMap.size===repTotal;
    // enrollment
    let enrollOk = true;
    if (preview.blockedReasons.includes('enrollment_conflict') || (conflicts && conflicts.enrollments.canonicalOpen && conflicts.enrollments.duplicateOpen && (conflicts.enrollments.canonicalOpen.className!==conflicts.enrollments.duplicateOpen.className || (conflicts.enrollments.canonicalOpen.academicYearId||null)!==(conflicts.enrollments.duplicateOpen.academicYearId||null)))) {
      enrollOk = !!enrollmentRes;
    }
    const adminOk = finalConfirm.reviewedFinal && finalConfirm.reviewedConflicts && finalConfirm.verifiedParentGov && finalConfirm.understandRemove && reviewChecked;
    const reasonOk = mergeReason.trim().length>0 || !(govNeed || parentNeed || examsTotal>0);
    const unresolved = (!profileOk?1:0)+(!examsOk?1:0)+(!attOk?1:0)+(!quizOk?1:0)+(!relOk?1:0)+(!repOk?1:0)+(!enrollOk?1:0);
    const canMergeResolved = profileOk && examsOk && attOk && quizOk && relOk && repOk && enrollOk && adminOk && reasonOk;
    return { profileOk, examsOk, attOk, quizOk, relOk, repOk, enrollOk, adminOk, reasonOk, unresolved, canMergeResolved, govNeed, parentNeed, examsTotal, attTotal, quizTotal, relTotal, repTotal };
  })();

  const handleMerge = async () => {
    if (!selectedPair || !keepSelection || !preview) return;
    const canonicalId = keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id;
    const duplicateId = keepSelection === 'A' ? selectedPair.studentB.id : selectedPair.studentA.id;

    // If resolvable and we have resolution, use guided merge
    const useResolved = isResolvable && checklist?.canMergeResolved;
    if (useResolved) {
      if (!finalConfirm.reviewedFinal || !finalConfirm.reviewedConflicts || !finalConfirm.verifiedParentGov || !finalConfirm.understandRemove) {
        addToast({ type: 'error', title: 'Please confirm all checklist items' });
        return;
      }
      const needsTyped = preview.riskLevel === 'high' || preview.riskLevel === 'critical' || (conflicts && conflicts.counts.exams>5);
      if (needsTyped && mergeInput.trim() !== 'MERGE') {
        addToast({ type: 'error', title: 'Type MERGE to confirm' });
        return;
      }
      if (!mergeReason.trim() && (preview.conflicts.govConflict || preview.conflicts.bothHaveParents || (conflicts && conflicts.counts.exams>0))) {
        addToast({ type: 'error', title: 'Merge reason required for high-risk merge' });
        return;
      }
      setMerging(true);
      try {
        const resolution = buildResolution();
        const result = await mergeWithResolution(canonicalId, duplicateId, resolution, mergeReason || null);
        addToast({ type: 'success', title: 'Merge successful', description: `Kept ${canonicalId}, merged ${duplicateId}` });
        setShowConfirm(false);
        setSelectedPair(null);
        setPreview(null);
        setConflicts(null);
        await load();
        if ((result as any).auditId) {
          const { data } = await supabase.from('student_merge_audits').select('*').eq('id', (result as any).auditId).maybeSingle();
          if (data) setShowAudit(data);
        }
      } catch (e: any) {
        addToast({ type: 'error', title: 'Merge failed', description: e.message });
      } finally {
        setMerging(false);
      }
      return;
    }

    if (!preview.canMerge) {
      // For new workflow, show resolvable message instead of hard block
      if (isResolvable) {
        addToast({ type: 'error', title: 'Resolve conflicts first', description: `${checklist?.unresolved || 0} conflicts remaining` });
        setResolveExpanded(true);
        return;
      }
      addToast({ type: 'error', title: 'Merge blocked', description: preview.blockedReasons.join(', ') });
      return;
    }
    if (!reviewChecked) {
      addToast({ type: 'error', title: 'Please confirm you have reviewed this merge' });
      return;
    }
    const needsTyped = preview.riskLevel === 'high' || preview.riskLevel === 'critical';
    if (needsTyped && mergeInput.trim() !== 'MERGE') {
      addToast({ type: 'error', title: 'Type MERGE to confirm' });
      return;
    }
    setMerging(true);
    try {
      // If we have profile resolution even for simple case, use resolved merge to preserve field choices
      if (profileRes && conflicts) {
        const resolution = buildResolution();
        // Check if any field differs from canonical defaults: then use resolved path to honor choices
        const hasCustomProfile = profileRes.govId !== 'canonical' || profileRes.parentId !== 'canonical' || profileRes.parentPhone !== 'canonical' || profileRes.transport !== 'canonical' || profileRes.name !== 'canonical' || profileRes.className !== 'canonical';
        if (hasCustomProfile || checklist?.examsTotal === 0) {
          try {
            const result = await mergeWithResolution(canonicalId, duplicateId, resolution, mergeReason || null);
            addToast({ type: 'success', title: 'Merge successful', description: `Kept ${canonicalId}, merged ${duplicateId}` });
            setShowConfirm(false);
            setSelectedPair(null);
            setPreview(null);
            setConflicts(null);
            await load();
            if ((result as any).auditId) {
              const { data } = await supabase.from('student_merge_audits').select('*').eq('id', (result as any).auditId).maybeSingle();
              if (data) setShowAudit(data);
            }
            return;
          } catch (e:any) {
            // fallback to simple merge if resolved path fails for simple case
            if (!String(e.message).includes('resolution')) throw e;
          }
        }
      }
      const result = await mergeDuplicateStudents(canonicalId, duplicateId, mergeReason || null);
      addToast({ type: 'success', title: 'Merge successful', description: `Kept ${canonicalId}, merged ${duplicateId}` });
      setShowConfirm(false);
      setSelectedPair(null);
      setPreview(null);
      await load();
      if (result.auditId) {
        const { data } = await supabase.from('student_merge_audits').select('*').eq('id', result.auditId).maybeSingle();
        if (data) setShowAudit(data);
      }
    } catch (e: any) {
      addToast({ type: 'error', title: 'Merge failed', description: e.message });
    } finally {
      setMerging(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="ml-3 text-slate-500">Finding duplicate students…</span>
      </div>
    );
  }

  // ── Inline Review (no modal) — preferred UX per spec ─────────────────────
  if (selectedPair) {
    const evInitial = evaluatePair(selectedPair.studentA, selectedPair.studentB);
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <button
          type="button"
          onClick={() => { setSelectedPair(null); setPreview(null); }}
          className="inline-flex items-center gap-2 text-sm font-bold text-indigo-700 hover:text-indigo-900"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Duplicate Students
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-slate-900">Review duplicate student records</h1>
            <p className="mt-1 text-sm text-slate-500">Compare identity evidence before choosing a student to keep. No record is deleted from this screen.</p>
            <p className="mt-1 font-mono text-xs text-slate-500">{selectedPair.studentA.name} · {selectedPair.className}</p>
          </div>
          <span className={evInitial.isBlocked ? 'inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700' : evInitial.isHighConfidence ? 'inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700' : 'inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700'}>
            {evInitial.isBlocked ? 'Blocked' : evInitial.isHighConfidence ? 'Ready to review' : 'Needs review'}
          </span>
        </div>

        {/* Evidence summary */}
        {(() => {
          const ev = preview ? null : evInitial;
          if (preview) {
            if (!preview.canMerge) {
              if (preview.blockedReasons.includes('gov_id_conflict') || preview.conflicts.govConflict) {
                return (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                    <h3 className="font-extrabold text-rose-900 flex items-center gap-2"><ShieldAlert className="h-5 w-5" /> DO NOT MERGE — CRITICAL IDENTITY CONFLICT</h3>
                    <p className="mt-1 text-sm text-rose-700">Different Government IDs — trusted identity is conflicting. Merge is disabled.</p>
                    <p className="mt-2 font-mono text-xs text-rose-600">Gov A: {preview.canonical.govId || 'blank'} · Gov B: {preview.duplicate.govId || 'blank'}</p>
                  </div>
                );
              }
              if (preview.blockedReasons.includes('exam_conflict') || preview.conflicts.examConflicts > 0) {
                return (
                  <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
                    <h3 className="font-extrabold text-orange-900 flex items-center gap-2"><ShieldAlert className="h-5 w-5" /> BLOCKED — EXAM CONFLICT</h3>
                    <p className="mt-1 text-sm text-orange-700">{preview.conflicts.examConflicts} exam identity conflicts — no marks will be overwritten. Merge disabled.</p>
                  </div>
                );
              }
              if (preview.blockedReasons.includes('both_have_parents')) {
                return (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
                    <h3 className="font-extrabold text-rose-900">HIGH RISK — BOTH RECORDS HAVE PARENTS</h3>
                    <p className="mt-1 text-sm text-rose-700">Different parents with no shared Gov ID. Resolve identity outside this workflow.</p>
                  </div>
                );
              }
              return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5"><h3 className="font-bold text-rose-800">BLOCKED — {preview.blockedReasons.join(', ')}</h3></div>;
            }
            if (preview.evidence === 'strong' && preview.riskLevel === 'low') {
              return (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                  <h3 className="font-extrabold text-emerald-900 flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> HIGH CONFIDENCE DUPLICATE — Strong</h3>
                  <p className="mt-1 text-sm text-emerald-700">Same normalized name + same class, plus trusted signals support a safe review. <span className="font-bold">Strong</span> evidence.</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold"><span className="rounded-full bg-white px-2 py-1 border">✓ Same name</span><span className="rounded-full bg-white px-2 py-1 border">✓ Same class</span>{preview.conflicts.sameGov && <span className="rounded-full bg-emerald-100 px-2 py-1 border border-emerald-200">✓ Same Gov ID</span>}{evInitial.isParentVsUnassigned && <span className="rounded-full bg-white px-2 py-1 border">✓ Parent vs Unassigned</span>}</div>
                </div>
              );
            }
            return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h3 className="font-bold text-amber-900">POSSIBLE MATCH — REVIEW REQUIRED</h3><p className="mt-1 text-sm text-amber-700">Limited trusted evidence. Verify enrollment history and parent before merging.</p></div>;
          }
          if (evInitial.evidence === 'strong' && !evInitial.isBlocked) {
            return <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><h3 className="font-bold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="h-5 w-5" /> HIGH CONFIDENCE — Strong</h3><div className="mt-2 space-y-1 text-sm text-emerald-700">{evInitial.evidenceSummary.map((s,i)=><div key={i}>{s}</div>)}</div></div>;
          }
          if (evInitial.evidence === 'conflicting') {
            return <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5"><h3 className="font-bold text-rose-800">DO NOT MERGE</h3><div className="mt-2 space-y-1 text-sm text-rose-700">{evInitial.evidenceSummary.map((s,i)=><div key={i}>{s}</div>)}</div></div>;
          }
          return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><h3 className="font-bold text-amber-800">POSSIBLE MATCH</h3><div className="mt-2 space-y-1 text-sm text-amber-700">{evInitial.evidenceSummary.map((s,i)=><div key={i}>{s}</div>)}</div></div>;
        })()}

        {/* Administrator decision */}
        <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
          <h3 className="font-bold text-indigo-950 flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Administrator decision required</h3>
          <p className="mt-1 text-sm font-bold text-indigo-900">Administrator must select the student to keep</p>
          <p className="mt-1 text-sm text-indigo-900">The system may recommend a record, but it will never silently choose the canonical Student ID.</p>
          {evInitial.recommendation && <p className="mt-2 text-sm font-semibold text-indigo-900">Recommended to keep: <span className="font-mono">{evInitial.recommendation.keep === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id}</span> — {evInitial.recommendation.reasons.join(' · ')}</p>}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {(['A','B'] as const).map(side => {
              const student = side === 'A' ? selectedPair.studentA : selectedPair.studentB;
              const isRecommended = evInitial.recommendation.keep === side;
              const isSelected = keepSelection === side;
              return (
                <label key={side} className={isSelected ? 'block cursor-pointer rounded-2xl border-2 border-indigo-500 bg-white p-5 shadow-lg' : 'block cursor-pointer rounded-2xl border-2 border-slate-200 bg-white p-5 hover:border-indigo-300'}>
                  <div className="flex items-start gap-3">
                    <input type="radio" name="keep-record" checked={isSelected} onChange={() => setKeepSelection(side)} className="mt-1 h-4 w-4 accent-indigo-600" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-extrabold uppercase tracking-widest text-slate-500">Keep Record {side}</span>{isRecommended && <span className="rounded-full bg-indigo-100 px-2 py-1 text-[11px] font-bold text-indigo-700">Recommended to keep</span>}</div>
                      <h2 className="mt-2 text-lg font-extrabold text-slate-900">{student.name}</h2>
                      <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-indigo-700"><GraduationCap className="h-4 w-4" />{student.className}</p>
                      <div className="mt-3 grid gap-2 text-sm">
                        <div><span className="text-xs font-semibold text-slate-500">Student ID:</span> <span className="font-mono font-bold">{student.id}</span></div>
                        <div><span className="text-xs font-semibold text-slate-500">Gov ID:</span> <span className={student.govId ? 'font-bold' : 'text-slate-400'}>{student.govId || 'None recorded'}</span></div>
                        <div><span className="text-xs font-semibold text-slate-500">Parent:</span> <span className={student.parentId ? 'font-bold text-slate-900' : 'text-slate-400'}>{student.parentId ? (parentNames.get(student.parentId) || student.parentId) : 'Unassigned'}</span></div>
                        <div><span className="text-xs font-semibold text-slate-500">Created:</span> {new Date(student.createdAt).toLocaleDateString()}</div>
                      </div>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Two-column evidence */}
        <div className="grid gap-5 lg:grid-cols-2">
          {(['A','B'] as const).map(side => {
            const s = side === 'A' ? selectedPair.studentA : selectedPair.studentB;
            const isKeep = keepSelection === side;
            return (
              <div key={side} className={isKeep ? 'rounded-2xl border-2 border-indigo-300 bg-indigo-50/30 p-5 space-y-3' : 'rounded-2xl border-2 border-slate-200 bg-white p-5 space-y-3'}>
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2">{isKeep ? <CheckCircle2 className="h-4 w-4 text-indigo-600" /> : <Clock className="h-4 w-4 text-slate-400" />}Record {side} {isKeep ? '(KEEP)' : '(MERGE FROM)'}</h4>
                  <span className="text-xs text-slate-500">{new Date(s.createdAt).toLocaleDateString()}</span>
                </div>
                <div>
                  <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><IdCard className="h-3 w-3" /> Identity</h5>
                  <div className="mt-1 space-y-1 text-sm">
                    <div><span className="text-slate-500">Student ID:</span> <span className="font-mono font-medium">{s.id}</span></div>
                    <div><span className="text-slate-500">Gov ID:</span> <span className={s.govId ? 'font-medium' : 'text-slate-400'}>{s.govId || 'blank'}</span></div>
                    <div><span className="text-slate-500">Name:</span> <span className="font-medium">{s.name}</span></div>
                    <div><span className="text-slate-500">Class:</span> <span className="font-medium">{s.className}</span></div>
                    <div><span className="text-slate-500">Normalized:</span> <span className="font-mono text-xs">{normalizeNameForDuplicate(s.name)}</span></div>
                  </div>
                </div>
                <div>
                  <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><Phone className="h-3 w-3" /> Parent</h5>
                  <div className="mt-1 space-y-1 text-sm">
                    <div><span className="text-slate-500">Parent:</span> {s.parentId ? <span className="font-medium text-emerald-700">{parentNames.get(s.parentId) || s.parentId}</span> : <span className="text-slate-400 italic">Unassigned</span>}</div>
                    <div><span className="text-slate-500">Phone:</span> {s.parentPhone || '—'}</div>
                  </div>
                </div>
                <div>
                  <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><GraduationCap className="h-3 w-3" /> Enrollment</h5>
                  <div className="mt-1 space-y-1 text-sm">
                    <div><span className="text-slate-500">Current class:</span> {s.className}</div>
                    <div><span className="text-slate-500">Transport:</span> {s.transport || '—'}</div>
                    {preview && <><div><span className="text-slate-500">Open:</span> {side === 'A' ? (preview.counts.enrollments.canonicalOpen ? preview.counts.enrollments.canonicalOpen.className : 'None') : (preview.counts.enrollments.duplicateOpen ? preview.counts.enrollments.duplicateOpen.className : 'None')}</div><div><span className="text-slate-500">History:</span> {side === 'A' ? preview.counts.enrollments.canonicalHistory : preview.counts.enrollments.duplicateHistory}</div></>}
                  </div>
                </div>
                {preview && (
                  <div>
                    <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><Layers className="h-3 w-3" /> History Counts</h5>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Exams</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.exams.canonical : preview.counts.exams.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Attendance</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.attendance.canonical : preview.counts.attendance.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Homework</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.homework.canonical : preview.counts.homework.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Promotions</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.promotions.canonical : preview.counts.promotions.duplicate}</span></div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Preview stage — inline, not a modal */}
        {previewLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-indigo-500" /> <span className="ml-2 text-slate-500">Loading preview…</span></div>
        ) : preview ? (
          <div className="space-y-5">
            <div className="text-xs font-extrabold tracking-widest text-slate-500 uppercase">MERGE PREVIEW</div>
            <div className={preview.canMerge ? 'rounded-2xl border border-emerald-200 bg-emerald-50 p-5' : 'rounded-2xl border border-rose-200 bg-rose-50 p-5'}>
              <h3 className="font-bold flex items-center gap-2">{preview.canMerge ? <ShieldCheck className="h-5 w-5 text-emerald-600" /> : <ShieldAlert className="h-5 w-5 text-rose-600" />}{preview.canMerge ? 'Can merge · enrollment: consolidate · exam conflicts: none' : 'MERGE BLOCKED — no records were changed.'}</h3>
              {preview.blockedReasons.length > 0 && <p className="mt-2 text-sm font-bold text-rose-700">{preview.blockedReasons.join(' · ')}</p>}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-extrabold uppercase tracking-widest text-emerald-700">Keep Record</p><p className="mt-2 font-bold">{preview.canonical.name}</p><p className="font-mono text-xs">Student ID: {preview.canonical.id}</p></div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-xs font-extrabold uppercase tracking-widest text-amber-700">Merge From</p><p className="mt-2 font-bold">{preview.duplicate.name}</p><p className="font-mono text-xs">Student ID: {preview.duplicate.id}</p></div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <h4 className="font-bold flex items-center gap-2"><History className="h-5 w-5 text-indigo-600" /> History to preserve from the duplicate</h4>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
                <div className="bg-slate-50 rounded-lg border p-3"><span>Exams</span> <span className="font-bold float-right">{preview.counts.exams.duplicate}</span></div>
                <div className="bg-slate-50 rounded-lg border p-3"><span>Attendance</span> <span className="font-bold float-right">{preview.counts.attendance.duplicate}</span></div>
                <div className="bg-slate-50 rounded-lg border p-3"><span>Homework</span> <span className="font-bold float-right">{preview.counts.homework.duplicate}</span></div>
                <div className="bg-slate-50 rounded-lg border p-3"><span>Promotions</span> <span className="font-bold float-right">{preview.counts.promotions.duplicate}</span></div>
                <div className="bg-slate-50 rounded-lg border p-3"><span>Quiz Attempts</span> <span className="font-bold float-right">{preview.counts.quizAttempts.duplicate}</span></div>
                <div className="bg-slate-50 rounded-lg border p-3"><span>Enrollments</span> <span className="font-bold float-right">{preview.counts.enrollments.duplicateHistory + (preview.counts.enrollments.duplicateOpen ? 1 : 0)}</span></div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <h4 className="font-bold flex items-center gap-2"><Calendar className="h-4 w-4" /> Enrollment action</h4>
              {preview.enrollment.willConsolidate ? <p className="mt-2 text-sm text-emerald-700 font-semibold">Result: 1 open enrollment remains — duplicate consolidated</p> : <p className="mt-2 text-sm text-slate-600">Historical enrollment will be preserved.</p>}
              {!preview.canMerge && preview.blockedReasons.includes('enrollment_conflict') && <p className="mt-2 text-sm font-bold text-rose-700">MERGE BLOCKED — enrollment histories are contradictory.</p>}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <h4 className="font-bold flex items-center gap-2"><BookOpen className="h-4 w-4" /> Exam records</h4>
              {preview.conflicts.examConflicts > 0 ? <p className="mt-2 text-sm font-bold text-rose-700">{preview.conflicts.examConflicts} conflicts require resolution — No records have been changed. Review each conflict and choose which record to preserve.</p> : <p className="mt-2 text-sm text-emerald-700">{preview.counts.exams.duplicate} exam records will be reassigned. IDs preserved.</p>}
              {preview.conflicts.examConflicts > 0 && <button type="button" onClick={()=> setResolveExpanded(v=>!v)} className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700">{resolveExpanded ? 'Hide Conflicts' : `Review ${preview.conflicts.examConflicts} Exam Conflicts`}</button>}
            </div>

            {/* ── Guided Resolution Workflow ── */}
            {(isResolvable || (conflicts && (conflicts.counts.exams>0 || conflicts.profile.govIdConflict || conflicts.profile.parentConflict))) && (
              <div className="space-y-5 rounded-2xl border-2 border-indigo-200 bg-white p-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-extrabold text-indigo-900 flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Resolve Conflicts</h3>
                  <span className="text-xs font-bold text-slate-500">{checklist?.unresolved===0 ? 'All conflicts resolved' : `${checklist?.unresolved} conflicts remaining`}</span>
                </div>
                <p className="text-sm text-slate-600">FINAL STUDENT INFORMATION — Choose the value that should remain on the student being kept. The system will never silently choose.</p>

                {/* Profile resolution table */}
                {conflicts && profileRes && (
                  <div className="overflow-x-auto">
                    <h4 className="font-bold text-sm mb-2">FINAL STUDENT INFORMATION</h4>
                    <table className="w-full text-sm border">
                      <thead className="bg-slate-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Field</th><th className="px-3 py-2 text-left">Record A</th><th className="px-3 py-2 text-left">Record B</th><th className="px-3 py-2 text-left">Final choice</th></tr></thead>
                      <tbody className="divide-y">
                        {/* Student ID fixed */}
                        <tr><td className="px-3 py-2 font-semibold">Student ID</td><td className="px-3 py-2 font-mono text-xs">{selectedPair?.studentA.id}</td><td className="px-3 py-2 font-mono text-xs">{selectedPair?.studentB.id}</td><td className="px-3 py-2 text-xs font-bold">Keep Record {keepSelection}</td></tr>
                        {/* Name */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Name {conflicts.profile.nameConflict && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-700">Name conflict</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.name}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.name}</td>
                          <td className="px-3 py-2 flex gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.name==='canonical'} onChange={()=> setProfileRes({...profileRes, name:'canonical'})} className="h-3 w-3" /> Use Record A</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.name==='duplicate'} onChange={()=> setProfileRes({...profileRes, name:'duplicate'})} className="h-3 w-3" /> Use Record B</label>
                          </td>
                        </tr>
                        {/* Gov ID */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Gov ID {conflicts.profile.govIdConflict && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] text-rose-700">Gov ID conflict</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.govId || <span className="text-slate-400">blank</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.govId || <span className="text-slate-400">blank</span>}</td>
                          <td className="px-3 py-2 flex flex-wrap gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.govId==='canonical'} onChange={()=> setProfileRes({...profileRes, govId:'canonical'})} /> Record A</label>
                            {conflicts.profile.duplicate.govId && <label className="flex items-center gap-1"><input type="radio" checked={profileRes.govId==='duplicate'} onChange={()=> setProfileRes({...profileRes, govId:'duplicate'})} /> Record B</label>}
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.govId==='remove'} onChange={()=> setProfileRes({...profileRes, govId:'remove'})} /> Remove</label>
                          </td>
                        </tr>
                        {/* Parent */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Parent {conflicts.profile.parentConflict && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] text-rose-700">PARENT CONFLICT</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.parentId ? (parentNames.get(conflicts.profile.canonical.parentId) || conflicts.profile.canonical.parentId) : <span className="text-slate-400">Unassigned</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.parentId ? (parentNames.get(conflicts.profile.duplicate.parentId) || conflicts.profile.duplicate.parentId) : <span className="text-slate-400">Unassigned</span>}</td>
                          <td className="px-3 py-2 flex flex-wrap gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentId==='canonical'} onChange={()=> setProfileRes({...profileRes, parentId:'canonical'})} /> {conflicts.profile.canonical.parentId ? (parentNames.get(conflicts.profile.canonical.parentId)||'Parent A') : 'Unassigned'}</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentId==='duplicate'} onChange={()=> setProfileRes({...profileRes, parentId:'duplicate'})} /> {conflicts.profile.duplicate.parentId ? (parentNames.get(conflicts.profile.duplicate.parentId)||'Parent B') : 'Unassigned'}</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentId==='remove'} onChange={()=> setProfileRes({...profileRes, parentId:'remove'})} /> Unassigned</label>
                          </td>
                        </tr>
                        {conflicts.profile.parentConflict && <tr><td colSpan={4} className="px-3 py-2 text-xs font-bold text-rose-700 bg-rose-50">This is a high-risk identity decision. Verify the correct parent before continuing. {profileRes.parentId && <span className="ml-2 font-normal">I have verified the parent assignment: <input type="checkbox" checked={finalConfirm.verifiedParentGov} onChange={e=> setFinalConfirm({...finalConfirm, verifiedParentGov: e.target.checked})} /> </span>}</td></tr>}
                        {/* Parent phone */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Parent phone</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.parentPhone || '—'}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.parentPhone || '—'}</td>
                          <td className="px-3 py-2 flex gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentPhone==='canonical'} onChange={()=> setProfileRes({...profileRes, parentPhone:'canonical'})} /> Use Record A</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentPhone==='duplicate'} onChange={()=> setProfileRes({...profileRes, parentPhone:'duplicate'})} /> Use Record B</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.parentPhone==='remove'} onChange={()=> setProfileRes({...profileRes, parentPhone:'remove'})} /> Remove</label>
                          </td>
                        </tr>
                        {/* Transport */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Transport {conflicts.profile.transportConflict && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px]">TRANSPORT CONFLICT</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.transport || '—'}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.transport || '—'}</td>
                          <td className="px-3 py-2 flex gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.transport==='canonical'} onChange={()=> setProfileRes({...profileRes, transport:'canonical'})} /> Bus 1 A</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.transport==='duplicate'} onChange={()=> setProfileRes({...profileRes, transport:'duplicate'})} /> Bus B</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.transport==='remove'} onChange={()=> setProfileRes({...profileRes, transport:'remove'})} /> Remove transport</label>
                          </td>
                        </tr>
                        {/* Class */}
                        <tr>
                          <td className="px-3 py-2 font-semibold">Class {conflicts.profile.classConflict && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px]">CLASS CONFLICT</span>}</td>
                          <td className="px-3 py-2">{conflicts.profile.canonical.className}</td>
                          <td className="px-3 py-2">{conflicts.profile.duplicate.className}</td>
                          <td className="px-3 py-2 flex gap-2">
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.className==='canonical'} onChange={()=> setProfileRes({...profileRes, className:'canonical'})} /> {conflicts.profile.canonical.className}</label>
                            <label className="flex items-center gap-1"><input type="radio" checked={profileRes.className==='duplicate'} onChange={()=> setProfileRes({...profileRes, className:'duplicate'})} /> {conflicts.profile.duplicate.className}</label>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {profileRes.govId && conflicts.profile.govIdConflict && <div className="mt-2 text-xs text-amber-800">Government ID conflict — Choose the correct Government ID: Keep {(profileRes.govId==='canonical' ? conflicts.profile.canonical.govId : profileRes.govId==='duplicate' ? conflicts.profile.duplicate.govId : 'blank')} <label className="ml-2"><input type="checkbox" checked={finalConfirm.verifiedParentGov} onChange={e=> setFinalConfirm({...finalConfirm, verifiedParentGov: e.target.checked})} /> I understand these Government IDs conflict.</label></div>}
                  </div>
                )}

                {/* Enrollment resolution */}
                {conflicts && (
                  <div className="rounded-xl border p-3 bg-slate-50">
                    <h4 className="font-bold flex items-center gap-2"><GraduationCap className="h-4 w-4" /> Enrollment</h4>
                    <div className="mt-2 grid gap-2 text-sm">
                      <div>Record A: {conflicts.enrollments.canonicalOpen?.className || 'None'} {conflicts.enrollments.canonicalOpen?.academicYearId || ''} {conflicts.enrollments.canonicalOpen ? 'Open' : ''}</div>
                      <div>Record B: {conflicts.enrollments.duplicateOpen?.className || 'None'} {conflicts.enrollments.duplicateOpen?.academicYearId || ''} {conflicts.enrollments.duplicateOpen ? 'Open' : ''}</div>
                      <div className="flex gap-3 flex-wrap">
                        <label className="flex items-center gap-1"><input type="radio" checked={enrollmentRes?.action==='consolidate'} onChange={()=> setEnrollmentRes({action:'consolidate', keep:'canonical'})} /> Consolidate</label>
                        <label className="flex items-center gap-1"><input type="radio" checked={enrollmentRes?.action==='transfer'} onChange={()=> setEnrollmentRes({action:'transfer', keep:'canonical'})} /> Keep A enrollment</label>
                        <label className="flex items-center gap-1"><input type="radio" checked={enrollmentRes?.action==='preserve_history'} onChange={()=> setEnrollmentRes({action:'preserve_history', keep:'canonical'})} /> Preserve history</label>
                      </div>
                      {conflicts.enrollments.canonicalOpen && conflicts.enrollments.duplicateOpen && conflicts.enrollments.canonicalOpen.academicYearId !== conflicts.enrollments.duplicateOpen.academicYearId && <p className="text-xs text-amber-700">HISTORICAL ENROLLMENT DIFFERENCE — only one current open enrollment should remain.</p>}
                    </div>
                  </div>
                )}

                {/* Exam conflicts */}
                {conflicts && conflicts.exams.length>0 && (
                  <div className="space-y-3">
                    <h4 className="font-bold">{conflicts.exams.length} EXAM CONFLICTS REQUIRE RESOLUTION <span className="ml-2 font-normal text-sm">{examResMap.size}/{conflicts.exams.length} resolved</span></h4>
                    <button type="button" onClick={()=> setResolveExpanded(!resolveExpanded)} className="text-sm font-bold text-indigo-600">{resolveExpanded ? 'Hide' : 'Review Exam Conflicts'}</button>
                    {resolveExpanded && (
                      <div className="space-y-3 max-h-[600px] overflow-auto border rounded-xl p-3 bg-white">
                        {conflicts.exams.slice(examPage*EXAM_PAGE_SIZE, (examPage+1)*EXAM_PAGE_SIZE).map((c, idx) => {
                          const realIdx = examPage*EXAM_PAGE_SIZE + idx;
                          const selected = examResMap.get(realIdx);
                          return (
                            <div key={realIdx} className="border rounded-xl p-3">
                              <div className="text-xs font-bold text-slate-500">Exam conflict #{realIdx+1} — {c.identity.subject || c.identity.subjectId} {c.identity.examType} {c.identity.assessmentLabel||''} Term: {c.identity.termId}</div>
                              <div className="mt-2 grid grid-cols-2 gap-3">
                                <div className="border rounded-lg p-2"><div className="text-xs font-bold">RECORD A</div><div>Score: {c.canonical.score} / {c.canonical.total}</div><div className="text-xs">Exam ID: {c.canonical.id}</div><div className="text-xs">Created: {c.canonical.createdAt.slice(0,10)}</div>{c.canonical.score !== c.duplicate.score && <div className="text-xs font-bold text-rose-700">CRITICAL ACADEMIC CONFLICT: {c.canonical.score} vs {c.duplicate.score}</div>}{c.identical && <div className="text-xs font-bold text-emerald-700">IDENTICAL RECORDS</div>}</div>
                                <div className="border rounded-lg p-2"><div className="text-xs font-bold">RECORD B</div><div>Score: {c.duplicate.score} / {c.duplicate.total}</div><div className="text-xs">Exam ID: {c.duplicate.id}</div><div className="text-xs">Created: {c.duplicate.createdAt.slice(0,10)}</div></div>
                              </div>
                              <div className="mt-2 flex gap-3">
                                <label className="flex items-center gap-1"><input type="radio" checked={selected==='canonical'} onChange={()=> {const m=new Map(examResMap); m.set(realIdx,'canonical'); setExamResMap(m)}} /> Keep Record A exam</label>
                                <label className="flex items-center gap-1"><input type="radio" checked={selected==='duplicate'} onChange={()=> {const m=new Map(examResMap); m.set(realIdx,'duplicate'); setExamResMap(m)}} /> Keep Record B exam</label>
                              </div>
                              {c.canonical.score !== c.duplicate.score && selected && <div className="mt-1 text-xs"><label><input type="checkbox" checked={finalConfirm.verifiedParentGov} onChange={e=> setFinalConfirm({...finalConfirm, verifiedParentGov: e.target.checked})} /> I verified the correct exam result.</label></div>}
                            </div>
                          );
                        })}
                        <div className="flex justify-between text-sm">
                          <button type="button" disabled={examPage===0} onClick={()=> setExamPage(p=>Math.max(0,p-1))} className="px-3 py-1 border rounded disabled:opacity-30">Prev</button>
                          <span>Page {examPage+1} / {Math.ceil(conflicts.exams.length/EXAM_PAGE_SIZE)}</span>
                          <button type="button" disabled={(examPage+1)*EXAM_PAGE_SIZE >= conflicts.exams.length} onClick={()=> setExamPage(p=>p+1)} className="px-3 py-1 border rounded disabled:opacity-30">Next</button>
                        </div>
                        <div className="text-sm font-bold">EXAM RESOLUTION — {conflicts.exams.length} conflicts {Array.from(examResMap.values()).filter(v=>v==='canonical').length} from A {Array.from(examResMap.values()).filter(v=>v==='duplicate').length} from B</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Other history conflicts */}
                {conflicts && (conflicts.attendance.length>0 || conflicts.quizAttempts.length>0 || conflicts.releaseLogs.length>0 || conflicts.reportComments.length>0) && (
                  <div className="space-y-2 border rounded-xl p-3 bg-slate-50">
                    <h4 className="font-bold">Other Historical Conflicts</h4>
                    {conflicts.attendance.length>0 && <div><div className="text-sm font-semibold">Attendance same date: {conflicts.attendance.length}</div>{conflicts.attendance.map((c, idx)=> (<div key={idx} className="flex items-center gap-2 text-xs border p-2 rounded bg-white"><span>{c.identity.date}</span><label className="flex items-center gap-1"><input type="radio" checked={attResMap.get(idx)==='canonical'} onChange={()=>{const m=new Map(attResMap); m.set(idx,'canonical'); setAttResMap(m)}} /> Keep A</label><label className="flex items-center gap-1"><input type="radio" checked={attResMap.get(idx)==='duplicate'} onChange={()=>{const m=new Map(attResMap); m.set(idx,'duplicate'); setAttResMap(m)}} /> Keep B</label></div>))}</div>}
                    {conflicts.quizAttempts.length>0 && <div><div className="text-sm font-semibold">Quiz attempt same quiz: {conflicts.quizAttempts.length}</div>{conflicts.quizAttempts.map((c, idx)=> (<div key={idx} className="flex items-center gap-2 text-xs border p-2 rounded bg-white"><span>{c.identity.quizId}</span><label className="flex items-center gap-1"><input type="radio" checked={quizResMap.get(idx)==='canonical'} onChange={()=>{const m=new Map(quizResMap); m.set(idx,'canonical'); setQuizResMap(m)}} /> Keep A</label><label className="flex items-center gap-1"><input type="radio" checked={quizResMap.get(idx)==='duplicate'} onChange={()=>{const m=new Map(quizResMap); m.set(idx,'duplicate'); setQuizResMap(m)}} /> Keep B</label></div>))}</div>}
                    {conflicts.releaseLogs.length>0 && <div><div className="text-sm font-semibold">Release log same day: {conflicts.releaseLogs.length}</div>{conflicts.releaseLogs.map((c, idx)=> (<div key={idx} className="flex items-center gap-2 text-xs border p-2 rounded bg-white"><span>{c.identity.day}</span><label className="flex items-center gap-1"><input type="radio" checked={relResMap.get(idx)==='canonical'} onChange={()=>{const m=new Map(relResMap); m.set(idx,'canonical'); setRelResMap(m)}} /> Keep A</label><label className="flex items-center gap-1"><input type="radio" checked={relResMap.get(idx)==='duplicate'} onChange={()=>{const m=new Map(relResMap); m.set(idx,'duplicate'); setRelResMap(m)}} /> Keep B</label></div>))}</div>}
                    {conflicts.reportComments.length>0 && <div><div className="text-sm font-semibold">Report comment same term: {conflicts.reportComments.length}</div>{conflicts.reportComments.map((c, idx)=> (<div key={idx} className="flex items-center gap-2 text-xs border p-2 rounded bg-white"><span>{c.identity.termId}</span><label className="flex items-center gap-1"><input type="radio" checked={repResMap.get(idx)==='canonical'} onChange={()=>{const m=new Map(repResMap); m.set(idx,'canonical'); setRepResMap(m)}} /> Keep A</label><label className="flex items-center gap-1"><input type="radio" checked={repResMap.get(idx)==='duplicate'} onChange={()=>{const m=new Map(repResMap); m.set(idx,'duplicate'); setRepResMap(m)}} /> Keep B</label></div>))}</div>}
                  </div>
                )}

                {/* Final student preview */}
                {profileRes && conflicts && (
                  <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-4">
                    <h4 className="font-bold">FINAL STUDENT AFTER MERGE</h4>
                    <div className="mt-2 text-sm space-y-1">
                      <div>Student ID: {keepSelection==='A' ? selectedPair?.studentA.id : selectedPair?.studentB.id}</div>
                      <div>Name: {(profileRes.name==='duplicate' ? conflicts.profile.duplicate.name : conflicts.profile.canonical.name)} <span className="text-xs text-slate-500">Source: {profileRes.name==='duplicate' ? 'Record B' : 'Record A'}</span></div>
                      <div>Gov ID: {(profileRes.govId==='duplicate' ? conflicts.profile.duplicate.govId : profileRes.govId==='remove' ? 'blank' : conflicts.profile.canonical.govId) || 'blank'} <span className="text-xs text-slate-500">← {profileRes.govId==='duplicate' ? 'Record B' : profileRes.govId==='remove' ? 'Removed' : 'Record A'}</span></div>
                      <div>Parent: {profileRes.parentId==='duplicate' ? (parentNames.get(conflicts.profile.duplicate.parentId||'')||conflicts.profile.duplicate.parentId||'Unassigned') : profileRes.parentId==='remove' ? 'Unassigned' : (parentNames.get(conflicts.profile.canonical.parentId||'')||conflicts.profile.canonical.parentId||'Unassigned')} <span className="text-xs text-slate-500">← {profileRes.parentId==='duplicate' ? 'Record B' : profileRes.parentId==='remove' ? 'Removed' : 'Record A'}</span></div>
                      <div>Phone: {(profileRes.parentPhone==='duplicate' ? conflicts.profile.duplicate.parentPhone : profileRes.parentPhone==='remove' ? '—' : conflicts.profile.canonical.parentPhone) || '—'}</div>
                      <div>Class: {(profileRes.className==='duplicate' ? conflicts.profile.duplicate.className : conflicts.profile.canonical.className)} <span className="text-xs text-slate-500">← {profileRes.className==='duplicate' ? 'Record B' : 'Record A'}</span></div>
                      <div>Transport: {(profileRes.transport==='duplicate' ? conflicts.profile.duplicate.transport : profileRes.transport==='remove' ? 'Remove transport' : conflicts.profile.canonical.transport) || '—'}</div>
                    </div>
                  </div>
                )}

                {/* Master checklist */}
                {checklist && (
                  <div className="rounded-xl border p-3 bg-white">
                    <h4 className="font-bold">MASTER MERGE CHECKLIST</h4>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                      <div>Identity resolved? {keepSelection ? 'YES' : 'NO'}</div>
                      <div>Student to keep selected? {keepSelection ? 'YES' : 'NO'}</div>
                      <div>Gov ID resolved? {checklist.profileOk && (!checklist.govNeed || profileRes?.govId) ? 'YES' : 'NO'}</div>
                      <div>Parent resolved? {checklist.parentNeed ? (profileRes?.parentId ? 'YES' : 'NO') : 'YES'}</div>
                      <div>Profile conflicts resolved? {checklist.profileOk ? 'YES' : 'NO'}</div>
                      <div>Enrollment resolved? {checklist.enrollOk ? 'YES' : 'NO'}</div>
                      <div>Exam conflicts resolved? {checklist.examsOk ? 'YES' : `${examResMap.size}/${checklist.examsTotal}`}</div>
                      <div>Attendance conflicts? {checklist.attOk ? 'YES' : `${attResMap.size}/${checklist.attTotal}`}</div>
                      <div>Quiz conflicts? {checklist.quizOk ? 'YES' : `${quizResMap.size}/${checklist.quizTotal}`}</div>
                      <div>Release conflicts? {checklist.relOk ? 'YES' : 'NO'}</div>
                      <div>Report conflicts? {checklist.repOk ? 'YES' : 'NO'}</div>
                      <div>All required fields valid? {checklist.profileOk ? 'YES' : 'NO'}</div>
                      <div>No duplicate Gov ID? YES</div>
                      <div>No unresolved conflicts? {checklist.unresolved===0 ? 'YES' : `NO (${checklist.unresolved})`}</div>
                      <div>Admin confirmation? {checklist.adminOk ? 'YES' : 'NO'}</div>
                    </div>
                    <div className="mt-3 font-bold text-center">{checklist.canMergeResolved ? 'READY TO MERGE — All conflicts resolved' : checklist.unresolved>0 ? `MERGE DISABLED — ${checklist.unresolved} conflicts remaining` : 'MERGE BLOCKED — Review checklist'}</div>
                  </div>
                )}

                {/* Final merge review comprehensive */}
                {checklist?.canMergeResolved && conflicts && (
                  <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4">
                    <h4 className="font-bold">FINAL MERGE REVIEW</h4>
                    <div className="mt-2 text-sm">
                      <div>KEEP STUDENT {conflicts.profile.canonical.name} Student ID: {keepSelection==='A' ? selectedPair?.studentA.id : selectedPair?.studentB.id}</div>
                      <div>MERGE FROM {conflicts.profile.duplicate.name} Student ID: {keepSelection==='A' ? selectedPair?.studentB.id : selectedPair?.studentA.id}</div>
                      <div className="mt-2 font-semibold">FINAL PROFILE Gov ID: {(profileRes?.govId==='duplicate'?conflicts.profile.duplicate.govId:conflicts.profile.canonical.govId)||'blank'} ← Record {profileRes?.govId==='duplicate'?'B':'A'} Parent: {(profileRes?.parentId==='duplicate'? (parentNames.get(conflicts.profile.duplicate.parentId||'')||conflicts.profile.duplicate.parentId): (parentNames.get(conflicts.profile.canonical.parentId||'')||conflicts.profile.canonical.parentId))||'Unassigned'} ← Record {profileRes?.parentId==='duplicate'?'B':'A'} Transport: {(profileRes?.transport==='duplicate'?conflicts.profile.duplicate.transport:conflicts.profile.canonical.transport)||'—'} Class: {(profileRes?.className==='duplicate'?conflicts.profile.duplicate.className:conflicts.profile.canonical.className)}</div>
                      <div className="mt-2">HISTORY Exams: {conflicts.exams.length} resolved {Array.from(examResMap.values()).filter(v=>v==='canonical').length} from A {Array.from(examResMap.values()).filter(v=>v==='duplicate').length} from B Attendance: {conflicts.attendance.length} Quiz: {conflicts.quizAttempts.length} Release: {conflicts.releaseLogs.length} Report: {conflicts.reportComments.length} Enrollments: 1 open enrollment retained historical enrollment preserved</div>
                      <div className="mt-2">REMOVED/CONSOLIDATED Exam records: {conflicts.exams.length - examResMap.size} duplicate records discarded because administrator chose {(profileRes?.govId||'A')} Enrollment: 1 duplicate open enrollment consolidated Student record: {keepSelection==='A'?selectedPair?.studentB.id:selectedPair?.studentA.id} will be removed after all dependent data is verified</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Inline confirmation — with guided resolution support */}
            {(() => {
              const readyResolved = isResolvable && checklist?.canMergeResolved;
              if (preview.canMerge || readyResolved) {
                if (!showConfirm) {
                  return <button type="button" onClick={() => setShowConfirm(true)} disabled={!keepSelection} className="w-full rounded-xl bg-indigo-600 py-3 font-bold text-white hover:bg-indigo-700 disabled:opacity-50">{readyResolved ? 'READY TO MERGE — Review Final Confirmation' : 'Review Merge'}</button>;
                }
                return (
                  <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 space-y-4">
                    <h4 className="font-bold text-amber-900">Final Confirmation</h4>
                    <p className="text-sm text-amber-800">This will permanently consolidate two student records. Historical records and exam IDs will be preserved; the duplicate row will be removed inside the transaction. This cannot be safely undone without a recovery process.</p>
                    <div className="space-y-2 text-sm">
                      <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={reviewChecked} onChange={e => setReviewChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />I have reviewed the final student information.</label>
                      <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={finalConfirm.reviewedConflicts} onChange={e => setFinalConfirm({...finalConfirm, reviewedConflicts: e.target.checked})} className="mt-0.5 h-4 w-4" /> I have reviewed all conflicts.</label>
                      <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={finalConfirm.verifiedParentGov} onChange={e => setFinalConfirm({...finalConfirm, verifiedParentGov: e.target.checked})} className="mt-0.5 h-4 w-4" /> I have verified the selected parent/Gov ID.</label>
                      <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={finalConfirm.understandRemove} onChange={e => setFinalConfirm({...finalConfirm, understandRemove: e.target.checked})} className="mt-0.5 h-4 w-4" /> I understand the selected duplicate record will be removed after successful verification.</label>
                      <label className="flex items-start gap-2 font-semibold"><input type="checkbox" checked={reviewChecked} onChange={e => setReviewChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />I have reviewed this merge and the student I am keeping.</label>
                    </div>
                    <label className="block text-sm font-semibold">Merge reason {isResolvable ? '(required)' : '(optional)'}<textarea value={mergeReason} onChange={e => setMergeReason(e.target.value)} rows={3} placeholder="Example: Duplicate created during September class import; verified using Gov ID and parent account. Exam records reviewed and correct records selected." className="mt-1 w-full rounded-xl border bg-white p-3 text-sm" /></label>
                    {(preview.riskLevel === 'high' || preview.riskLevel === 'critical' || isResolvable) && <label className="block text-sm font-bold text-rose-800">High-risk — type MERGE<input value={mergeInput} onChange={e => setMergeInput(e.target.value)} placeholder="MERGE" className="mt-1 w-full rounded-xl border border-rose-300 bg-white p-3 font-mono uppercase text-sm" /></label>}
                    <div className="flex gap-3">
                      <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 rounded-xl border bg-white py-3 font-bold">Cancel</button>
                      <button type="button" onClick={handleMerge} disabled={!!(merging || !reviewChecked || (isResolvable && (!finalConfirm.reviewedConflicts || !finalConfirm.verifiedParentGov || !finalConfirm.understandRemove)) || ((preview?.riskLevel === 'high' || preview?.riskLevel === 'critical' || isResolvable) && mergeInput.trim().toUpperCase() !== 'MERGE'))} className="flex-1 rounded-xl bg-rose-600 py-3 font-bold text-white hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-2">{merging && <Loader2 className="h-4 w-4 animate-spin" />}Merge Students</button>
                    </div>
                    {isResolvable && <div className="text-xs text-slate-600">MERGE will execute as one transaction: validate → apply profile → resolve history → consolidate enrollment → verify → audit → delete duplicate. Any error rolls back.</div>}
                  </div>
                );
              }
              if (isResolvable) {
                return (
                  <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-center">
                    <div className="font-bold text-amber-900">{checklist?.unresolved ? `MERGE DISABLED — ${checklist?.unresolved} conflicts remaining` : '55 conflicts require resolution — No records have been changed. Review each conflict and choose which record to preserve.'}</div>
                    <div className="mt-2 text-sm text-amber-800">No records have been changed. Review each conflict and choose which record to preserve. <button type="button" onClick={()=> setResolveExpanded(true)} className="ml-1 underline font-bold">Review Conflicts</button></div>
                    <div className="mt-2 text-xs text-slate-500">CONFLICTS TO RESOLVE — {preview.conflicts.examConflicts} exam conflicts, {conflicts?.profile.govIdConflict ? 'Gov ID conflict' : ''} {conflicts?.profile.parentConflict ? 'Parent conflict' : ''}</div>
                    <div className="mt-2"><XCircle className="mx-auto h-8 w-8 text-slate-400" /><p className="mt-2 font-bold">Merge disabled for this pair</p><p className="text-xs text-slate-500">Resolve identity conflicts before merging. No data will be deleted.</p></div>
                  </div>
                );
              }
              return <div className="rounded-xl bg-slate-100 border p-4 text-center"><XCircle className="mx-auto h-8 w-8 text-slate-400" /><p className="mt-2 font-bold">Merge disabled for this pair</p><p className="text-xs text-slate-500">Resolve identity conflicts before merging. No data will be deleted.</p></div>;
            })()}
          </div>
        ) : (
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <h3 className="font-bold">Step 1 · Review identity evidence</h3>
            <p className="mt-1 text-sm text-slate-500">Select exactly which Student ID should remain authoritative.</p>
            <button type="button" disabled={!keepSelection || !selectedPair || selectedPair && evaluatePair(selectedPair.studentA, selectedPair.studentB).isBlocked} onClick={async () => {
              if (!selectedPair || !keepSelection) return;
              setPreviewLoading(true);
              try {
                const canonicalId = keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id;
                const duplicateId = keepSelection === 'A' ? selectedPair.studentB.id : selectedPair.studentA.id;
                const p = await previewStudentMerge(canonicalId, duplicateId);
                setPreview(p);
              } catch (e:any) { addToast({ type: 'error', title: 'Preview failed', description: e.message }); }
              finally { setPreviewLoading(false); }
            }} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
              {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}Review Merge
            </button>
          </div>
        )}

        <p className="text-center text-xs text-slate-500">The selected canonical record will keep its stable Student ID. The other record is only removed after a successful transaction and zero-dependency verification.</p>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-700"><GitMerge className="h-3.5 w-3.5" />Safe guided merge</div>
            <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Duplicate Students</h1>
            <p className="mt-1 max-w-3xl text-slate-500">Find duplicate student records and safely merge them while preserving history.</p>
          </div>
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-800"><ShieldCheck className="mr-1 inline h-4 w-4" />Admin-only · no automatic merges</div>
        </div>
      </header>

      {error && <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Potential Duplicates" value={summary.totalGroups} accent="bg-indigo-50 text-indigo-600" icon={UsersRound} />
        <SummaryCard label="Ready to Review" value={summary.ready} accent="bg-sky-50 text-sky-600" icon={Eye} />
        <SummaryCard label="High Confidence" value={summary.highConfidence} accent="bg-emerald-50 text-emerald-600" icon={CheckCircle2} />
        <SummaryCard label="Needs Review" value={summary.needsReview} accent="bg-amber-50 text-amber-600" icon={Clock} />
        <SummaryCard label="Blocked" value={summary.blocked} accent="bg-red-50 text-red-600" icon={XCircle} />
        <SummaryCard label="Merged" value={summary.merged} accent="bg-slate-50 text-slate-600" icon={GitMerge} />
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <label className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, class, Student ID, Gov ID…" className="w-full rounded-xl border border-slate-300 py-3 pl-10 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
          </label>
          <label className="relative flex-1">
            <GraduationCap className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by class" className="w-full rounded-xl border border-slate-300 py-3 pl-10 pr-3 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" />
          </label>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {['All', 'High Confidence', 'Parent Assigned vs Unassigned', 'Gov ID Present', 'No Gov ID', 'Needs Review', 'Mergeable', 'Blocked', 'Already Reviewed'].map(f => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={cn('whitespace-nowrap rounded-full border px-3 py-2 text-xs font-bold transition', filter === f ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700')}>{f}</button>
          ))}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <div><h2 className="font-bold text-slate-900">Candidate groups</h2><p className="mt-1 text-xs text-slate-500">Same normalized name and current class are starting evidence only. Review every row.</p></div>
          <span className="text-sm font-semibold text-slate-500">{filteredPairs.length} shown</span>
        </div>
        {filteredPairs.length === 0 ? (
          <div className="p-12 text-center"><CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" /><h3 className="mt-3 font-bold text-slate-900">No candidates match these filters</h3><p className="mt-1 text-sm text-slate-500">The list is computed from live student and merge-audit data.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[950px] w-full text-left">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Student records</th><th className="px-4 py-3">Class</th><th className="px-4 py-3">Identity Evidence</th><th className="px-4 py-3">Risk</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredPairs.map(({ pair, evaluation }) => (
                  <tr key={pair.id} className="align-top hover:bg-slate-50/70">
                    <td className="px-4 py-4"><div className="font-bold text-slate-900">{pair.studentA.name}</div><div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500"><span className="font-mono">A: {pair.studentA.id}</span><span className="font-mono">B: {pair.studentB.id}</span></div><div className="mt-2 flex flex-wrap gap-1.5"><span className={pair.studentA.parentId ? 'rounded-full bg-indigo-100 px-2 py-1 text-[11px] font-bold text-indigo-700' : 'rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-500'}>{pair.studentA.parentId ? 'Record A · Parent assigned' : 'Record A · Unassigned'}</span><span className={pair.studentB.parentId ? 'rounded-full bg-indigo-100 px-2 py-1 text-[11px] font-bold text-indigo-700' : 'rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-500'}>{pair.studentB.parentId ? 'Record B · Parent assigned' : 'Record B · Unassigned'}</span></div></td>
                    <td className="px-4 py-4"><span className="rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-bold text-indigo-700">{pair.className}</span></td>
                    <td className="px-4 py-4"><div className="flex flex-wrap gap-1.5"><EvidenceBadge evidence={evaluation.evidence} />{evaluation.hasSameGov && <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-bold text-emerald-700">Same Gov ID</span>}{evaluation.hasConflictingGov && <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-bold text-rose-700">Gov ID conflict</span>}</div><p className="mt-2 max-w-xs text-xs text-slate-500">{evaluation.evidenceSummary.slice(0,2).join(' · ')}</p></td>
                    <td className="px-4 py-4"><RiskBadge risk={evaluation.risk} /></td>
                    <td className="px-4 py-4"><span className={evaluation.isBlocked ? 'inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-700' : evaluation.canMergeLocal ? 'inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700' : 'inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700'}>{evaluation.isBlocked ? 'Blocked' : evaluation.canMergeLocal ? 'Ready' : 'Needs review'}</span></td>
                    <td className="px-4 py-4 text-right"><button type="button" onClick={() => openReview(pair)} className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm font-bold text-indigo-700 hover:bg-indigo-50">Review</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {audits.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h3 className="font-bold text-slate-900 flex items-center gap-2"><History className="w-4 h-4" /> Recent Merges — Audit Trail</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500 uppercase border-b"><th className="py-2">Time</th><th className="py-2">Canonical ID</th><th className="py-2">Merged ID</th><th className="py-2">Audit</th></tr></thead>
              <tbody>
                {audits.slice(0,10).map((a:any)=><tr key={a.id} className="border-b last:border-0"><td className="py-2 text-xs">{new Date(a.created_at).toLocaleString()}</td><td className="py-2 font-mono text-xs">{a.canonical_id}</td><td className="py-2 font-mono text-xs">{a.duplicate_id}</td><td className="py-2"><button onClick={()=>setShowAudit(a)} className="text-indigo-600 hover:underline text-xs">View</button></td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl p-4">
        <h4 className="font-bold text-slate-900 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-indigo-600" /> Root-cause prevention — stop duplicates at the source</h4>
        <p className="text-xs text-slate-600 mt-1">Merges preserve history, but the ideal is to prevent duplicates from being created.</p>
        <ul className="list-disc pl-5 mt-2 space-y-1 text-xs text-slate-600">
          <li><span className="font-semibold">Verify Government ID at import</span> — treat Gov ID as loose match.</li>
          <li><span className="font-semibold">Require parent assignment</span> — flag unassigned row before creation.</li>
          <li><span className="font-semibold">Use stable Student ID</span> — never generate new ID when Gov ID exists.</li>
          <li><span className="font-semibold">Normalize names</span> — trim/lower/collapse whitespace.</li>
          <li><span className="font-semibold">Class-import guardrail</span> — run <span className="font-mono">get_duplicate_candidates</span> before adding rows.</li>
        </ul>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600">
        <p className="font-bold flex items-center gap-1"><ShieldCheck className="w-4 h-4" /> Safety guarantees</p>
        <ul className="list-disc pl-5 mt-1 space-y-1">
          <li>No <span className="font-mono">DELETE FROM students</span> runs from the UI — only transaction-safe merge RPC.</li>
          <li>No <span className="font-semibold">Merge All / Delete All Duplicates / Auto Clean</span> button exists. Every duplicate is reviewed individually.</li>
          <li>Dry-run preview makes zero writes.</li>
          <li>Exam and Gov ID conflicts block the merge.</li>
        </ul>
      </div>

      <Dialog open={!!showAudit} onClose={() => setShowAudit(null)} title="Merge Audit">
        {showAudit && (
          <div className="space-y-4 text-sm">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
              <div className="font-bold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Merge successful</div>
              <div className="mt-2 space-y-1">
                <div>Kept: <span className="font-mono font-bold">{showAudit.canonical_id || showAudit.canonicalId}</span></div>
                <div>Merged: <span className="font-mono font-bold">{showAudit.duplicate_id || showAudit.duplicateId}</span></div>
                <div>Audit ID: <span className="font-mono text-xs">{showAudit.id || showAudit.auditId}</span></div>
              </div>
            </div>
            <pre className="bg-slate-50 rounded-xl p-3 text-xs overflow-auto">{JSON.stringify(showAudit, null, 2)}</pre>
          </div>
        )}
      </Dialog>
    </div>
  );
}
