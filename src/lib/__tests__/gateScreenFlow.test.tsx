// /qa — screen-level scan flow. These are the two failure modes the redesign
// exists to prevent:
//   • students painting BEFORE driver data (the old waterfall), and
//   • Family A's students still on screen while Family B loads (stale data).

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../gate/beep', () => ({ successBeep: vi.fn(), errorBuzz: vi.fn() }));
vi.mock('html5-qrcode', () => ({ Html5Qrcode: class { start() { return Promise.resolve(); } stop() { return Promise.resolve(); } clear() {} } }));
vi.mock('../../context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const lookupGateFamily = vi.fn();
const getFamilyPickups = vi.fn();
vi.mock('../db/gate', () => ({
  lookupGateFamily: (...a: unknown[]) => lookupGateFamily(...a),
  recordRelease: vi.fn(),
}));
vi.mock('../db/authorizedPickups', () => ({
  getFamilyPickups: (...a: unknown[]) => getFamilyPickups(...a),
  removeStudentDriver: vi.fn(),
  searchAuthorizedPickups: vi.fn().mockResolvedValue([]),
  attachStudentsToAuthorizedPickup: vi.fn(),
}));

import { GateScreen } from '../../pages/admin/gate/GateScreen';

const FAM_A = {
  found: true, familyId: '0050',
  students: [{ id: 'a1', name: 'RAYAAN AXMAD', className: 'Grade 1-C', transport: 'DRIVER', familyId: '0050', parentPhone: '1' }],
};
const FAM_B = {
  found: true, familyId: '0077',
  students: [{ id: 'b1', name: 'HODAN XASAN', className: 'Grade 3-B', transport: 'WALKER', familyId: '0077', parentPhone: '2' }],
};
const ASKO = { id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: null, photoPath: '', addedAt: '', studentIds: ['a1'] };

let container: HTMLDivElement;
let root: Root;

/** Flush pending microtasks (Promise.allSettled chains take several ticks). */
async function flush() {
  await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  lookupGateFamily.mockReset();
  getFamilyPickups.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<GateScreen navigate={() => {}} />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function type(value: string) {
  const input = container.querySelector('#gate-family-id') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Enter on the ID field — the hardware-scanner path, never disabled. */
function pressEnter() {
  const input = container.querySelector('#gate-family-id') as HTMLInputElement;
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

function clickCheck() {
  const btn = Array.from(container.querySelectorAll('button')).find(b => /Check|Scanning/.test(b.textContent ?? ''))!;
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const text = () => container.textContent ?? '';

describe('scan flow', () => {
  it('shows NO student data until the driver data has also arrived', async () => {
    let resolveDrivers: (v: unknown) => void = () => {};
    lookupGateFamily.mockResolvedValue(FAM_A);
    getFamilyPickups.mockReturnValue(new Promise(res => { resolveDrivers = res; }));

    type('0050');
    clickCheck();
    await flush();

    // Family lookup has resolved, drivers have NOT. The old code painted the
    // student here; the new code must show only the loading state.
    expect(text()).toContain('Loading family');
    expect(text()).not.toContain('RAYAAN AXMAD');

    act(() => { resolveDrivers([ASKO]); });
    await flush();

    // Now students AND their driver appear together, in one paint.
    expect(text()).toContain('RAYAAN AXMAD');
    expect(text()).toContain('ASKO');
    expect(text()).toContain('980797');
  });

  it('never mixes family A students with family B drivers on a re-scan', async () => {
    lookupGateFamily.mockResolvedValue(FAM_A);
    getFamilyPickups.mockResolvedValue([ASKO]);
    type('0050');
    clickCheck();
    await flush();
    expect(text()).toContain('RAYAAN AXMAD');

    // Scan family B; while it loads, family A must be gone entirely.
    let resolveB: (v: unknown) => void = () => {};
    lookupGateFamily.mockReturnValue(new Promise(res => { resolveB = res; }));
    getFamilyPickups.mockResolvedValue([]);
    type('0077');
    clickCheck();
    await flush();
    expect(text()).not.toContain('RAYAAN AXMAD');
    expect(text()).not.toContain('ASKO');
    expect(text()).toContain('Loading family');

    act(() => { resolveB(FAM_B); });
    await flush();
    expect(text()).toContain('HODAN XASAN');
    expect(text()).not.toContain('RAYAAN AXMAD');
  });

  it('discards a superseded slow scan (out-of-order responses)', async () => {
    let resolveSlowA: (v: unknown) => void = () => {};
    lookupGateFamily.mockReturnValueOnce(new Promise(res => { resolveSlowA = res; }));
    getFamilyPickups.mockResolvedValue([]);
    type('0050');
    clickCheck();
    await flush();

    // A barcode scanner can fire a second scan WHILE the first is in flight
    // (the Check button is disabled then, but Enter is not).
    lookupGateFamily.mockResolvedValue(FAM_B);
    type('0077');
    pressEnter();
    await flush();
    expect(text()).toContain('HODAN XASAN');

    // The stale family A response lands late and must be ignored.
    act(() => { resolveSlowA(FAM_A); });
    await flush();
    expect(text()).toContain('HODAN XASAN');
    expect(text()).not.toContain('RAYAAN AXMAD');
  });

  it('still renders the family when the driver lookup fails', async () => {
    lookupGateFamily.mockResolvedValue(FAM_A);
    getFamilyPickups.mockRejectedValue(new Error('drivers down'));
    type('0050');
    clickCheck();
    await flush();
    expect(text()).toContain('RAYAAN AXMAD');
    expect(text()).toContain('Driver data unavailable');
  });

  it('still commits results after a REMOUNT (StrictMode double-invoke)', async () => {
    // Regression: the `mounted` ref was cleared on unmount but never re-armed
    // on mount, so after StrictMode's simulated remount every async setState
    // was dropped and the screen froze on "Loading family…" forever. Found by
    // the real-browser QA run, which renders under <StrictMode>.
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const { StrictMode } = await import('react');
    act(() => { root.render(<StrictMode><GateScreen navigate={() => {}} /></StrictMode>); });

    lookupGateFamily.mockResolvedValue(FAM_A);
    getFamilyPickups.mockResolvedValue([ASKO]);
    type('0050');
    clickCheck();
    await flush();
    expect(text()).toContain('RAYAAN AXMAD');
    expect(text()).toContain('ASKO');
  });

  it('shows a clean error state for a failed lookup', async () => {
    lookupGateFamily.mockRejectedValue(new Error('boom'));
    getFamilyPickups.mockResolvedValue([]);
    type('0050');
    clickCheck();
    await flush();
    expect(text()).toContain('Something went wrong');
  });
});
