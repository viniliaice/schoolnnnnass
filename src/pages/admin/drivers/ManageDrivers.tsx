// Manage Drivers — a driver-management surface independent of the gate.
//
// The gate's AssignDriverPanel only SEARCHES registered drivers and assigns one
// to a single student (it never registers a driver). Here an admin/office user
// manages the whole driver list: see every authorized pickup person with how
// many students/families they are authorized for, open one to see (and remove)
// their linked students grouped by family, and attach students from any family
// via a school-wide search.
//
// Role gate (admin + office) lives in ROUTE_ACCESS + the SQL role checks —
// this page is the back-office surface, so supervisor is excluded (their
// students RLS is class-scoped; a whole-school driver->student->family browse
// would leak mappings beyond their classes — see 20260902_manage_drivers.sql).

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Search, Trash2, UserRound } from 'lucide-react';
import { useToast } from '../../../context/ToastContext';
import { getStudents } from '../../../lib/db/students';
import {
  attachStudentsToAuthorizedPickup, listAuthorizedPickups,
  removeStudentFromAuthorizedPickup, resolvePickupPhotoUrls,
  type AuthorizedPickupStudent, type ManagedDriver,
} from '../../../lib/db/authorizedPickups';
import { displayFamilyId, formatGradeLabel } from '../../../lib/transport';
import { NewDriverDialog } from './NewDriverDialog';
import { StudentSearchList } from './StudentSearchList';
import type { Student } from '../../../types';

export function ManageDrivers() {
  const { addToast } = useToast();
  const [drivers, setDrivers] = useState<ManagedDriver[] | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map());
  const [newOpen, setNewOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, roster] = await Promise.all([listAuthorizedPickups(), getStudents()]);
      setDrivers(list);
      setStudents(roster);
      // Sign private-bucket photos in parallel; a signing failure just falls
      // back to the initial avatar and never blocks the list.
      resolvePickupPhotoUrls(list).then(setPhotoUrls).catch(() => setPhotoUrls(new Map()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load drivers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const selected = drivers?.find(d => d.id === selectedId) ?? null;

  const attach = async (student: Student) => {
    if (!selected) return;
    setBusyId(student.id);
    try {
      await attachStudentsToAuthorizedPickup(selected.id, [student.id]);
      addToast({ type: 'success', title: `Added ${student.name}`, description: `Authorized ${selected.name} to pick up ${student.name}` });
      setAddQuery('');
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast({ type: 'error', title: 'Add failed', description: message });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (studentId: string) => {
    if (!selected) return;
    setBusyId(studentId);
    try {
      await removeStudentFromAuthorizedPickup(selected.id, studentId);
      addToast({ type: 'success', title: 'Removed student' });
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast({ type: 'error', title: 'Remove failed', description: message });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <p className="py-16 text-center text-sm text-slate-400">Loading drivers…</p>;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
        <p className="text-sm font-bold text-red-800">Could not load drivers</p>
        <p className="mt-1 text-xs text-red-700">{error}</p>
        <button onClick={() => void reload()} className="mt-3 rounded-xl bg-red-700 px-4 py-2 text-xs font-bold text-white hover:bg-red-800">
          Try again
        </button>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  if (selected) {
    const linkedIds = new Set(selected.students.map(s => s.id));
    const groups = groupByFamily(selected.students);
    return (
      <div>
        <div className="mb-4 flex items-center gap-2">
          <button
            onClick={() => setSelectedId(null)}
            className="inline-flex min-h-[40px] items-center gap-1 rounded-xl px-3 text-sm font-bold text-slate-600 hover:bg-slate-200"
          >
            <ArrowLeft className="h-4 w-4" /> All drivers
          </button>
        </div>

        {/* Driver header */}
        <div className="mb-5 flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {photoUrls.get(selected.id) ? (
            <img
              src={photoUrls.get(selected.id)}
              alt={selected.name}
              className="h-16 w-16 shrink-0 rounded-full border border-slate-200 object-cover"
            />
          ) : (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-2xl font-black text-emerald-800">
              {selected.name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-slate-900">{selected.name}</h1>
            <p className="text-sm text-slate-500">{selected.relationship || '—'}</p>
            <p className="text-sm font-semibold text-slate-600">{selected.phoneNumber}</p>
            <p className="mt-1 text-xs text-slate-400">
              {selected.studentCount} student{selected.studentCount === 1 ? '' : 's'} ·{' '}
              {selected.familyCount} famil{selected.familyCount === 1 ? 'y' : 'ies'}
            </p>
          </div>
        </div>

        {/* Linked students grouped by family */}
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-base font-bold text-slate-900">Authorized students</h2>
          {selected.students.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
              No students yet — search and add below.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map(([familyId, list]) => (
                <div key={familyId} className="rounded-xl border border-slate-100">
                  <div className="rounded-t-xl bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-900">
                    {displayFamilyId(familyId)}
                  </div>
                  {list.map(s => (
                    <div key={s.id} className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-700">{s.name}</div>
                        <div className="text-xs text-slate-400">{formatGradeLabel(s.className)}{s.transport === 'LEFT' ? ' · left' : ''}</div>
                      </div>
                      <button
                        onClick={() => void remove(s.id)}
                        disabled={busyId === s.id}
                        aria-label={`Remove ${s.name}`}
                        title={`Remove ${s.name}`}
                        className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-bold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Search-and-add students from any family */}
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-base font-bold text-slate-900">Add a student</h2>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={addQuery}
              onChange={e => setAddQuery(e.target.value)}
              placeholder="Search name, family ID, class…"
              className="w-full rounded-xl border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <StudentSearchList
            students={students}
            query={addQuery}
            excludeIds={linkedIds}
            actionLabel="Add"
            onAction={s => void attach(s)}
            emptyHint="Start typing to find students"
          />
        </section>
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manage Drivers</h1>
          <p className="text-sm text-slate-500">
            Authorized pickup people across the whole school — one driver, many families.
          </p>
        </div>
        <button
          onClick={() => setNewOpen(true)}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-emerald-800 px-4 py-2 text-sm font-black text-white transition hover:bg-emerald-900"
        >
          <Plus className="h-4 w-4" /> New driver
        </button>
      </div>

      {!drivers || drivers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">No drivers yet</p>
          <p className="mt-1 text-xs text-slate-500">Add one here, or from the dismissal gate when a new adult arrives.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {drivers.map(d => (
            <button
              key={d.id}
              onClick={() => setSelectedId(d.id)}
              className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-emerald-400"
            >
              {photoUrls.get(d.id) ? (
                <img
                  src={photoUrls.get(d.id)}
                  alt={d.name}
                  className="h-12 w-12 shrink-0 rounded-full border border-slate-200 object-cover"
                />
              ) : (
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-lg font-black text-emerald-800">
                  <UserRound className="h-6 w-6" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-800">{d.name}</div>
                <div className="text-xs text-slate-500">{d.relationship || '—'} · {d.phoneNumber}</div>
              </div>
              <div className="shrink-0 text-right text-xs font-semibold text-slate-500">
                <div>{d.studentCount} student{d.studentCount === 1 ? '' : 's'}</div>
                <div className="text-slate-400">{d.familyCount} famil{d.familyCount === 1 ? 'y' : 'ies'}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <NewDriverDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        drivers={drivers ?? []}
        students={students}
        onSaved={() => void reload()}
      />
    </div>
  );
}

/** Group a driver's linked students by family id (stable sort by name). */
function groupByFamily(students: ManagedDriver['students']): Array<[string, AuthorizedPickupStudent[]]> {
  const map = new Map<string, AuthorizedPickupStudent[]>();
  for (const s of students) {
    const key = s.familyId ?? '—';
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(
      ([familyId, list]) =>
        [familyId, [...list].sort((a, b) => a.name.localeCompare(b.name))] as [string, AuthorizedPickupStudent[]],
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}
