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
  ArrowRight,
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
  govKeyLoose,
  type DuplicatePair,
  type DuplicateGroup,
  type MergePreview,
} from '../../lib/db/duplicateStudents';
import type { Student } from '../../types';

// ── Summary cards ──────────────────────────────────────────────────────────

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

// ── Helpers for badges ─────────────────────────────────────────────────────

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

// ── Main Page ──────────────────────────────────────────────────────────────

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

  // Load groups + audits
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [gs, aus] = await Promise.all([getDuplicateGroups(), getMergeAudits(100)]);
      setGroups(gs);
      setAudits(aus);
      // Load parent names for all involved students
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

  // Flatten pairs for table (each group yields pairs; for >2 members we show each pair as separate row? For manual review we show one row per group)
  const allPairs: Array<{ pair: DuplicatePair; group: DuplicateGroup; evaluation: ReturnType<typeof evaluatePair> }> = useMemo(() => {
    const out: typeof allPairs = [];
    for (const g of groups) {
      for (const p of g.pairs) {
        out.push({ pair: p, group: g, evaluation: evaluatePair(p.studentA, p.studentB) });
      }
    }
    return out;
  }, [groups]);

  // Summary derived from pairs (dynamic, not hard-coded)
  const summary = useMemo(() => {
    const totalPairs = allPairs.length;
    const totalGroups = groups.length;
    const highConfidence = allPairs.filter(x => x.evaluation.isHighConfidence).length;
    const blocked = allPairs.filter(x => x.evaluation.isBlocked).length;
    const mergeableLocal = allPairs.filter(x => x.evaluation.canMergeLocal).length;
    const needsReview = allPairs.filter(x => x.evaluation.evidence === 'possible').length;
    const ready = totalPairs - blocked;
    const merged = audits.length;
    return { totalPairs, totalGroups, highConfidence, blocked, mergeableLocal, needsReview, ready, merged };
  }, [allPairs, groups.length, audits.length]);

  // Filter + search
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

  // When selecting a pair, fetch preview and reset keep selection
  const openReview = async (pair: DuplicatePair) => {
    setSelectedPair(pair);
    setPreview(null);
    setKeepSelection(null);
    setReviewChecked(false);
    setMergeInput('');
    setShowConfirm(false);
    // Mark as reviewed (local)
    const next = new Set(reviewedSet);
    next.add(pair.id);
    setReviewedSet(next);
    try { localStorage.setItem('duplicate-reviewed', JSON.stringify(Array.from(next))); } catch {}
    // Default keep to recommended after evaluation
    const ev = evaluatePair(pair.studentA, pair.studentB);
    // Recommendation will be overridden after preview? Keep local for now
    // Do preview fetch with canonical = recommended keep? But spec says admin must choose, preview should be for both possibilities.
    // We'll default keep to recommended but still allow switching which triggers re-preview
    setKeepSelection(ev.recommendation.keep);
    // Preview currently expects canonical/duplicate IDs; we'll preview with A as canonical initially, then switch
    setPreviewLoading(true);
    try {
      // Preview with A as canonical (we'll re-fetch when keep changes)
      const canonicalId = ev.recommendation.keep === 'A' ? pair.studentA.id : pair.studentB.id;
      const duplicateId = ev.recommendation.keep === 'A' ? pair.studentB.id : pair.studentA.id;
      const p = await previewStudentMerge(canonicalId, duplicateId);
      setPreview(p);
    } catch (e: any) {
      // Fallback: try opposite orientation or show error
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

  // When keep selection changes, re-preview
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
      // Show audit
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

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white">
            <GitMerge className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Duplicate Students</h1>
            <p className="text-slate-500 text-sm">Find duplicate student records and safely merge them while preserving history.</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">{error}</div>
      )}

      {/* Summary cards — dynamically calculated */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard label="Potential Duplicates" value={summary.totalGroups} accent="bg-indigo-50 text-indigo-600" icon={UsersRound} />
        <SummaryCard label="Ready to Review" value={summary.ready} accent="bg-sky-50 text-sky-600" icon={Eye} />
        <SummaryCard label="High Confidence" value={summary.highConfidence} accent="bg-emerald-50 text-emerald-600" icon={CheckCircle2} />
        <SummaryCard label="Needs Review" value={summary.needsReview} accent="bg-amber-50 text-amber-600" icon={Clock} />
        <SummaryCard label="Blocked" value={summary.blocked} accent="bg-red-50 text-red-600" icon={XCircle} />
        <SummaryCard label="Merged" value={summary.merged} accent="bg-slate-50 text-slate-600" icon={GitMerge} />
      </div>

      {/* Filters */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, class, Student ID, Gov ID…"
            className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {['All', 'High Confidence', 'Parent Assigned vs Unassigned', 'Gov ID Present', 'No Gov ID', 'Needs Review', 'Mergeable', 'Blocked', 'Already Reviewed'].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors',
                filter === f ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Duplicate List Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Class</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Record A</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Record B</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Identity Evidence</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Risk</th>
                <th className="px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPairs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-slate-400">
                      <CheckCircle2 className="w-8 h-8 text-emerald-300" />
                      <p className="font-medium">No duplicate candidates match this filter</p>
                      <p className="text-xs">Try adjusting search or filter. Groups are detected by normalized name + class, not by assumptions.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredPairs.map(({ pair, evaluation }) => {
                  const a = pair.studentA;
                  const b = pair.studentB;
                  const parentA = a.parentId ? (parentNames.get(a.parentId) || a.parentId.slice(0, 8)) : null;
                  const parentB = b.parentId ? (parentNames.get(b.parentId) || b.parentId.slice(0, 8)) : null;
                  return (
                    <tr key={pair.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">{a.name}</div>
                        <div className="text-xs text-slate-500">{a.id}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-xs font-semibold">{pair.className}</span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {a.parentId ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                            <CheckCircle2 className="w-3 h-3" /> Parent assigned
                          </span>
                        ) : (
                          <span className="inline-flex px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Unassigned</span>
                        )}
                        <div className="mt-1 text-slate-500">{a.govId ? `Gov ID: ${a.govId}` : 'Gov ID: —'}</div>
                        <div className="text-slate-400">{parentA || 'No parent'}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {b.parentId ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                            <CheckCircle2 className="w-3 h-3" /> Parent assigned
                          </span>
                        ) : (
                          <span className="inline-flex px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Unassigned</span>
                        )}
                        <div className="mt-1 text-slate-500">{b.govId ? `Gov ID: ${b.govId}` : 'Gov ID: —'}</div>
                        <div className="text-slate-400">{parentB || 'No parent'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <EvidenceBadge evidence={evaluation.evidence} />
                        <div className="text-xs text-slate-500 mt-1">
                          {evaluation.hasSameGov ? 'Same Gov ID' : evaluation.hasConflictingGov ? 'Conflicting Gov IDs' : evaluation.isParentVsUnassigned ? 'Parent vs Unassigned' : evaluation.evidence}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RiskBadge risk={evaluation.risk} />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openReview(pair)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
                        >
                          <Eye className="w-3.5 h-3.5" /> Review
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Review Dialog — two-column layout */}
      <Dialog open={!!selectedPair} onClose={() => { setSelectedPair(null); setPreview(null); }} title={selectedPair ? `Review: ${selectedPair.studentA.name}` : 'Review'}>
        {selectedPair && (
          <div className="space-y-6 max-w-5xl">
            {/* Keep selector — must explicitly choose */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <h4 className="font-bold text-amber-900 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4" /> Administrator must select the student to keep
              </h4>
              <p className="text-xs text-amber-700 mt-1">Recommendation is not an automatic merge. You must explicitly confirm.</p>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {(['A', 'B'] as const).map(side => {
                  const student = side === 'A' ? selectedPair.studentA : selectedPair.studentB;
                  const ev = evaluatePair(selectedPair.studentA, selectedPair.studentB);
                  const isRecommended = ev.recommendation.keep === side;
                  const isSelected = keepSelection === side;
                  return (
                    <button
                      key={side}
                      onClick={() => setKeepSelection(side)}
                      className={cn(
                        'text-left p-3 rounded-xl border-2 transition-all',
                        isSelected ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300',
                        isRecommended ? 'ring-1 ring-emerald-200' : ''
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">Keep Record {side}</span>
                        {isRecommended && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Recommended</span>}
                      </div>
                      <div className="text-sm font-medium text-slate-900 mt-1">{student.name}</div>
                      <div className="text-xs text-slate-500">{student.id} · {student.className}</div>
                      <div className="text-xs text-slate-500">{student.govId ? `Gov ID: ${student.govId}` : 'Gov ID: —'} · {student.parentId ? `Parent: ${parentNames.get(student.parentId) || student.parentId}` : 'Unassigned'}</div>
                      {isRecommended && (
                        <div className="text-xs text-emerald-700 mt-2">Reasons: {ev.recommendation.reasons.join(', ')}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Identity Evidence Panel */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {(['A', 'B'] as const).map(side => {
                const s = side === 'A' ? selectedPair.studentA : selectedPair.studentB;
                const label = `Record ${side}`;
                const isKeep = keepSelection === side;
                return (
                  <div key={side} className={cn('rounded-2xl border-2 p-4 space-y-3', isKeep ? 'border-indigo-300 bg-indigo-50/30' : 'border-slate-200 bg-white')}>
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-slate-900 flex items-center gap-2">
                        {isKeep ? <CheckCircle2 className="w-4 h-4 text-indigo-600" /> : <Clock className="w-4 h-4 text-slate-400" />}
                        {label} {isKeep ? '(KEEP)' : '(MERGE FROM)'}
                      </h4>
                      <span className="text-xs text-slate-500">{new Date(s.createdAt).toLocaleDateString()}</span>
                    </div>

                    <div>
                      <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><IdCard className="w-3 h-3" /> Identity</h5>
                      <div className="mt-1 space-y-1 text-sm">
                        <div><span className="text-slate-500">Student ID:</span> <span className="font-mono font-medium">{s.id}</span></div>
                        <div><span className="text-slate-500">Gov ID:</span> <span className={s.govId ? 'font-medium' : 'text-slate-400'}>{s.govId || 'blank'}</span></div>
                        <div><span className="text-slate-500">Name:</span> <span className="font-medium">{s.name}</span></div>
                        <div><span className="text-slate-500">Class:</span> <span className="font-medium">{s.className}</span></div>
                        <div><span className="text-slate-500">Created:</span> {new Date(s.createdAt).toLocaleString()}</div>
                        <div><span className="text-slate-500">Normalized:</span> <span className="font-mono text-xs">{normalizeNameForDuplicate(s.name)}</span></div>
                      </div>
                    </div>

                    <div>
                      <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><Phone className="w-3 h-3" /> Parent</h5>
                      <div className="mt-1 space-y-1 text-sm">
                        <div><span className="text-slate-500">Parent:</span> {s.parentId ? <span className="font-medium text-emerald-700">{parentNames.get(s.parentId) || s.parentId}</span> : <span className="text-slate-400 italic">Unassigned</span>}</div>
                        <div><span className="text-slate-500">Parent phone:</span> {s.parentPhone || '—'}</div>
                        <div><span className="text-slate-500">Parent account:</span> {s.parentId ? 'Assigned' : 'Unassigned'}</div>
                      </div>
                    </div>

                    <div>
                      <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><GraduationCap className="w-3 h-3" /> Enrollment</h5>
                      <div className="mt-1 space-y-1 text-sm">
                        <div><span className="text-slate-500">Current class:</span> {s.className}</div>
                        <div><span className="text-slate-500">Transport:</span> {s.transport || '—'}</div>
                        {preview && (
                          <>
                            <div><span className="text-slate-500">Open enrollment:</span> {side === 'A' ? (preview.counts.enrollments.canonicalOpen ? `${preview.counts.enrollments.canonicalOpen.className}` : 'None') : (preview.counts.enrollments.duplicateOpen ? `${preview.counts.enrollments.duplicateOpen.className}` : 'None')}</div>
                            <div><span className="text-slate-500">Historical:</span> {side === 'A' ? preview.counts.enrollments.canonicalHistory : preview.counts.enrollments.duplicateHistory} prior enrollments</div>
                          </>
                        )}
                      </div>
                    </div>

                    {preview && (
                      <div>
                        <h5 className="text-xs font-bold text-slate-500 uppercase flex items-center gap-1"><Layers className="w-3 h-3" /> History Counts</h5>
                        <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Exams</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.exams.canonical : preview.counts.exams.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Attendance</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.attendance.canonical : preview.counts.attendance.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Homework</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.homework.canonical : preview.counts.homework.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Promotions</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.promotions.canonical : preview.counts.promotions.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Quiz attempts</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.quizAttempts.canonical : preview.counts.quizAttempts.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Pickups</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.authorizedPickups.canonical : preview.counts.authorizedPickups.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Release logs</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.releaseLogs.canonical : preview.counts.releaseLogs.duplicate}</span></div>
                          <div className="bg-white rounded-lg border p-2"><span className="text-slate-500">Report comments</span> <span className="font-bold float-right">{side === 'A' ? preview.counts.reportComments.canonical : preview.counts.reportComments.duplicate}</span></div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Evidence Strength */}
            {selectedPair && (() => {
              const ev = evaluatePair(selectedPair.studentA, selectedPair.studentB);
              if (preview) {
                if (!preview.canMerge) {
                  if (preview.blockedReasons.includes('gov_id_conflict') || preview.conflicts.govConflict) {
                    return (
                      <div className="rounded-xl bg-red-50 border border-red-200 p-4">
                        <h4 className="font-bold text-red-800 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> DO NOT MERGE — CRITICAL IDENTITY CONFLICT</h4>
                        <p className="text-sm text-red-700 mt-1">Different Government IDs — conflicting trusted identity. Merge is disabled. Resolve manually outside the automatic workflow.</p>
                        <div className="mt-2 text-xs text-red-600 font-mono">Gov A: {preview.canonical.govId || 'blank'} · Gov B: {preview.duplicate.govId || 'blank'}</div>
                      </div>
                    );
                  }
                  if (preview.blockedReasons.includes('exam_conflict') || preview.conflicts.examConflicts > 0) {
                    return (
                      <div className="rounded-xl bg-orange-50 border border-orange-200 p-4">
                        <h4 className="font-bold text-orange-800 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> BLOCKED — EXAM CONFLICT</h4>
                        <p className="text-sm text-orange-700 mt-1"> {preview.conflicts.examConflicts} exam identity conflicts detected. No exam marks will be overwritten. Merge is disabled.</p>
                        <div className="text-xs text-orange-600 mt-1">Canonical: {preview.counts.exams.canonical} exams · Duplicate: {preview.counts.exams.duplicate} exams · Conflicts: {preview.conflicts.examConflicts}</div>
                      </div>
                    );
                  }
                  if (preview.blockedReasons.includes('both_have_parents')) {
                    return (
                      <div className="rounded-xl bg-red-50 border border-red-200 p-4">
                        <h4 className="font-bold text-red-800">HIGH RISK — BOTH RECORDS HAVE PARENTS</h4>
                        <p className="text-sm text-red-700 mt-1">Different parents with no shared Gov ID. Merge disabled until identity is resolved.</p>
                      </div>
                    );
                  }
                  return (
                    <div className="rounded-xl bg-red-50 border border-red-200 p-4">
                      <h4 className="font-bold text-red-800">BLOCKED — {preview.blockedReasons.join(', ')}</h4>
                      <p className="text-sm text-red-700 mt-1">Merge cannot proceed. Review required.</p>
                    </div>
                  );
                }
                if (preview.evidence === 'strong' && preview.riskLevel === 'low') {
                  return (
                    <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                      <h4 className="font-bold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> STRONG MATCH — SAFE TO REVIEW</h4>
                      <div className="text-sm text-emerald-700 mt-1 space-y-1">
                        <div>✓ Same normalized name</div>
                        <div>✓ Same class</div>
                        {preview.conflicts.sameGov && <div>✓ Same Government ID — strong identity signal</div>}
                        {ev.isParentVsUnassigned && <div>✓ One record has parent assigned, other is unassigned</div>}
                      </div>
                    </div>
                  );
                }
                if (preview.riskLevel === 'high') {
                  return (
                    <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                      <h4 className="font-bold text-amber-800">POSSIBLE MATCH — REVIEW REQUIRED</h4>
                      <p className="text-sm text-amber-700 mt-1">Identity evidence is limited. Verify enrollment history and parent information before merging.</p>
                    </div>
                  );
                }
              }
              // Fallback to local evaluation before preview loads
              if (ev.evidence === 'strong' && !ev.isBlocked) {
                return (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                    <h4 className="font-bold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> STRONG MATCH</h4>
                    <div className="text-sm text-emerald-700 mt-1 space-y-1">
                      {ev.evidenceSummary.map((s, i) => <div key={i}>{s}</div>)}
                    </div>
                  </div>
                );
              }
              if (ev.evidence === 'conflicting') {
                return (
                  <div className="rounded-xl bg-red-50 border border-red-200 p-4">
                    <h4 className="font-bold text-red-800">DO NOT MERGE</h4>
                    <div className="text-sm text-red-700 mt-1 space-y-1">
                      {ev.evidenceSummary.map((s, i) => <div key={i}>{s}</div>)}
                    </div>
                  </div>
                );
              }
              return (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                  <h4 className="font-bold text-amber-800">POSSIBLE MATCH</h4>
                  <div className="text-sm text-amber-700 mt-1 space-y-1">
                    {ev.evidenceSummary.map((s, i) => <div key={i}>{s}</div>)}
                  </div>
                </div>
              );
            })()}

            {/* Preview panels */}
            {previewLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-indigo-500" /> <span className="ml-2 text-slate-500">Loading preview…</span></div>
            ) : preview ? (
              <>
                {/* Merge Preview */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2"><GitMerge className="w-4 h-4" /> MERGE PREVIEW</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white rounded-xl border p-3">
                      <div className="text-xs font-bold text-emerald-600 uppercase">KEEP</div>
                      <div className="font-bold text-slate-900">{preview.canonical.name}</div>
                      <div className="text-xs font-mono text-slate-500">ID: {preview.canonical.id}</div>
                      <div className="text-xs text-slate-600">Parent: {preview.canonical.parentId ? (parentNames.get(preview.canonical.parentId) || preview.canonical.parentId) : 'Unassigned'}</div>
                      <div className="text-xs text-slate-600">Gov ID: {preview.canonical.govId || 'blank'}</div>
                    </div>
                    <div className="bg-white rounded-xl border p-3">
                      <div className="text-xs font-bold text-amber-600 uppercase">MERGE FROM</div>
                      <div className="font-bold text-slate-900">{preview.duplicate.name}</div>
                      <div className="text-xs font-mono text-slate-500">ID: {preview.duplicate.id}</div>
                      <div className="text-xs text-slate-600">Parent: {preview.duplicate.parentId ? (parentNames.get(preview.duplicate.parentId) || preview.duplicate.parentId) : 'Unassigned'}</div>
                      <div className="text-xs text-slate-600">Gov ID: {preview.duplicate.govId || 'blank'}</div>
                    </div>
                  </div>

                  <div>
                    <h5 className="text-xs font-bold text-slate-500 uppercase">History to preserve</h5>
                    <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Exams</span><span className="font-bold">{preview.counts.exams.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Attendance</span><span className="font-bold">{preview.counts.attendance.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Homework</span><span className="font-bold">{preview.counts.homework.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Promotions</span><span className="font-bold">{preview.counts.promotions.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Quiz Attempts</span><span className="font-bold">{preview.counts.quizAttempts.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Pickups</span><span className="font-bold">{preview.counts.authorizedPickups.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Release Logs</span><span className="font-bold">{preview.counts.releaseLogs.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Report Comments</span><span className="font-bold">{preview.counts.reportComments.duplicate}</span></div>
                      <div className="bg-white rounded-lg border p-2 flex justify-between"><span>Enrollments</span><span className="font-bold">{preview.counts.enrollments.duplicateHistory + (preview.counts.enrollments.duplicateOpen ? 1 : 0)}</span></div>
                    </div>
                  </div>
                </div>

                {/* Enrollment preview */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2"><Calendar className="w-4 h-4" /> Enrollment action</h4>
                  {preview.enrollment.willConsolidate ? (
                    <div className="mt-2 text-sm space-y-1">
                      <div className="flex items-center gap-2"><span className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 text-xs font-bold">KEEP:</span> {preview.enrollment.canonicalOpen?.className} AY {preview.enrollment.canonicalOpen?.academicYearId} — Open enrollment</div>
                      <div className="flex items-center gap-2"><span className="px-2 py-1 rounded bg-amber-50 text-amber-700 text-xs font-bold">CONSOLIDATE:</span> Duplicate {preview.enrollment.duplicateOpen?.className} AY {preview.enrollment.duplicateOpen?.academicYearId} — Open enrollment</div>
                      <div className="text-emerald-700 font-semibold flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Result: 1 open enrollment remains</div>
                    </div>
                  ) : preview.enrollment.duplicateOpen ? (
                    <div className="mt-2 text-sm text-slate-600">Duplicate open enrollment will be transferred to canonical. Historical enrollment will be preserved.</div>
                  ) : (
                    <div className="mt-2 text-sm text-slate-600">No duplicate open enrollment. Historical enrollment will be preserved.</div>
                  )}
                  {!preview.canMerge && preview.blockedReasons.includes('enrollment_conflict') && (
                    <div className="mt-2 text-sm text-red-600 font-semibold flex items-center gap-1"><XCircle className="w-4 h-4" /> MERGE BLOCKED — Enrollment histories are contradictory. Review required.</div>
                  )}
                </div>

                {/* Exam preview */}
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2"><BookOpen className="w-4 h-4" /> Exam records</h4>
                  <div className="mt-2 text-sm space-y-1">
                    <div>Canonical: <span className="font-bold">{preview.counts.exams.canonical}</span> · Duplicate: <span className="font-bold">{preview.counts.exams.duplicate}</span></div>
                    {preview.conflicts.examConflicts > 0 ? (
                      <div className="text-red-600 font-semibold">
                        MERGE BLOCKED — {preview.conflicts.examConflicts} exam records have conflicting identities. No exam marks will be overwritten. Merge disabled.
                      </div>
                    ) : (
                      <div className="text-emerald-700">{preview.counts.exams.duplicate} exam records will be reassigned. Exam IDs will be preserved.</div>
                    )}
                    {!preview.canMerge && preview.conflicts.examConflicts > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3 mt-2">
                        <div className="font-bold text-red-800">BLOCKED — EXAM CONFLICT</div>
                        <div className="text-xs text-red-600">Merge disabled</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Two-step merge confirmation */}
                {!preview.canMerge ? (
                  <div className="rounded-xl bg-slate-100 border border-slate-200 p-4 text-center">
                    <XCircle className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                    <p className="font-bold text-slate-700">Merge disabled for this pair</p>
                    <p className="text-xs text-slate-500">Resolve identity conflicts before merging. No data will be deleted.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {!showConfirm ? (
                      <button
                        onClick={() => setShowConfirm(true)}
                        disabled={!keepSelection}
                        className="w-full py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Review Merge
                      </button>
                    ) : (
                      <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 space-y-4">
                        <h4 className="font-bold text-amber-900">Final Confirmation</h4>
                        <div className="bg-white rounded-xl border p-3 text-sm space-y-1">
                          <div className="font-bold">WARNING — This will permanently consolidate two student records.</div>
                          <ul className="list-disc pl-5 text-slate-600 space-y-1 mt-2">
                            <li>✓ preserve historical records</li>
                            <li>✓ preserve exam IDs</li>
                            <li>✓ consolidate duplicate enrollments</li>
                            <li>✓ preserve the selected student's Student ID ({keepSelection === 'A' ? selectedPair.studentA.id : selectedPair.studentB.id})</li>
                            <li>✓ create a merge audit record</li>
                          </ul>
                          <p className="text-red-600 font-semibold mt-2">The duplicate student record will then be removed. This action cannot be safely undone without a recovery process.</p>
                        </div>

                        <div>
                          <label className="text-sm font-semibold text-slate-700">Merge reason (optional)</label>
                          <textarea
                            value={mergeReason}
                            onChange={e => setMergeReason(e.target.value)}
                            placeholder="Example: Duplicate created during September class import. Verified same student using Gov ID and parent account."
                            className="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 outline-none"
                            rows={3}
                          />
                        </div>

                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input type="checkbox" checked={reviewChecked} onChange={e => setReviewChecked(e.target.checked)} className="w-4 h-4 rounded" />
                          I have reviewed this merge
                        </label>

                        {(preview.riskLevel === 'high' || preview.riskLevel === 'critical') && (
                          <div>
                            <label className="text-sm font-semibold">Type MERGE to confirm (high-risk merge protection)</label>
                            <input
                              value={mergeInput}
                              onChange={e => setMergeInput(e.target.value)}
                              placeholder="Type MERGE"
                              className="mt-1 w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono focus:ring-2 focus:ring-indigo-200 outline-none"
                            />
                            <p className="text-xs text-slate-500 mt-1">This protects against accidental clicks.</p>
                          </div>
                        )}

                        <div className="flex gap-3">
                          <button onClick={() => setShowConfirm(false)} className="flex-1 py-2.5 bg-white border border-slate-200 rounded-xl font-semibold text-sm hover:bg-slate-50">
                            Cancel
                          </button>
                          <button
                            onClick={handleMerge}
                            disabled={merging || !reviewChecked || ((preview.riskLevel === 'high' || preview.riskLevel === 'critical') && mergeInput.trim() !== 'MERGE')}
                            className="flex-1 py-2.5 bg-red-600 text-white rounded-xl font-semibold text-sm hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                            {merging && <Loader2 className="w-4 h-4 animate-spin" />}
                            Confirm Merge
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}
      </Dialog>

      {/* Audit view */}
      <Dialog open={!!showAudit} onClose={() => setShowAudit(null)} title="Merge Audit">
        {showAudit && (
          <div className="space-y-4 text-sm">
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
              <div className="font-bold text-emerald-800 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Merge successful</div>
              <div className="mt-2 space-y-1">
                <div>Kept: <span className="font-mono font-bold">{showAudit.canonical_id || showAudit.canonicalId}</span></div>
                <div>Merged: <span className="font-mono font-bold">{showAudit.duplicate_id || showAudit.duplicateId}</span></div>
                <div>Admin: {showAudit.admin_id || '—'}</div>
                <div>Audit ID: <span className="font-mono text-xs">{showAudit.id || showAudit.auditId}</span></div>
                <div>Time: {new Date(showAudit.created_at || showAudit.createdAt).toLocaleString()}</div>
              </div>
            </div>
            <div>
              <h5 className="font-bold">Enrollment</h5>
              <pre className="bg-slate-50 rounded-xl p-3 text-xs overflow-auto">{JSON.stringify(showAudit.enrollment_action || showAudit.enrollmentAction, null, 2)}</pre>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <h5 className="font-bold">Before</h5>
                <pre className="bg-slate-50 rounded-xl p-3 text-xs overflow-auto">{JSON.stringify(showAudit.before_counts || showAudit.before, null, 2)}</pre>
              </div>
              <div>
                <h5 className="font-bold">After</h5>
                <pre className="bg-slate-50 rounded-xl p-3 text-xs overflow-auto">{JSON.stringify(showAudit.after_counts || showAudit.after, null, 2)}</pre>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3">
              <p className="font-semibold">Verification</p>
              <ul className="list-disc pl-5 text-xs text-slate-600 mt-1">
                <li>canonical student exists</li>
                <li>duplicate student no longer exists</li>
                <li>duplicate has zero child records</li>
                <li>one open enrollment remains</li>
                <li>exam IDs preserved</li>
              </ul>
            </div>
          </div>
        )}
      </Dialog>

      {/* Past merges list */}
      {audits.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <h3 className="font-bold text-slate-900 flex items-center gap-2"><History className="w-4 h-4" /> Recent Merges — Audit Trail</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase border-b">
                  <th className="py-2">Time</th>
                  <th className="py-2">Canonical ID</th>
                  <th className="py-2">Merged ID</th>
                  <th className="py-2">Admin</th>
                  <th className="py-2">Reason</th>
                  <th className="py-2">Audit</th>
                </tr>
              </thead>
              <tbody>
                {audits.slice(0, 10).map((a: any) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="py-2 text-xs">{new Date(a.created_at).toLocaleString()}</td>
                    <td className="py-2 font-mono text-xs">{a.canonical_id}</td>
                    <td className="py-2 font-mono text-xs">{a.duplicate_id}</td>
                    <td className="py-2 text-xs">{a.admin_id || '—'}</td>
                    <td className="py-2 text-xs max-w-[200px] truncate">{a.reason || '—'}</td>
                    <td className="py-2"><button onClick={() => setShowAudit(a)} className="text-indigo-600 hover:underline text-xs">View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600">
        <p className="font-bold flex items-center gap-1"><ShieldCheck className="w-4 h-4" /> Safety guarantees</p>
        <ul className="list-disc pl-5 mt-1 space-y-1">
          <li>No <span className="font-mono">DELETE FROM students</span> runs from the UI — the only deletion path is the transaction-safe merge RPC with zero-dependency verification.</li>
          <li>No <span className="font-semibold">Merge All / Delete All Duplicates / Auto Clean</span> button exists. Every duplicate is reviewed and merged individually.</li>
          <li>Dry-run preview makes zero writes.</li>
          <li>Exam and Gov ID conflicts block the merge; conflicting enrollments block the merge.</li>
        </ul>
      </div>
    </div>
  );
}
