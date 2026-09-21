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
  normalizeNameForDuplicate,
  type DuplicatePair,
  type DuplicateGroup,
  type MergePreview,
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

  const handleMerge = async () => {
    if (!selectedPair || !keepSelection || !preview) return;
    const canonicalId = keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id;
    const duplicateId = keepSelection === 'A' ? selectedPair.studentB.id : selectedPair.studentA.id;
    if (!preview.canMerge) {
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
              {preview.conflicts.examConflicts > 0 ? <p className="mt-2 text-sm font-bold text-rose-700">MERGE BLOCKED — {preview.conflicts.examConflicts} exam identity conflicts. No marks will be overwritten.</p> : <p className="mt-2 text-sm text-emerald-700">{preview.counts.exams.duplicate} exam records will be reassigned. IDs preserved.</p>}
            </div>

            {/* Inline confirmation — no modal */}
            {!preview.canMerge ? (
              <div className="rounded-xl bg-slate-100 border p-4 text-center"><XCircle className="mx-auto h-8 w-8 text-slate-400" /><p className="mt-2 font-bold">Merge disabled for this pair</p><p className="text-xs text-slate-500">Resolve identity conflicts before merging. No data will be deleted.</p></div>
            ) : !showConfirm ? (
              <button type="button" onClick={() => setShowConfirm(true)} disabled={!keepSelection} className="w-full rounded-xl bg-indigo-600 py-3 font-bold text-white hover:bg-indigo-700 disabled:opacity-50">Review Merge</button>
            ) : (
              <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 space-y-4">
                <h4 className="font-bold text-amber-900">Final Confirmation</h4>
                <p className="text-sm text-amber-800">This will permanently consolidate two student records. Historical records and exam IDs will be preserved; the duplicate row will be removed inside the transaction. This cannot be safely undone without a recovery process.</p>
                <label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" checked={reviewChecked} onChange={e => setReviewChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />I have reviewed this merge and the student I am keeping.</label>
                <label className="block text-sm font-semibold">Merge reason (optional)<textarea value={mergeReason} onChange={e => setMergeReason(e.target.value)} rows={3} placeholder="Example: Duplicate created during September class import; verified using Gov ID and parent account." className="mt-1 w-full rounded-xl border bg-white p-3 text-sm" /></label>
                {(preview.riskLevel === 'high' || preview.riskLevel === 'critical') && <label className="block text-sm font-bold text-rose-800">High-risk — type MERGE<input value={mergeInput} onChange={e => setMergeInput(e.target.value)} placeholder="MERGE" className="mt-1 w-full rounded-xl border border-rose-300 bg-white p-3 font-mono uppercase text-sm" /></label>}
                <div className="flex gap-3">
                  <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 rounded-xl border bg-white py-3 font-bold">Cancel</button>
                  <button type="button" onClick={handleMerge} disabled={merging || !reviewChecked || ((preview.riskLevel === 'high' || preview.riskLevel === 'critical') && mergeInput.trim().toUpperCase() !== 'MERGE')} className="flex-1 rounded-xl bg-rose-600 py-3 font-bold text-white hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-2">{merging && <Loader2 className="h-4 w-4 animate-spin" />}Merge Students</button>
                </div>
              </div>
            )}
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
