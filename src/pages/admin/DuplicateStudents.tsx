import { useEffect, useState, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Merge, Search, ShieldCheck, XCircle, Users, GraduationCap } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import { cn } from '../../utils/cn';
import { listDuplicateStudents, mergeDuplicateStudent, getDuplicateStudentDetails, type DuplicateGroup, type MergeResult } from '../../lib/db/duplicateMerge';
import { getUserById } from '../../lib/db/profiles';
import type { User } from '../../types';

interface EnrichedGroup extends DuplicateGroup {
  dryRun?: MergeResult;
  loading?: boolean;
}

export function DuplicateStudents() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<EnrichedGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EnrichedGroup | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [details, setDetails] = useState<any>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [parentMap, setParentMap] = useState<Map<string, User>>(new Map());

  const canMerge = session?.role === 'admin' || session?.role === 'supervisor';

  async function loadGroups() {
    setLoading(true);
    setError(null);
    try {
      const data = await listDuplicateStudents();
      // Initially no dry-run, will lazy load
      setGroups(data.map(g => ({ ...g, loading: false })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadGroups(); }, []);

  async function runDryRunForGroup(g: EnrichedGroup) {
    const assigned = g.members.filter(m => m.parentId);
    const unassigned = g.members.filter(m => !m.parentId);
    if (assigned.length !== 1 || unassigned.length !== 1) return;
    setGroups(prev => prev.map(x => x.name_key === g.name_key && x.class_key === g.class_key ? { ...x, loading: true } : x));
    try {
      const res = await mergeDuplicateStudent(assigned[0].id, unassigned[0].id, true, 'ui dry-run', 'admin_ui');
      setGroups(prev => prev.map(x => x.name_key === g.name_key && x.class_key === g.class_key ? { ...x, dryRun: res, loading: false } : x));
      if (selected && selected.name_key === g.name_key && selected.class_key === g.class_key) {
        setSelected({ ...g, dryRun: res, loading: false });
      }
    } catch (e) {
      setGroups(prev => prev.map(x => x.name_key === g.name_key && x.class_key === g.class_key ? { ...x, loading: false } : x));
      addToast({ type: 'error', title: 'Dry-run failed', description: e instanceof Error ? e.message : String(e) });
    }
  }

  async function openDetails(g: EnrichedGroup) {
    const assigned = g.members.filter(m => m.parentId);
    const unassigned = g.members.filter(m => !m.parentId);
    if (assigned.length !== 1 || unassigned.length !== 1) {
      addToast({ type: 'error', title: 'This group does not match the 1 assigned + 1 unassigned pattern' });
      return;
    }
    setSelected(g);
    setDetailsLoading(true);
    setDetails(null);
    try {
      const d = await getDuplicateStudentDetails(assigned[0].id, unassigned[0].id);
      setDetails(d);
      // Load parent names
      const ids = [assigned[0].parentId].filter(Boolean) as string[];
      for (const pid of ids) {
        if (!parentMap.has(pid)) {
          try {
            const p = await getUserById(pid);
            if (p) setParentMap(prev => new Map(prev).set(pid, p));
          } catch {}
        }
      }
      // Also ensure dryRun is present
      if (!g.dryRun) {
        await runDryRunForGroup(g);
      }
    } catch (e) {
      addToast({ type: 'error', title: 'Failed to load details', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDetailsLoading(false);
    }
  }

  async function handleMerge(g: EnrichedGroup, dryRun: boolean) {
    const assigned = g.members.filter(m => m.parentId);
    const unassigned = g.members.filter(m => !m.parentId);
    if (assigned.length !== 1 || unassigned.length !== 1) return;
    if (!canMerge) {
      addToast({ type: 'error', title: 'Not allowed', description: 'Only admins can merge' });
      return;
    }
    setMergeLoading(true);
    try {
      const res = await mergeDuplicateStudent(assigned[0].id, unassigned[0].id, dryRun, dryRun ? 'ui dry-run' : 'admin merge via UI', 'admin_ui');
      if (dryRun) {
        addToast({ type: 'info', title: res.can_merge ? 'Mergeable' : 'Blocked', description: res.can_merge ? 'This pair can be safely merged' : `Blocked: ${res.conflicts?.map((c:any)=>c.type).join(', ')}` });
        setGroups(prev => prev.map(x => x.name_key === g.name_key && x.class_key === g.class_key ? { ...x, dryRun: res } : x));
        setDetails((prev:any) => prev ? { ...prev, dry_run: res } : prev);
      } else {
        addToast({ type: 'success', title: 'Merged successfully', description: `${res.student_name} merged, audit ${res.audit_id}` });
        // Remove from list
        setGroups(prev => prev.filter(x => !(x.name_key === g.name_key && x.class_key === g.class_key)));
        setSelected(null);
        setDetails(null);
      }
    } catch (e) {
      addToast({ type: 'error', title: dryRun ? 'Dry-run failed' : 'Merge failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setMergeLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return groups;
    return groups.filter(g => g.display_name.toLowerCase().includes(term) || g.display_class.toLowerCase().includes(term));
  }, [groups, search]);

  const summary = useMemo(() => {
    const total = groups.length;
    const mergeable = groups.filter(g => g.dryRun?.can_merge).length;
    const blocked = groups.filter(g => g.dryRun && !g.dryRun.can_merge).length;
    const examConflict = groups.filter(g => g.dryRun?.conflicts?.some((c:any)=>c.type==='EXAM_CONFLICT')).length;
    const enrollment = groups.filter(g => g.dryRun?.conflicts?.some((c:any)=>c.type==='enrollment_conflict')).length;
    return { total, mergeable, blocked, examConflict, enrollment };
  }, [groups]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Users className="w-6 h-6 text-indigo-600" /> Duplicate Students Review</h1>
        <p className="text-sm text-slate-500 mt-1">
          Review duplicate student records (same normalized name + class, one assigned, one unassigned). Dry-run first, then merge safely. History is preserved, audit logged.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-2xl font-bold">{summary.total}</div><div className="text-xs text-slate-500">Total groups</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-2xl font-bold text-emerald-600">{summary.mergeable}</div><div className="text-xs text-slate-500">Mergeable (dry-run)</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-2xl font-bold text-rose-600">{summary.blocked}</div><div className="text-xs text-slate-500">Blocked</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-2xl font-bold text-amber-600">{summary.examConflict}</div><div className="text-xs text-slate-500">Exam conflict</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-2xl font-bold text-purple-600">{summary.enrollment}</div><div className="text-xs text-slate-500">Enrollment conflict</div></div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name or class…" className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 outline-none" />
        </div>
        <button onClick={loadGroups} className="px-3 py-2 rounded-xl border border-slate-200 text-sm hover:bg-slate-50 flex items-center gap-1"><Loader2 className={cn('w-4 h-4', loading && 'animate-spin')} /> Refresh</button>
      </div>

      {error && <div className="rounded-xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /><span className="ml-3 text-slate-500">Loading duplicate groups…</span></div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-slate-400 border-b border-slate-200"><th className="px-3 py-2">Student</th><th className="px-3 py-2">Class</th><th className="px-3 py-2">Keep (parent)</th><th className="px-3 py-2">Duplicate (unassigned)</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Actions</th></tr></thead>
            <tbody>
              {filtered.length===0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No duplicate groups found.</td></tr>}
              {filtered.map(g=>{
                const assigned = g.members.filter(m=>m.parentId)[0];
                const unassigned = g.members.filter(m=>!m.parentId)[0];
                const parentName = assigned?.parentId ? parentMap.get(assigned.parentId)?.name || assigned.parentId : '—';
                const can = g.dryRun?.can_merge;
                return (
                  <tr key={`${g.name_key}|${g.class_key}`} className="border-b border-slate-100 align-top">
                    <td className="px-3 py-2 font-medium">{g.display_name}</td>
                    <td className="px-3 py-2"><span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded text-xs">{g.display_class}</span></td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{assigned?.id}</div>
                      <div className="text-xs text-emerald-700">Parent: {parentName}</div>
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs">KEEP</span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{unassigned?.id}</div>
                      <div className="text-xs text-slate-500">Unassigned</div>
                      <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-xs">DUPLICATE</span>
                    </td>
                    <td className="px-3 py-2">
                      {g.loading && <span className="flex items-center gap-1 text-slate-500"><Loader2 className="w-3 h-3 animate-spin" /> checking…</span>}
                      {!g.loading && !g.dryRun && <span className="text-slate-400 text-xs">Not checked</span>}
                      {!g.loading && g.dryRun && (
                        <div className="space-y-1">
                          {g.dryRun.can_merge ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs"><CheckCircle2 className="w-3 h-3" /> Mergeable</span> : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-xs"><XCircle className="w-3 h-3" /> Blocked</span>}
                          {g.dryRun.enrollment_action && <div className="text-xs text-slate-600">Enroll: {g.dryRun.enrollment_action.type}</div>}
                          {g.dryRun.conflicts && g.dryRun.conflicts.length>0 && <div className="text-xs text-rose-600">{g.dryRun.conflicts.map((c:any)=>c.type).join(', ')}</div>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 space-y-1">
                      <button onClick={()=>openDetails(g)} className="block w-full text-left px-2 py-1 rounded bg-slate-50 hover:bg-slate-100 text-xs">View details</button>
                      <button onClick={()=>runDryRunForGroup(g)} disabled={g.loading} className="block w-full text-left px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-xs flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Dry Run</button>
                      {canMerge && g.dryRun?.can_merge && <button onClick={()=>handleMerge(g, false)} disabled={mergeLoading} className="block w-full text-left px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-700 text-white text-xs flex items-center gap-1"><Merge className="w-3 h-3" /> Merge</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4 shadow-lg">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2"><GraduationCap className="w-5 h-5" /> {selected.display_name} — {selected.display_class}</h2>
            <button onClick={()=>{setSelected(null); setDetails(null);}} className="text-sm text-slate-500 hover:text-slate-700">Close</button>
          </div>

          {detailsLoading ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading details…</div>
          ) : details ? (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                  <div className="text-xs font-bold text-emerald-800 uppercase">Keep (canonical)</div>
                  <div className="font-mono text-xs mt-1">{details.canonical.id}</div>
                  <div className="text-sm font-medium">{details.canonical.name} — {details.canonical.className}</div>
                  <div className="text-xs text-emerald-700">Parent: {details.canonical.parentId ? parentMap.get(details.canonical.parentId)?.name || details.canonical.parentId : '—'}</div>
                  <div className="mt-2 text-xs space-y-0.5">
                    {Object.entries(details.counts.canonical).map(([k,v])=><div key={k} className="flex justify-between"><span>{k}</span><span className="font-mono">{String(v)}</span></div>)}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
                  <div className="text-xs font-bold text-slate-700 uppercase">Duplicate (to merge from)</div>
                  <div className="font-mono text-xs mt-1">{details.duplicate.id}</div>
                  <div className="text-sm font-medium">{details.duplicate.name} — {details.duplicate.className}</div>
                  <div className="text-xs text-slate-500">Unassigned</div>
                  <div className="mt-2 text-xs space-y-0.5">
                    {Object.entries(details.counts.duplicate).map(([k,v])=><div key={k} className="flex justify-between"><span>{k}</span><span className="font-mono">{String(v)}</span></div>)}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-4">
                <div className="text-sm font-semibold flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-amber-600" /> Dry-run result</div>
                <pre className="mt-2 text-xs bg-slate-50 p-3 rounded overflow-auto max-h-96">{JSON.stringify(details.dry_run, null, 2)}</pre>
                <div className="mt-3 flex gap-2">
                  <button onClick={()=>handleMerge(selected, true)} disabled={mergeLoading} className="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 text-sm flex items-center gap-1"><ShieldCheck className="w-4 h-4" /> Dry Run again</button>
                  {canMerge && details.dry_run.can_merge && (
                    <button onClick={()=>handleMerge(selected, false)} disabled={mergeLoading} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm flex items-center gap-1">
                      {mergeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Merge className="w-4 h-4" />} Confirm Merge
                    </button>
                  )}
                  {!details.dry_run.can_merge && (
                    <div className="text-sm text-rose-600 flex items-center gap-1"><AlertTriangle className="w-4 h-4" /> Blocked: {details.dry_run.conflicts?.map((c:any)=>c.type).join(', ')}</div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500">No details</div>
          )}
        </div>
      )}
    </div>
  );
}
