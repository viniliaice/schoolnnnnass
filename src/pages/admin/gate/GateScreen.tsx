// /gate — mobile-first dismissal gate lookup (M2).
//
// Design spec (design review 2026-08-02):
//   IA: ID display dominant → keypad/scan → result. Chrome at edges.
//   States: idle / checking / found (green + beep) / NOT FOUND (full red
//   screen + buzz + audit) / error / camera (starting/on/denied).
//   A11y: ≥44px touch targets (keys ~64px), numerals ≥32px, not color-only
//   (✓/✕ + tone), Soomaali-first with EN toggle.
//   Hardware barcode scanners type into the focused display input + Enter —
//   same path as the keypad (no extra code).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { lookupGateFamily, recordRelease, type GateLookupResult, type GateLookupRow } from '../../../lib/db/gate';
import { formatGateDigits, gateCanCheck, normalizeGateInput } from '../../../lib/gate/gate-utils';
import { errorBuzz, successBeep } from '../../../lib/gate/beep';
import { gateT, gateTransportLabel, type GateLang } from '../../../lib/i18n/gateStrings';
import { displayFamilyId } from '../../../lib/transport';

type GateStatus = 'idle' | 'checking' | 'found' | 'not-found' | 'error';
type CameraState = 'off' | 'starting' | 'on' | 'denied';

const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

export function GateScreen({ navigate }: { navigate: (path: string) => void }) {
  const [lang, setLang] = useState<GateLang>('so');
  const t = gateT(lang);

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
    inputRef.current?.focus();
  }, []);

  // Record a successful handoff in the release log (student, family, staff, time).
  const handleRelease = useCallback(async (student: GateLookupRow, familyId: string) => {
    setReleasing(prev => ({ ...prev, [student.id]: true }));
    setReleaseErrors(prev => ({ ...prev, [student.id]: false }));
    try {
      const record = await recordRelease(student.id, familyId);
      setReleased(prev => ({ ...prev, [student.id]: record.createdAt }));
      successBeep();
    } catch {
      setReleaseErrors(prev => ({ ...prev, [student.id]: true }));
      errorBuzz();
    } finally {
      setReleasing(prev => ({ ...prev, [student.id]: false }));
    }
  }, []);

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
      } else {
        errorBuzz();
        setStatus('not-found');
      }
    } catch {
      errorBuzz();
      setStatus('error');
    }
  }, []);

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
          // Use the function form so the scan region is always a square,
          // regardless of the video's native aspect ratio.
          qrbox: (videoWidth: number, videoHeight: number) => {
            const side = Math.min(videoWidth, videoHeight, 280);
            return { width: side, height: side };
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
        {/* Scanner element is ALWAYS in the DOM (hidden when off) so
            Html5Qrcode.start() can find it without racing React's render. */}
        <div id="gate-scanner" className={camera === 'off' ? 'hidden' : 'mb-4 w-full overflow-hidden rounded-2xl bg-black'} style={{ aspectRatio: '1 / 1' }} />
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
            {result.students.map(s => {
              const releasedAt = released[s.id];
              return (
                <div key={s.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white p-3">
                  <div className="min-w-0">
                    <div className="text-lg font-bold">{s.name}</div>
                    <div className="text-sm text-slate-500">{s.className} · {gateTransportLabel(lang, s.transport)}</div>
                    {releasedAt && (
                      <div className="text-xs font-semibold text-emerald-700">
                        {t.releasedAt}: {new Date(releasedAt).toLocaleTimeString()}
                      </div>
                    )}
                    {releaseErrors[s.id] && (
                      <div className="text-xs font-semibold text-red-600">{t.releaseFailed}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-800">
                      {gateTransportLabel(lang, s.transport)}
                    </span>
                    {releasedAt ? (
                      <span className="rounded-full bg-emerald-700 px-3 py-1 text-xs font-black text-white">✓ {t.released}</span>
                    ) : (
                      <button
                        onClick={() => void handleRelease(s, result.familyId)}
                        disabled={!!releasing[s.id]}
                        className="min-h-[44px] rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50"
                      >
                        {releasing[s.id] ? t.releasing : `✓ ${t.release}`}
                      </button>
                    )}
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
    </div>
  );
}
