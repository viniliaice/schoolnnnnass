// /gate — dismissal gate terminal (M2, redesigned 2026-09-02).
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
//
// ZERO LAYOUT SHIFT (2026-09-02)
// ------------------------------
// Previously the screen committed `status='found'` as soon as lookup_family
// returned and THEN fetched get_family_pickups, so students painted first and
// every card grew/moved when the driver text and buttons arrived.
//
// Now `loadGateFamily()` (src/lib/gate/loadFamily.ts) runs both RPCs in
// PARALLEL and resolves ONE complete snapshot; the screen holds a single
// `family` object and only ever renders a complete family. While it loads, the
// results region renders `StudentCardSkeleton`s built from the SAME shell as
// the real card, so the skeleton→content swap is a pure content replacement.
// A monotonically increasing `scanToken` discards any late response from a
// previous family, so Family A's students can never mix with Family B's
// drivers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { recordRelease, type GateLookupRow } from '../../../lib/db/gate';
import { removeStudentDriver, type FamilyPickup } from '../../../lib/db/authorizedPickups';
import { loadGateFamily, refreshGateFamilyDrivers, type GateFamilyState } from '../../../lib/gate/loadFamily';
import { buildBulkReleasePlan, formatGateDigits, gateCanCheck, normalizeGateInput, summarizeBulk, type BulkSummary } from '../../../lib/gate/gate-utils';
import { errorBuzz, successBeep } from '../../../lib/gate/beep';
import { gateT, type GateLang } from '../../../lib/i18n/gateStrings';
import { displayFamilyId } from '../../../lib/transport';
import { useToast } from '../../../context/ToastContext';
import { AssignDriverPanel } from './AssignDriverPanel';
import { StudentCard, StudentCardSkeleton } from './StudentCard';

type GateStatus = 'idle' | 'checking' | 'found' | 'not-found' | 'error';
type CameraState = 'off' | 'starting' | 'on' | 'denied';

const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

/** Cards to reserve while loading — matches the typical family size. */
const SKELETON_COUNT = 2;
/** Subtle stagger between cards; deliberately small so it never feels slow. */
const STAGGER_MS = 40;

export function GateScreen({ navigate }: { navigate: (path: string) => void }) {
  const [lang, setLang] = useState<GateLang>('en');
  const t = gateT(lang);
  const { addToast } = useToast();

  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<GateStatus>('idle');
  /** The ONE complete family snapshot (students + drivers, always together). */
  const [family, setFamily] = useState<GateFamilyState | null>(null);
  const [camera, setCamera] = useState<CameraState>('off');
  const [cameraError, setCameraError] = useState('');
  const [released, setReleased] = useState<Record<string, string>>({});
  const [releasing, setReleasing] = useState<Record<string, boolean>>({});
  const [releaseErrors, setReleaseErrors] = useState<Record<string, boolean>>({});
  const [pickerStudent, setPickerStudent] = useState<GateLookupRow | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const digitsRef = useRef(digits);
  digitsRef.current = digits;
  /** Monotonic scan id — only the newest scan may commit state. */
  const scanToken = useRef(0);
  /** Guards setState after unmount (camera/scan can resolve late). */
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const resetToIdle = useCallback(() => {
    scanToken.current += 1; // invalidate anything still in flight
    setStatus('idle');
    setFamily(null);
    setReleased({});
    setReleasing({});
    setReleaseErrors({});
    setPickerStudent(null);
    setBulkSummary(null);
    inputRef.current?.focus();
  }, []);

  const driverById = useMemo(
    () => new Map((family?.pickups ?? []).map(p => [p.id, p] as const)),
    [family],
  );

  const doCheck = useCallback(async (rawInput?: string) => {
    const normalized = normalizeGateInput(rawInput ?? digitsRef.current);
    if (!gateCanCheck(normalized)) return;

    const token = ++scanToken.current;
    // Clear the PREVIOUS family before loading the next one — stale students
    // must never be visible while the new family's drivers are loading.
    setFamily(null);
    setReleased({});
    setReleasing({});
    setReleaseErrors({});
    setBulkSummary(null);
    setPickerStudent(null);
    setStatus('checking');

    try {
      // students + driver assignments, in parallel → one complete state.
      const next = await loadGateFamily(normalized);
      if (!mounted.current || token !== scanToken.current) return; // superseded
      setFamily(next);
      if (next.found) {
        successBeep();
        setStatus('found');
      } else {
        errorBuzz();
        setStatus('not-found');
      }
    } catch {
      if (!mounted.current || token !== scanToken.current) return;
      errorBuzz();
      setStatus('error');
    }
  }, []);

  /** Re-read only the assignments and fold them into the snapshot atomically. */
  const reloadDrivers = useCallback(async () => {
    const token = scanToken.current;
    const current = family;
    if (!current) return;
    const next = await refreshGateFamilyDrivers(current);
    if (!mounted.current || token !== scanToken.current) return;
    setFamily(prev => (prev && prev.familyId === next.familyId ? next : prev));
  }, [family]);

  const handleRelease = useCallback(async (student: GateLookupRow, familyId: string, driverId: string | null) => {
    setReleasing(prev => ({ ...prev, [student.id]: true }));
    setReleaseErrors(prev => ({ ...prev, [student.id]: false }));
    const token = scanToken.current;
    try {
      const record = await recordRelease(student.id, familyId, driverId);
      if (!mounted.current || token !== scanToken.current) return;
      setReleased(prev => ({ ...prev, [student.id]: record.createdAt }));
      successBeep();
    } catch {
      if (!mounted.current || token !== scanToken.current) return;
      setReleaseErrors(prev => ({ ...prev, [student.id]: true }));
      errorBuzz();
    } finally {
      if (mounted.current && token === scanToken.current) {
        setReleasing(prev => ({ ...prev, [student.id]: false }));
      }
    }
  }, []);

  const handleBulkRelease = useCallback(async (driverId: string, studentIds: string[], familyId: string) => {
    const token = scanToken.current;
    setReleasing(prev => {
      const next = { ...prev };
      for (const sid of studentIds) next[sid] = true;
      return next;
    });
    // Each student is validated and audited separately by the RPC; run them in
    // parallel so a 5-child family is one round-trip's latency, not five.
    const outcomes = await Promise.all(studentIds.map(async sid => {
      try {
        const record = await recordRelease(sid, familyId, driverId);
        return { studentId: sid, ok: true as const, at: record.createdAt };
      } catch {
        return { studentId: sid, ok: false as const, at: '' };
      }
    }));
    if (!mounted.current || token !== scanToken.current) return;

    setReleased(prev => {
      const next = { ...prev };
      for (const o of outcomes) if (o.ok) next[o.studentId] = o.at;
      return next;
    });
    setReleaseErrors(prev => {
      const next = { ...prev };
      for (const o of outcomes) next[o.studentId] = !o.ok;
      return next;
    });
    setReleasing(prev => {
      const next = { ...prev };
      for (const sid of studentIds) next[sid] = false;
      return next;
    });

    const summary = summarizeBulk(outcomes.map(o => ({ studentId: o.studentId, ok: o.ok })));
    setBulkSummary(summary);
    if (summary.ok > 0) successBeep(); else errorBuzz();
  }, []);

  const handleRemoveDriver = useCallback(async (student: GateLookupRow) => {
    try {
      await removeStudentDriver(student.id);
      addToast({ type: 'success', title: t.removeDriver, description: student.name });
      await reloadDrivers();
    } catch {
      errorBuzz();
      addToast({ type: 'error', title: t.releaseFailed });
    }
  }, [addToast, reloadDrivers, t.removeDriver, t.releaseFailed]);

  // ─── Camera (html5-qrcode) ──────────────────────────────────────────────
  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      try { await scanner.stop(); } catch { /* already stopped */ }
      try { scanner.clear(); } catch { /* already cleared */ }
    }
    if (mounted.current) setCamera('off');
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
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.max(160, Math.min(viewfinderWidth, viewfinderHeight));
            return { width: size, height: size };
          },
        },
        decoded => { void onScan(decoded); },
        () => { /* per-frame errors are noisy — ignore */ },
      );
      if (mounted.current) setCamera('on');
    } catch {
      setCamera('denied');
      setCameraError(t.cameraDenied);
      try { scannerRef.current?.clear(); } catch { /* noop */ }
      scannerRef.current = null;
    }
  }, [camera, onScan, stopCamera, t.cameraDenied]);

  // Stop the camera when leaving the screen (prevents a leaked media stream).
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

  const isChecking = status === 'checking';
  const checkDisabled = isChecking || !gateCanCheck(digits);
  const statusLabel = isChecking ? t.scanning : status === 'found' ? t.familyFound : t.ready;
  const statusTone = isChecking ? 'bg-amber-500' : status === 'error' ? 'bg-rose-500' : 'bg-emerald-500';

  return (
    <div className="gate-screen flex min-h-screen flex-col bg-slate-100 text-slate-900">
      {/* Chrome at edges */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-2 px-4 py-2.5">
          <button
            onClick={() => navigate('/dashboard')}
            className="gate-press min-h-[44px] rounded-lg px-2.5 text-sm font-semibold text-slate-600 transition duration-150 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            ← {t.back}
          </button>
          <div className="min-w-0 text-center">
            <div className="truncate text-sm font-bold leading-tight">{t.title}</div>
            <div className="truncate text-[11px] text-slate-500">{t.subtitle}</div>
          </div>
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-bold">
            {(['so', 'en'] as GateLang[]).map(code => (
              <button
                key={code}
                onClick={() => setLang(code)}
                aria-pressed={lang === code}
                className={`min-h-[36px] rounded-md px-2.5 transition duration-150 ${lang === code ? 'bg-emerald-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                {code === 'so' ? 'So' : 'EN'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pb-8 pt-4">
        {/* Terminal status line — the operator's single "what is happening" cue */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-lg font-bold tracking-tight">{t.title}</h1>
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600"
          >
            <span aria-hidden className={`gate-dot h-2 w-2 rounded-full ${statusTone}`} />
            {statusLabel}
          </div>
        </div>

        {/* 1 · Family ID panel */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <label htmlFor="gate-family-id" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {t.family} ID
          </label>
          <div className="relative mt-1.5 overflow-hidden rounded-lg">
            <input
              id="gate-family-id"
              ref={inputRef}
              value={formatGateDigits(digits)}
              onChange={e => onInputChange(e.target.value)}
              onKeyDown={onInputKeyDown}
              inputMode="numeric"
              autoFocus
              autoComplete="off"
              aria-describedby="gate-id-hint"
              placeholder={t.emptyPrompt}
              className="w-full rounded-lg border-2 border-slate-300 bg-slate-50 py-4 text-center text-4xl font-black tracking-[0.18em] text-slate-900 outline-none transition-colors duration-150 placeholder:text-lg placeholder:font-semibold placeholder:tracking-normal placeholder:text-slate-400 focus:border-emerald-700 focus:bg-white"
            />
            {/* Scan sweep — transform-only, sits above the field, affects nothing */}
            {isChecking && (
              <span
                aria-hidden
                className="gate-scanline pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-transparent via-emerald-400/25 to-transparent"
              />
            )}
          </div>
          <p id="gate-id-hint" className="mt-1.5 h-4 text-center text-xs text-slate-500">
            {digits.length === 0 ? t.displayHint : gateCanCheck(digits) ? t.displayHint : t.partialHint}
          </p>

          {/* 2 · Input: keypad OR camera */}
          <div id="gate-scanner" className={camera === 'off' ? 'hidden' : 'mx-auto mt-3 aspect-square w-full max-w-xs overflow-hidden rounded-lg bg-black'} />
          {camera === 'off' ? (
            <div className="mt-3 grid grid-cols-3 gap-2.5">
              {KEYPAD_ROWS.flat().map(d => (
                <button
                  key={d}
                  onPointerDown={e => e.preventDefault()}
                  onClick={() => appendDigit(d)}
                  className="gate-press min-h-[56px] rounded-lg border border-slate-200 bg-slate-50 text-2xl font-bold text-slate-800 transition duration-100 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.97] active:bg-emerald-50"
                >
                  {d}
                </button>
              ))}
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => setDigits('')}
                className="gate-press min-h-[56px] rounded-lg border border-slate-200 bg-white text-sm font-semibold text-slate-500 transition duration-100 hover:bg-slate-100 active:scale-[0.97]"
              >
                {t.clear}
              </button>
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => appendDigit('0')}
                className="gate-press min-h-[56px] rounded-lg border border-slate-200 bg-slate-50 text-2xl font-bold text-slate-800 transition duration-100 hover:bg-slate-100 active:scale-[0.97] active:bg-emerald-50"
              >
                0
              </button>
              <button
                onPointerDown={e => e.preventDefault()}
                onClick={() => setDigits(prev => prev.slice(0, -1))}
                aria-label="backspace"
                className="gate-press min-h-[56px] rounded-lg border border-slate-200 bg-white text-xl font-bold text-slate-500 transition duration-100 hover:bg-slate-100 active:scale-[0.97]"
              >
                ⌫
              </button>
            </div>
          ) : (
            <p className="mt-3 h-5 text-center text-sm text-slate-500">
              {camera === 'starting' ? t.cameraStarting : camera === 'on' ? t.scanPrompt : cameraError || t.cameraDenied}
            </p>
          )}

          {/* 3 · Actions */}
          <div className="mt-3 flex gap-2.5">
            <button
              onClick={() => void toggleCamera()}
              disabled={camera === 'starting'}
              className="gate-press min-h-[52px] flex-1 rounded-lg border border-slate-300 bg-white text-base font-bold text-slate-700 transition duration-150 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.985] disabled:opacity-50"
            >
              {camera === 'off' ? `📷 ${t.scan}` : `⏹ ${t.stopScan}`}
            </button>
            <button
              onClick={() => void doCheck()}
              disabled={checkDisabled}
              aria-busy={isChecking}
              className="gate-press min-h-[52px] flex-[2] rounded-lg bg-emerald-800 text-base font-black text-white transition duration-150 hover:bg-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isChecking ? t.scanning : `✓ ${t.check}`}
            </button>
          </div>
        </section>

        {/* ── Results ─────────────────────────────────────────────────────── */}
        <div className="mt-5 flex items-center gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t.results}</h2>
          <div aria-hidden className="h-px flex-1 bg-slate-200" />
          {status === 'found' && (
            <button
              onClick={resetToIdle}
              className="gate-press min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-600 transition duration-150 hover:bg-slate-50"
            >
              {t.newScan}
            </button>
          )}
        </div>

        <div className="mt-2.5">
          {/* Loading: the results shell is IDENTICAL in structure to the found
              shell, so the skeleton→result swap replaces content in place. */}
          {isChecking && (
            <section aria-busy="true" className="gate-fade rounded-xl border border-slate-200 bg-white p-3.5">
              <div className="flex min-h-[32px] items-center gap-2">
                <span aria-hidden className="gate-dot h-2.5 w-2.5 rounded-full bg-amber-500" />
                <span className="text-sm font-bold text-slate-700">{t.loadingFamily}</span>
              </div>
              <ul className="mt-3 space-y-2.5">
                {Array.from({ length: SKELETON_COUNT }, (_, i) => (
                  <StudentCardSkeleton key={i} stagger={i * STAGGER_MS} />
                ))}
              </ul>
            </section>
          )}

          {status === 'found' && family && (
            <section role="status" aria-live="polite" className="gate-enter rounded-xl border border-emerald-300 bg-white p-3.5">
              <div className="flex min-h-[32px] items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="text-emerald-700">✓</span>
                  <span className="text-sm font-bold text-emerald-900">{t.familyFound}</span>
                  <span className="font-mono text-sm font-bold text-slate-700">{displayFamilyId(family.familyId)}</span>
                </div>
                <span className="text-xs font-semibold text-slate-500">
                  {family.students.length} {t.students}
                </span>
              </div>

              {family.pickupsFailed && (
                <p role="alert" className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
                  {t.driverLoadFailed}
                </p>
              )}

              <BulkReleaseButtons
                students={family.students}
                assignmentByStudent={family.assignmentByStudent}
                driverById={driverById}
                released={released}
                releasing={releasing}
                bulkSummary={bulkSummary}
                t={t}
                onBulk={(driverId, ids) => void handleBulkRelease(driverId, ids, family.familyId)}
              />

              <ul className="mt-3 space-y-2.5">
                {family.students.map((s, i) => (
                  <StudentCard
                    key={s.id}
                    student={s}
                    driver={driverById.get(family.assignmentByStudent[s.id])}
                    releasedAt={released[s.id]}
                    releasing={!!releasing[s.id]}
                    failed={!!releaseErrors[s.id]}
                    lang={lang}
                    t={t}
                    stagger={i * STAGGER_MS}
                    onRelease={() => void handleRelease(s, family.familyId, family.assignmentByStudent[s.id] ?? null)}
                    onAssign={() => setPickerStudent(s)}
                    onRemoveDriver={() => void handleRemoveDriver(s)}
                  />
                ))}
              </ul>

              <p className="mt-3 text-xs text-slate-600">
                📞 {t.phone}: <b>{family.students.find(s => s.parentPhone)?.parentPhone ?? '—'}</b>
              </p>
            </section>
          )}

          {status === 'idle' && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-8 text-center text-sm text-slate-500">
              {t.noResultsYet}
            </p>
          )}

          {status === 'error' && (
            <section role="alert" className="gate-enter rounded-xl border border-rose-300 bg-rose-50 p-4 text-center">
              <div className="text-base font-bold text-rose-800">✕ {t.error}</div>
              <p className="mt-1 text-sm text-rose-700">{t.errorHint}</p>
              <button
                onClick={resetToIdle}
                className="gate-press mt-3 min-h-[44px] rounded-lg bg-rose-700 px-5 text-sm font-bold text-white transition duration-150 hover:bg-rose-800 active:scale-[0.985]"
              >
                {t.tryAgain}
              </button>
            </section>
          )}
        </div>
      </main>

      {/* NOT FOUND — full red screen (not a toast), per design decision 4 */}
      {status === 'not-found' && family && (
        <div
          role="alert"
          className="gate-fade fixed inset-0 z-50 flex flex-col items-center justify-center bg-red-700 px-6 text-white"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 24px, transparent 24px 48px), linear-gradient(135deg, #b91c1c, #7f1d1d)',
          }}
        >
          <div aria-hidden className="text-7xl font-black leading-none">✕</div>
          <div className="mt-4 text-4xl font-black tracking-widest">{t.notFound}</div>
          <div className="mt-3 font-mono text-2xl font-bold">{displayFamilyId(family.familyId)}</div>
          <p className="mt-4 max-w-sm text-center text-base opacity-95">{t.notFoundHint}</p>
          <p className="mt-1 text-sm opacity-80">✓ {t.audited}</p>
          <button
            onClick={resetToIdle}
            className="gate-press mt-10 min-h-[56px] rounded-xl bg-white px-10 text-lg font-black text-red-700 transition duration-150 active:scale-[0.985]"
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
        onAssigned={() => { void reloadDrivers(); }}
      />
    </div>
  );
}

/** Bulk "Release all for X" — only for drivers shared by ≥2 eligible students. */
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
  // included; bus/LEFT/unknown students are never included.
  const groups = useMemo(() => {
    const driverIds = new Set<string>();
    for (const s of students) {
      const id = assignmentByStudent[s.id];
      if (id) driverIds.add(id);
    }
    const result: Array<{ driverId: string; ids: string[] }> = [];
    for (const driverId of driverIds) {
      const ids = buildBulkReleasePlan(students, assignmentByStudent, driverId)
        .filter(id => !released[id]);
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
          <div key={driverId} className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-800">
                {driver ? `${driver.name} · ${driver.phoneNumber}` : driverId}
              </div>
              <div className="text-xs text-slate-500">
                {ids.length} {t.studentsAssigned}
                {bulkSummary && bulkSummary.total > 0
                  ? ` · ${bulkSummary.ok}/${bulkSummary.total} ${t.bulkReleased}`
                  : ''}
              </div>
            </div>
            <button
              onClick={() => onBulk(driverId, ids)}
              disabled={busy}
              aria-busy={busy}
              className="gate-press min-h-[44px] shrink-0 rounded-lg bg-emerald-800 px-4 text-sm font-bold text-white transition duration-150 hover:bg-emerald-900 active:scale-[0.985] disabled:opacity-50"
            >
              {busy ? t.releasing : `${t.releaseAllFor} ${driver?.name ?? ''}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
