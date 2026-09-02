// /gate — mobile-first dismissal gate lookup.
// Family-card scanning and typed lookup live in GateFamilyLookup, which is
// shared with office workflows instead of being duplicated here.

import { useCallback, useState } from 'react';
import { UserPlus, Check, Phone, HeartHandshake, UserRound, Loader2 } from 'lucide-react';
import { GateFamilyLookup, type FamilyLookupStatus } from '../../../components/gate/GateFamilyLookup';
import { DriverFormDialog } from '../../../components/pickup/DriverFormDialog';
import { useToast } from '../../../context/ToastContext';
import { getAuthorizedPickups, type AuthorizedPickup } from '../../../lib/db/authorizedPickups';
import { recordRelease, type GateLookupResult, type GateLookupRow } from '../../../lib/db/gate';
import { errorBuzz, successBeep } from '../../../lib/gate/beep';
import { gateT, gateTransportLabel, type GateLang } from '../../../lib/i18n/gateStrings';
import { displayFamilyId } from '../../../lib/transport';

export function GateScreen({ navigate }: { navigate: (path: string) => void }) {
  const [lang, setLang] = useState<GateLang>('so');
  const t = gateT(lang);
  const { addToast } = useToast();
  const [result, setResult] = useState<GateLookupResult | null>(null);
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [pickupsLoading, setPickupsLoading] = useState(false);
  const [driverFormOpen, setDriverFormOpen] = useState(false);
  const [selectedPickupId, setSelectedPickupId] = useState<string | null>(null);
  // studentId → ISO timestamp of successful release (release log)
  const [released, setReleased] = useState<Record<string, string>>({});
  const [releasing, setReleasing] = useState<Record<string, boolean>>({});
  const [releaseErrors, setReleaseErrors] = useState<Record<string, boolean>>({});

  const handleFound = useCallback(async (nextResult: GateLookupResult) => {
    setResult(nextResult);
    setPickups([]);
    setSelectedPickupId(null);
    setReleased({});
    setReleaseErrors({});
    setPickupsLoading(true);
    try {
      const familyPickups = await getAuthorizedPickups(nextResult.familyId);
      setPickups(familyPickups);
      // Selecting the first existing person keeps the handoff fast. Staff can
      // tap a different person, or add the person who is physically present.
      setSelectedPickupId(familyPickups[0]?.personId ?? null);
    } catch (error) {
      addToast({ type: 'error', title: 'Pickup list unavailable', description: error instanceof Error ? error.message : 'Try the family lookup again.' });
    } finally {
      setPickupsLoading(false);
    }
  }, [addToast]);

  const handleLookupStatus = useCallback((status: FamilyLookupStatus) => {
    if (status === 'checking' || status === 'idle') {
      setResult(null);
      setPickups([]);
      setSelectedPickupId(null);
      setReleased({});
      setReleaseErrors({});
    }
  }, []);

  const pickupForStudent = useCallback((studentId: string): AuthorizedPickup | null => {
    return pickups.find(pickup => pickup.personId === selectedPickupId && pickup.studentIds.includes(studentId))
      ?? pickups.find(pickup => pickup.studentIds.includes(studentId))
      ?? null;
  }, [pickups, selectedPickupId]);

  const handleRelease = useCallback(async (student: GateLookupRow, familyId: string) => {
    setReleasing(previous => ({ ...previous, [student.id]: true }));
    setReleaseErrors(previous => ({ ...previous, [student.id]: false }));
    try {
      const record = await recordRelease(student.id, familyId, pickupForStudent(student.id)?.personId);
      setReleased(previous => ({ ...previous, [student.id]: record.createdAt }));
      successBeep();
    } catch {
      setReleaseErrors(previous => ({ ...previous, [student.id]: true }));
      errorBuzz();
    } finally {
      setReleasing(previous => ({ ...previous, [student.id]: false }));
    }
  }, [pickupForStudent]);

  const selectedPickup = pickups.find(pickup => pickup.personId === selectedPickupId) ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <button onClick={() => navigate('/dashboard')} className="flex min-h-[44px] items-center gap-1 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-200">
          ← {t.back}
        </button>
        <div className="text-center">
          <div className="text-base font-bold leading-tight">{t.title}</div>
          <div className="text-xs text-slate-500">{t.subtitle}</div>
        </div>
        <div className="flex rounded-full border border-slate-300 bg-white p-0.5 text-xs font-bold">
          <button onClick={() => setLang('so')} aria-pressed={lang === 'so'} className={`min-h-[36px] rounded-full px-3 ${lang === 'so' ? 'bg-emerald-800 text-white' : 'text-slate-500'}`}>So</button>
          <button onClick={() => setLang('en')} aria-pressed={lang === 'en'} className={`min-h-[36px] rounded-full px-3 ${lang === 'en' ? 'bg-emerald-800 text-white' : 'text-slate-500'}`}>EN</button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-6">
        <GateFamilyLookup lang={lang} onFound={handleFound} onStatusChange={handleLookupStatus} />

        {result && (
          <div role="status" className="mt-5 rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-xl font-black text-emerald-900">
              <span aria-hidden className="text-3xl">✓</span>
              {t.found} · {displayFamilyId(result.familyId)}
            </div>

            <section className="mt-4 border-t border-emerald-200 pt-3" aria-labelledby="authorized-pickups-heading">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 id="authorized-pickups-heading" className="text-base font-black text-emerald-950">Authorized pickup people</h2>
                  <p className="text-xs text-emerald-800">Select who is collecting today.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDriverFormOpen(true)}
                  className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-emerald-800 px-3 text-sm font-black text-white shadow-sm active:scale-95"
                >
                  <UserPlus className="h-4 w-4" /> Add Driver
                </button>
              </div>

              {pickupsLoading && (
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-white p-3 text-sm font-semibold text-slate-600"><Loader2 className="h-4 w-4 animate-spin" /> Loading authorized pickup people…</div>
              )}
              {!pickupsLoading && pickups.length === 0 && (
                <div className="mt-3 rounded-xl border border-dashed border-emerald-300 bg-white p-3 text-sm text-slate-600">
                  No authorized pickup people yet. Add the person at the gate before release.
                </div>
              )}
              <div className="mt-3 space-y-2">
                {pickups.map(pickup => {
                  const selected = pickup.personId === selectedPickupId;
                  return (
                    <button
                      type="button"
                      key={pickup.personId}
                      onClick={() => setSelectedPickupId(pickup.personId)}
                      aria-pressed={selected}
                      className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition ${selected ? 'border-emerald-700 bg-emerald-100 ring-2 ring-emerald-300' : 'border-emerald-200 bg-white hover:border-emerald-500'}`}
                    >
                      <img src={pickup.photoUrl} alt={`${pickup.name} profile`} className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-black text-slate-900">{pickup.name}</span>
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-600"><Phone className="h-3 w-3" /> {pickup.phoneNumber}</span>
                        {pickup.relationship && <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500"><HeartHandshake className="h-3 w-3" /> {pickup.relationship}</span>}
                        {pickup.studentNames.length > 0 && <span className="mt-0.5 block truncate text-[11px] font-semibold text-emerald-700">For: {pickup.studentNames.join(', ')}</span>}
                      </span>
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-emerald-700 text-white' : 'bg-slate-100 text-transparent'}`}><Check className="h-4 w-4" /></span>
                    </button>
                  );
                })}
              </div>
            </section>

            {selectedPickup && (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-100 px-3 py-2 text-xs font-bold text-emerald-900">
                <UserRound className="h-4 w-4" /> {selectedPickup.name}
                <span className="ml-auto rounded-full bg-emerald-700 px-2 py-0.5 text-[10px] font-black text-white">Selected driver</span>
              </div>
            )}

            <div className="mt-3 space-y-2">
              {result.students.map(student => {
                const releasedAt = released[student.id];
                const releasePickup = pickupForStudent(student.id);
                return (
                  <div key={student.id} className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white p-3">
                    <div className="min-w-0">
                      <div className="text-lg font-bold">{student.name}</div>
                      <div className="text-sm text-slate-500">{student.className} · {gateTransportLabel(lang, student.transport)}</div>
                      {releasedAt && <div className="text-xs font-semibold text-emerald-700">{t.releasedAt}: {new Date(releasedAt).toLocaleTimeString()}</div>}
                      {releaseErrors[student.id] && <div className="text-xs font-semibold text-red-600">{t.releaseFailed}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800">{gateTransportLabel(lang, student.transport)}</span>
                      {releasedAt ? (
                        <span className="rounded-full bg-emerald-700 px-3 py-1 text-xs font-black text-white">✓ {t.released}</span>
                      ) : (
                        <>
                          {releasePickup && <span className="max-w-[112px] text-right text-[10px] font-bold text-emerald-700">with {releasePickup.name}</span>}
                          <button onClick={() => void handleRelease(student, result.familyId)} disabled={!!releasing[student.id]} className="min-h-[44px] rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50">
                            {releasing[student.id] ? t.releasing : `✓ ${t.release}`}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 text-sm text-slate-700"><Phone className="mr-1 inline h-4 w-4" /> {t.phone}: <b>{result.students.find(student => student.parentPhone)?.parentPhone ?? '—'}</b></div>
          </div>
        )}
      </main>

      <DriverFormDialog
        open={driverFormOpen}
        familyId={result?.familyId ?? ''}
        students={result?.students ?? []}
        onClose={() => setDriverFormOpen(false)}
        onSaved={pickup => {
          setPickups(previous => [pickup, ...previous]);
          setSelectedPickupId(pickup.personId);
        }}
      />
    </div>
  );
}
