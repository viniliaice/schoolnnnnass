import { useCallback, useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { lookupGateFamily, type GateLookupResult } from '../../lib/db/gate';
import { errorBuzz, successBeep } from '../../lib/gate/beep';
import { formatGateDigits, gateCanCheck, normalizeGateInput } from '../../lib/gate/gate-utils';
import { gateT, type GateLang } from '../../lib/i18n/gateStrings';
import { displayFamilyId } from '../../lib/transport';

export type FamilyLookupStatus = 'idle' | 'checking' | 'found' | 'not-found' | 'error';
type CameraState = 'off' | 'starting' | 'on' | 'denied';

const KEYPAD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];

interface GateFamilyLookupProps {
  /** Soomaali-first on the gate; office can switch to English for the same control. */
  lang?: GateLang;
  /** Keeps the family lookup/result contract identical for gate and office. */
  compact?: boolean;
  onFound: (result: GateLookupResult) => void;
  onStatusChange?: (status: FamilyLookupStatus, result: GateLookupResult | null) => void;
}

/**
 * Shared family-card lookup control. The dismissal gate and the office's
 * related pickup workflows can use this component, so typed IDs, hardware
 * scanners, and QR camera scanning stay on one code path.
 */
export function GateFamilyLookup({ lang = 'so', compact = false, onFound, onStatusChange }: GateFamilyLookupProps) {
  const t = gateT(lang);
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState<FamilyLookupStatus>('idle');
  const [result, setResult] = useState<GateLookupResult | null>(null);
  const [camera, setCamera] = useState<CameraState>('off');
  const [cameraError, setCameraError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const digitsRef = useRef(digits);
  digitsRef.current = digits;

  const report = useCallback((nextStatus: FamilyLookupStatus, nextResult: GateLookupResult | null) => {
    setStatus(nextStatus);
    setResult(nextResult);
    onStatusChange?.(nextStatus, nextResult);
  }, [onStatusChange]);

  const reset = useCallback(() => {
    report('idle', null);
    setDigits('');
    inputRef.current?.focus();
  }, [report]);

  const doCheck = useCallback(async (rawInput?: string) => {
    const normalized = normalizeGateInput(rawInput ?? digitsRef.current);
    if (!gateCanCheck(normalized)) return;
    report('checking', null);
    try {
      const found = await lookupGateFamily(normalized);
      if (found.found) {
        report('found', found);
        onFound(found);
        successBeep();
      } else {
        report('not-found', found);
        errorBuzz();
      }
    } catch {
      report('error', null);
      errorBuzz();
    }
  }, [onFound, report]);

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
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.max(160, Math.min(viewfinderWidth, viewfinderHeight));
            return { width: size, height: size };
          },
        },
        decoded => { void onScan(decoded); },
        () => { /* per-frame decode errors are expected */ },
      );
      setCamera('on');
    } catch {
      setCamera('denied');
      setCameraError(t.cameraDenied);
      try { scannerRef.current?.clear(); } catch { /* noop */ }
      scannerRef.current = null;
    }
  }, [camera, onScan, stopCamera, t.cameraDenied]);

  useEffect(() => () => { void stopCamera(); }, [stopCamera]);

  const appendDigit = (digit: string) => {
    if (status !== 'idle' && status !== 'checking') report('idle', null);
    setDigits(previous => normalizeGateInput(previous + digit));
    inputRef.current?.focus();
  };

  const onInputChange = (value: string) => {
    if (status === 'not-found' || status === 'error' || status === 'found') report('idle', null);
    setDigits(normalizeGateInput(value));
  };

  const checkDisabled = status === 'checking' || !gateCanCheck(digits);
  // Preserve the original gate scanner mount point so existing camera
  // permissions/tests and QR hardware integrations continue to use the same
  // lookup path.
  const scannerId = 'gate-scanner';

  return (
    <section className={compact ? 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm' : ''} aria-label="Family card lookup">
      {compact && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Find a family</h2>
            <p className="text-xs text-slate-500">Search by card number or scan the family card.</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">Same gate lookup</span>
        </div>
      )}

      <input
        ref={inputRef}
        value={formatGateDigits(digits)}
        onChange={event => onInputChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void doCheck();
          }
        }}
        inputMode="numeric"
        autoFocus={!compact}
        aria-label={t.displayHint}
        placeholder={t.emptyPrompt}
        className={compact
          ? 'w-full rounded-xl border-2 border-slate-300 bg-white px-4 py-3 text-center text-2xl font-black tracking-[0.18em] outline-none placeholder:text-sm placeholder:font-semibold placeholder:tracking-normal focus:border-emerald-700'
          : 'w-full rounded-2xl border-2 border-slate-300 bg-white py-5 text-center text-5xl font-black tracking-[0.2em] text-slate-900 shadow-sm outline-none placeholder:text-2xl placeholder:font-semibold placeholder:tracking-normal placeholder:text-slate-400 focus:border-emerald-700'}
      />
      {!compact && (
        <p className="mt-2 text-center text-sm text-slate-500">
          {digits.length === 0 ? t.displayHint : gateCanCheck(digits) ? t.displayHint : t.partialHint}
        </p>
      )}

      <div id={scannerId} className={camera === 'off' ? 'hidden' : 'mx-auto mb-3 mt-3 aspect-square w-full max-w-xs overflow-hidden rounded-2xl bg-black'} />
      {camera !== 'off' && (
        <p className="mb-3 text-center text-sm text-slate-500">
          {camera === 'starting' ? t.cameraStarting : camera === 'on' ? t.scanPrompt : cameraError || t.cameraDenied}
        </p>
      )}

      {!compact && camera === 'off' && (
        <div className="mb-4 mt-4">
          <div className="grid grid-cols-3 gap-3">
            {KEYPAD_ROWS.flat().map(digit => (
              <button key={digit} type="button" onPointerDown={event => event.preventDefault()} onClick={() => appendDigit(digit)} className="min-h-[64px] rounded-2xl bg-white text-3xl font-bold text-slate-800 shadow-sm transition active:scale-95 active:bg-emerald-100">{digit}</button>
            ))}
            <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { report('idle', null); setDigits(''); }} className="min-h-[64px] rounded-2xl bg-white text-base font-bold text-slate-500 shadow-sm active:bg-slate-100">{t.clear}</button>
            <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => appendDigit('0')} className="min-h-[64px] rounded-2xl bg-white text-3xl font-bold text-slate-800 shadow-sm transition active:scale-95 active:bg-emerald-100">0</button>
            <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => setDigits(previous => previous.slice(0, -1))} aria-label="backspace" className="min-h-[64px] rounded-2xl bg-white text-2xl font-bold text-slate-500 shadow-sm active:bg-slate-100">⌫</button>
          </div>
        </div>
      )}

      <div className={compact ? 'mt-3 flex gap-2' : 'flex gap-3'}>
        <button
          type="button"
          onClick={() => void toggleCamera()}
          disabled={camera === 'starting'}
          className={compact ? 'min-h-[46px] flex-1 rounded-xl bg-slate-800 px-3 text-sm font-bold text-white shadow-sm disabled:opacity-50' : 'min-h-[56px] flex-1 rounded-2xl bg-slate-800 text-lg font-bold text-white shadow-sm transition active:scale-95 disabled:opacity-50'}
        >
          {camera === 'off' ? `📷 ${t.scan}` : `⏹ ${t.stopScan}`}
        </button>
        <button
          type="button"
          onClick={() => void doCheck()}
          disabled={checkDisabled}
          className={compact ? 'min-h-[46px] flex-[1.4] rounded-xl bg-emerald-800 px-3 text-sm font-black text-white shadow-sm disabled:opacity-40' : 'min-h-[56px] flex-[2] rounded-2xl bg-emerald-800 text-lg font-black text-white shadow-sm transition active:scale-95 disabled:opacity-40'}
        >
          {status === 'checking' ? t.checking : `✓ ${t.check}`}
        </button>
      </div>

      {compact && status === 'found' && result && (
        <div role="status" className="mt-3 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-900">
          <span>✓ Family found</span><span>{displayFamilyId(result.familyId)}</span>
        </div>
      )}
      {compact && status === 'not-found' && result && (
        <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          No family found for {displayFamilyId(result.familyId)}. Check the card number and try again.
          <button type="button" onClick={reset} className="ml-2 font-black underline">Try again</button>
        </div>
      )}
      {compact && status === 'error' && (
        <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          Lookup could not be completed. <button type="button" onClick={reset} className="font-black underline">Try again</button>
        </div>
      )}

      {!compact && status === 'error' && (
        <div role="alert" className="mt-5 rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-center">
          <div className="text-lg font-bold text-red-800">✕ {t.error}</div>
          <div className="text-sm text-red-700">{t.errorHint}</div>
          <button type="button" onClick={reset} className="mt-3 min-h-[44px] rounded-xl bg-red-700 px-5 text-sm font-bold text-white">{t.tryAgain}</button>
        </div>
      )}
      {!compact && status === 'not-found' && result && (
        <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-red-700 px-6 text-white" style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 24px, transparent 24px 48px), linear-gradient(135deg, #b91c1c, #7f1d1d)' }}>
          <div aria-hidden className="text-8xl font-black leading-none">✕</div>
          <div className="mt-4 text-5xl font-black tracking-widest">{t.notFound}</div>
          <div className="mt-3 font-mono text-3xl font-bold">{displayFamilyId(result.familyId)}</div>
          <p className="mt-4 max-w-sm text-center text-lg opacity-95">{t.notFoundHint}</p>
          <p className="mt-1 text-sm opacity-80">✓ {t.audited}</p>
          <button type="button" onClick={reset} className="mt-10 min-h-[56px] rounded-2xl bg-white px-10 text-xl font-black text-red-700 shadow-lg transition active:scale-95">{t.tryAgain}</button>
        </div>
      )}
    </section>
  );
}
