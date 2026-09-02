// /gate — mobile-first dismissal gate lookup (M2).
//
// Design spec (design review 2026-08-02):
//   IA: ID display dominant → keypad/scan → result. Chrome at edges.
//   States: idle / checking / found (green + beep) / NOT FOUND (full red
//   screen + buzz + audit) / error / camera (starting/on/denied).
//   A11y: ≥44px touch targets (keys ~64px), numerals ≥32px, not color-only
//   (✓/✕ + tone), English-first with Soomaali toggle.
//   Hardware barcode scanners type into the focused display input + Enter —
//   same path as the keypad (no extra code).
//
// Transport eligibility (2026-09-03): the gate is NOT for every student.
//   walking  (WALKER / CAR / unset) → one-click release, AND may be assigned a
//                                      registered driver for a temporary pickup
//                                      (permanent transport is left unchanged).
//   driver   (DRIVER)               → release requires an assigned registered driver.
//   bus      (numeric)              → never released or assigned (no buttons;
//                                      the server rejects both).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { lookupGateFamily, recordRelease, type GateLookupResult, type GateLookupRow } from '../../../lib/db/gate';
import { getFamilyPickups, removeStudentDriver, resolvePickupPhotoUrls, type FamilyPickup } from '../../../lib/db/authorizedPickups';
import { buildBulkReleasePlan, formatGateDigits, gateCanCheck, gateEligibility, normalizeGateInput, summarizeBulk, type BulkSummary } from '../../../lib/gate/gate-utils';
import { errorBuzz, successBeep } from '../../../lib/gate/beep';
import { gateT, gateTransportLabel, type GateLang } from '../../../lib/i18n/gateStrings';
import { displayFamilyId } from '../../../lib/transport';
import { useToast } from '../../../context/ToastContext';
import { AssignDriverPanel } from './AssignDriverPanel';

type GateStatus = 'idle' | 'checking' | 'found' | 'not-found' | 'error';
type CameraState = 'off' | 'starting' | 'on' | 'denied';

const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

export function GateScreen({ navigate }: { navigate: (path: string) => void }) {
  const [lang, setLang] = useState<GateLang>('en');
  const t = gateT(lang);
  const { addToast } = useToast();

  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<GateStatus>('idle');
  const [result, setResult] = useState<GateLookupResult | null>(null);
  const [camera, setCamera] = useState<CameraState>('off');
  const [cameraError, setCameraError] = useState('');
  // studentId → ISO timestamp of successful release (release log)
  const [released, setReleased] = useState<Record<string, string>>({});
  // studentId → release in flight
  const [releasing, setReleasing] = useState<Record<string, boolean>>({});
  // studentId → last release attempt failed (surfaces an inline retry)
  const [releaseErrors, setReleaseErrors] = useState<Record<string, boolean>>({});
  // Authorized pickup people for the matched family (loaded after "found").
  const [pickups, setPickups] = useState<FamilyPickup[] | null>(null);
  const [pickupsLoading, setPickupsLoading] = useState(false);
  // personId -> signed photo URL (private bucket; resolved per render).
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map());
  // The eligible student (walking or driver transport) currently being assigned
  // a registered driver.
  const [pickerStudent, setPickerStudent] = useState<GateLookupRow | null>(null);
  // Result of the last "Release all for X" (partial-failure aware).
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const digitsRef = useRef(digits);
  digitsRef.current = digits;

  const resetToIdle = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setReleased({});
    setReleasing({});
    setReleaseErrors({});
    setPickups(null);
    setPickupsLoading(false);
    setPhotoUrls(new Map());
    setPickerStudent(null);
    setBulkSummary(null);
    inputRef.current?.focus();
  }, []);

  const loadPickups = useCallback(async (familyId: string) => {
    setPickups(null);
    setPickupsLoading(true);
    try {
      const list = await getFamilyPickups(familyId);
      setPickups(list);
      // Sign the private-bucket photos in parallel; a signing failure just
      // falls back to the initial avatar — it never blocks the list or a release.
      resolvePickupPhotoUrls(list)
        .then(setPhotoUrls)
        .catch(() => setPhotoUrls(new Map()));
    } catch {
      // The assigned list is advisory; a failure here must not block a release.
      setPickups([]);
    } finally {
      setPickupsLoading(false);
    }
  }, []);

  // studentId → their assigned driver id (first wins; the RPC enforces one).
  const assignmentByStudent = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of pickups ?? []) {
      for (const sid of p.studentIds) if (!map[sid]) map[sid] = p.id;
    }
    return map;
  }, [pickups]);

  const driverById = useMemo(() => new Map((pickups ?? []).map(p => [p.id, p])), [pickups]);

  // Record one handoff. driverId null = a plain walking release; a driver id =
  // a driver pickup (walking or DRIVER transport). Bus/LEFT/unknown are rejected
  // by the RPC, and a DRIVER student without an assignment cannot release.
  const handleRelease = useCallback(async (student: GateLookupRow, familyId: string, driverId: string | null) => {
    setReleasing(prev => ({ ...prev, [student.id]: true }));
    setReleaseErrors(prev => ({ ...prev, [student.id]: false }));
    try {
      const record = await recordRelease(student.id, familyId, driverId);
      setReleased(prev => ({ ...prev, [student.id]: record.createdAt }));
      successBeep();
    } catch {
      setReleaseErrors(prev => ({ ...prev, [student.id]: true }));
      errorBuzz();
    } finally {
      setReleasing(prev => ({ ...prev, [student.id]: false }));
    }
  }, []);

  // Bulk release: N individual recordRelease calls — each student is validated
  // and audited separately, and partial failures are reported per student.
  const handleBulkRelease = useCallback(async (driverId: string, studentIds: string[], familyId: string) => {
    const outcomes: Array<{ studentId: string; ok: boolean }> = [];
    for (const sid of studentIds) {
      setReleasing(prev => ({ ...prev, [sid]: true }));
      setReleaseErrors(prev => ({ ...prev, [sid]: false }));
      try {
        const record = await recordRelease(sid, familyId, driverId);
        setReleased(prev => ({ ...prev, [sid]: record.createdAt }));
        outcomes.push({ studentId: sid, ok: true });
      } catch {
        setReleaseErrors(prev => ({ ...prev, [sid]: true }));
        outcomes.push({ studentId: sid, ok: false });
      } finally {
        setReleasing(prev => ({ ...prev, [sid]: false }));
      }
    }
    const summary = summarizeBulk(outcomes);
    setBulkSummary(summary);
    if (summary.ok > 0) successBeep();
    else errorBuzz();
  }, []);

  const handleRemoveDriver = useCallback(async (student: GateLookupRow, familyId: string) => {
    try {
      await removeStudentDriver(student.id);
      addToast({ type: 'success', title: t.removeDriver, description: student.name });
      await loadPickups(familyId);
    } catch {
      errorBuzz();
      addToast({ type: 'error', title: t.releaseFailed });
    }
  }, [addToast, loadPickups, t.removeDriver, t.releaseFailed]);

  const doCheck = useCallback(async (rawInput?: string) => {
    const normalized = normalizeGateInput(rawInput ?? digitsRef.current);
    if (!gateCanCheck(normalized)) return;
    setStatus('checking');
    try {
      const res = await lookupGateFamily(normalized);
      setResult(res);
      if (res.found) {
        successBeep();
        setStatus('found');
        void loadPickups(normalized);
      } else {
        errorBuzz();
        setStatus('not-found');
      }
    } catch {
      errorBuzz();
      setStatus('error');
    }
  }, [loadPickups]);

  // ─── Camera (html5-qrcode) ──────────────────────────────────────────────
  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      try { await scanner.stop(); } catch { /* already stopped */ }
      try { scanner.clear(); } catch { /* already cleared */ }
    }
    setCamera('off');
  }, []);

  const onScan = useCallback(async (decoded: string) => {
    await stopCamera();
    const normalized = normalizeGateInput(decoded);
    if (normalized) {
      setDigits(normalized);
      void doCheck(normalized);
    }
  }, [doCheck, stopCamera]);

  const toggleCamera = useCallback(async () => {
    if (camera === 'on' || camera === 'starting') {
      await stopCamera();
      return;
    }
    setCamera('starting');
    setCameraError('');
    try {
      const scanner = new Html5Qrcode('gate-scanner', { verbose: false });
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Function form: compute a true square from the live viewfinder
          // dimensions instead of a fixed box the library may stretch to
          // match the container's aspect ratio.
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.max(160, Math.min(viewfinderWidth, viewfinderHeight));
            return { width: size, height: size };
          },
        },
        decoded => { void onScan(decoded); },
        () => { /* per-frame errors are noisy — ignore */ },
      );
      setCamera('on');
    } catch {
      setCamera('denied');
      setCameraError(t.cameraDenied);
      try { scannerRef.current?.clear(); } catch { /* noop */ }
      scannerRef.current = null;
    }
  }, [camera, onScan, stopCamera, t.cameraDenied]);

  // Stop the camera when leaving the screen.
  useEffect(() => () => { void stopCamera(); }, [stopCamera]);

  // ─── Handlers ───────────────────────────────────────────────────────────
  const appendDigit = (d: string) => {
    if (status === 'not-found') resetToIdle();
    setDigits(prev => normalizeGateInput(prev + d));
    inputRef.current?.focus();
  };

  const onInputChange = (value: string) => {
    if (status === 'not-found') resetToIdle();
    setDigits(normalizeGateInput(value));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void doCheck();
    }
  };

  const checkDisabled = status === 'checking' || !gateCanCheck(digits);

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      {/* Chrome at edges */}
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex min-h-[44px] items-center gap-1 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-200"
        >
          ← {t.back}
        </button>
        <div className="text-center">
          <div className="text-base font-bold leading-tight">{t.title}</div>
          <div className="text-xs text-slate-500">{t.subtitle}</div>
        </div>
        <div className="flex rounded-full border border-slate-300 bg-white p-0.5 text-xs font-bold">
          <button
            onClick={() => setLang('so')}
            aria-pressed={lang === 'so'}
            className={`min-h-[36px] rounded-full px-3 ${lang === 'so' ? 'bg-emerald-800 text-white' : 'text-slate-500'}`}
          >
            So
          </button>
          <button
            onClick={() => setLang('en')}
            aria-pressed={lang === 'en'}
            className={`min-h-[36px] rounded-full px-3 ${lang === 'en' ? 'bg-emerald-800 text-white' : 'text-slate-500'}`}
          >
            EN
          </button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-6">
        {/* 1 · ID display (dominant) */}
        <div className="mb-4">
          <input
            ref={inputRef}
            value={formatGateDigits(digits)}
            onChange={e => onInputChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            inputMode="numeric"
            autoFocus
            aria-label={t.displayHint}
            placeholder={t.emptyPrompt}
            className="w-full rounded-2xl border-2 border-slate-300 bg-white py-5 text-center text-5xl font-black tracking-[0.2em] text-slate-900 shadow-sm outline-none placeholder:text-2xl placeholder:font-semibold placeholder:tracking-normal placeholder:text-slate-400 focus:border-emerald-700"
          />
          <p className="mt-2 text-center text-sm text-slate-500">
            {digits.length === 0 ? t.displayHint : gateCanCheck(digits) ? t.displayHint : t.partialHint}
          </p>
        </div>

        {/* 2 · Input: keypad OR camera */}
        <div id="gate-scanner" className={camera === 'off' ? 'hidden' : 'mx-auto mb-4 aspect-square w-full max-w-xs overflow-hidden rounded-2xl bg-black'} />
        {camera === 'off' ? (
          <div className="mb-4">
            <div className="grid grid-cols-3 gap-3">
              {KEYPAD_ROWS.flat().map(d => (
                <button
                  key={d}
                  onPointerDown={e => e.preventDefault()}
                  onClick={() => appendDigit(d)}
                  className="min-h-[64px] rounded-2xl bg-white text-3xl font-bold text-slate-800 shadow-sm transition active:bg-emerald-100 active:scale-95"
                >
                  {d}
                </button>
              ))}
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => setDigits('')}
                className="min-h-[64px] rounded-2xl bg-white text-base font-bold text-slate-500 shadow-sm active:bg-slate-100"
              >
                {t.clear}
              </button>
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => appendDigit('0')}
                className="min-h-[64px] rounded-2xl bg-white text-3xl font-bold text-slate-800 shadow-sm active:bg-emerald-100 active:scale-95"
              >
                0
              </button>
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => setDigits(prev => prev.slice(0, -1))}
                aria-label="backspace"
                className="min-h-[64px] rounded-2xl bg-white text-2xl font-bold text-slate-500 shadow-sm active:bg-slate-100"
              >
                ⌫
              </button>
            </div>
          </div>
        ) : (
          <p className="mb-4 text-center text-sm text-slate-500">
            {camera === 'starting' ? t.cameraStarting : camera === 'on' ? t.scanPrompt : cameraError || t.cameraDenied}
          </p>
        )}

        {/* 3 · Actions */}
        <div className="flex gap-3">
          <button
            onClick={() => void toggleCamera()}
            disabled={camera === 'starting'}
            className="min-h-[56px] flex-1 rounded-2xl bg-slate-800 text-lg font-bold text-white shadow-sm transition active:scale-95 disabled:opacity-50"
          >
            {camera === 'off' ? `📷 ${t.scan}` : `⏹ ${t.stopScan}`}
          </button>
          <button
            onClick={() => void doCheck()}
            disabled={checkDisabled}
            className="min-h-[56px] flex-[2] rounded-2xl bg-emerald-800 text-lg font-black text-white shadow-sm transition active:scale-95 disabled:opacity-40"
          >
            {status === 'checking' ? t.checking : `✓ ${t.check}`}
          </button>
        </div>

        {/* Result area */}
        {status === 'found' && result && (
          <div role="status" className="mt-5 rounded-2xl border-2 border-emerald-600 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-xl font-black text-emerald-900">
              <span aria-hidden className="text-3xl">✓</span>
              {t.found} · {displayFamilyId(result.familyId)}
            </div>

            {/* "Release all for X" — bulk release for a driver shared by ≥2 students */}
            {pickupsLoading ? null : (
              <BulkReleaseButtons
                students={result.students}
                assignmentByStudent={assignmentByStudent}
                driverById={driverById}
                released={released}
                releasing={releasing}
                bulkSummary={bulkSummary}
                t={t}
                onBulk={(driverId, ids) => void handleBulkRelease(driverId, ids, result.familyId)}
              />
            )}

            {/* Students, classified by transport */}
            {result.students.map(s => {
              const eligibility = gateEligibility(s.transport);
              const releasedAt = released[s.id];
              const driver = driverById.get(assignmentByStudent[s.id]);

              if (eligibility === 'excluded') {
                const isBus = /^\d+$/.test((s.transport ?? '').trim());
                return (
                  <div key={s.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
                    <div className="min-w-0">
                      <div className="text-lg font-bold text-slate-700">{s.name}</div>
                      <div className="text-sm text-slate-500">{s.className}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold text-slate-600">
                        {isBus ? '🚌 ' : ''}{gateTransportLabel(lang, s.transport)}
                      </div>
                      <div className="text-xs font-semibold text-amber-700">{t.notEligible}</div>
                    </div>
                  </div>
                );
              }

              // Eligible: walking (WALKER/CAR) or driver (DRIVER) transport.
              // `driver` is the student's CURRENT pickup assignment — it may be
              // set on a walking student for a temporary pickup, and the
              // student's permanent transport is never overwritten.
              const isWalking = eligibility === 'walking';
              const badge = driver
                ? `🚗 ${isWalking ? t.driverPickup : gateTransportLabel(lang, s.transport)}`
                : `${isWalking ? '🚶' : '🚗'} ${gateTransportLabel(lang, s.transport)}`;
              const canRelease = isWalking || Boolean(driver);

              return (
                <div key={s.id} className="mt-2 rounded-xl border border-emerald-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-lg font-bold">{s.name}</div>
                      <div className="text-sm text-slate-500">{s.className} · {badge}</div>
                      <div className="mt-0.5 text-sm font-semibold text-slate-700">
                        {driver ? `${driver.name} · ${driver.phoneNumber}` : t.driverNotAssigned}
                      </div>
                      {releasedAt && (
                        <div className="text-xs font-semibold text-emerald-700">{t.releasedAt}: {new Date(releasedAt).toLocaleTimeString()}</div>
                      )}
                      {releaseErrors[s.id] && <div className="text-xs font-semibold text-red-600">{t.releaseFailed}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {releasedAt ? (
                        <span className="rounded-full bg-emerald-700 px-3 py-1 text-xs font-black text-white">✓ {t.released}</span>
                      ) : (
                        <>
                          {canRelease && (
                            <button
                              onClick={() => void handleRelease(s, result.familyId, driver?.id ?? null)}
                              disabled={!!releasing[s.id]}
                              className="min-h-[44px] shrink-0 rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50"
                            >
                              {releasing[s.id] ? t.releasing : `✓ ${t.release}`}
                            </button>
                          )}
                          {driver ? (
                            <button
                              onClick={() => setPickerStudent(s)}
                              className="min-h-[36px] shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
                            >
                              {t.changeDriver}
                            </button>
                          ) : (
                            <button
                              onClick={() => setPickerStudent(s)}
                              className="min-h-[44px] shrink-0 rounded-xl bg-amber-500 px-4 text-sm font-black text-white shadow-sm transition active:scale-95"
                            >
                              + {t.addDriver}
                            </button>
                          )}
                          {driver && (
                            <button
                              onClick={() => void handleRemoveDriver(s, result.familyId)}
                              className="min-h-[36px] shrink-0 rounded-lg border border-rose-300 bg-white px-3 text-xs font-bold text-rose-700 transition hover:bg-rose-50"
                            >
                              {t.removeDriver}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="mt-3 text-sm text-slate-700">
              📞 {t.phone}: <b>{result.students.find(s => s.parentPhone)?.parentPhone ?? '—'}</b>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div role="alert" className="mt-5 rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-center">
            <div className="text-lg font-bold text-red-800">✕ {t.error}</div>
            <div className="text-sm text-red-700">{t.errorHint}</div>
            <button
              onClick={resetToIdle}
              className="mt-3 min-h-[44px] rounded-xl bg-red-700 px-5 text-sm font-bold text-white"
            >
              {t.tryAgain}
            </button>
          </div>
        )}
      </main>

      {/* NOT FOUND — full red screen (not a toast), per design decision 4 */}
      {status === 'not-found' && result && (
        <div
          role="alert"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-red-700 px-6 text-white"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 24px, transparent 24px 48px), linear-gradient(135deg, #b91c1c, #7f1d1d)',
          }}
        >
          <div aria-hidden className="text-8xl font-black leading-none">✕</div>
          <div className="mt-4 text-5xl font-black tracking-widest">{t.notFound}</div>
          <div className="mt-3 font-mono text-3xl font-bold">{displayFamilyId(result.familyId)}</div>
          <p className="mt-4 max-w-sm text-center text-lg opacity-95">{t.notFoundHint}</p>
          <p className="mt-1 text-sm opacity-80">✓ {t.audited}</p>
          <button
            onClick={resetToIdle}
            className="mt-10 min-h-[56px] rounded-2xl bg-white px-10 text-xl font-black text-red-700 shadow-lg transition active:scale-95"
          >
            {t.tryAgain}
          </button>
        </div>
      )}

      {/* Assign a REGISTERED driver to one eligible student (walking or driver). */}
      <AssignDriverPanel
        open={pickerStudent !== null}
        onClose={() => setPickerStudent(null)}
        student={pickerStudent}
        t={t}
        lang={lang}
        onAssigned={() => { if (result) void loadPickups(result.familyId); }}
      />
    </div>
  );
}

/** Bulk "Release all for X" buttons — only for drivers shared by ≥2 eligible students. */
function BulkReleaseButtons({
  students,
  assignmentByStudent,
  driverById,
  released,
  releasing,
  bulkSummary,
  t,
  onBulk,
}: {
  students: GateLookupRow[];
  assignmentByStudent: Record<string, string>;
  driverById: Map<string, FamilyPickup>;
  released: Record<string, string>;
  releasing: Record<string, boolean>;
  bulkSummary: BulkSummary | null;
  t: ReturnType<typeof gateT>;
  onBulk: (driverId: string, studentIds: string[]) => void;
}) {
  // Group every gate-eligible student (walking OR driver transport) by their
  // assigned driver. Walking students temporarily assigned to a driver ARE
  // included; bus/LEFT/unknown students are never included (buildBulkReleasePlan
  // enforces the transport rule).
  const groups = useMemo(() => {
    const driverIds = new Set<string>();
    for (const s of students) {
      const id = assignmentByStudent[s.id];
      if (id) driverIds.add(id);
    }
    const result: Array<{ driverId: string; ids: string[] }> = [];
    for (const driverId of driverIds) {
      const ids = buildBulkReleasePlan(students, assignmentByStudent, driverId)
        .filter(id => !released[id]); // not already released this session
      if (ids.length >= 2) result.push({ driverId, ids });
    }
    return result;
  }, [students, assignmentByStudent, released]);

  if (groups.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {groups.map(({ driverId, ids }) => {
        const driver = driverById.get(driverId);
        const busy = ids.some(id => releasing[id]);
        return (
          <div key={driverId} className="rounded-xl border border-emerald-300 bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold text-slate-800">
                  {driver ? `${driver.name} · ${driver.phoneNumber}` : driverId}
                </div>
                <div className="text-xs text-slate-500">{ids.length} {t.studentsAssigned}</div>
              </div>
              <button
                onClick={() => onBulk(driverId, ids)}
                disabled={busy}
                className="min-h-[44px] shrink-0 rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50"
              >
                {busy ? t.releasing : `${t.releaseAllFor} ${driver?.name ?? ''}`}
              </button>
            </div>
            {bulkSummary && bulkSummary.total > 0 && (
              <p className="mt-2 text-xs font-semibold text-slate-600">
                {bulkSummary.ok} / {bulkSummary.total} {t.bulkReleased}
                {bulkSummary.failed > 0 ? ` · ${bulkSummary.failed} ${t.releaseFailedBulk}` : ''}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
