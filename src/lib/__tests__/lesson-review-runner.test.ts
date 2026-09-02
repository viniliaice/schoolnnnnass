import { describe, expect, it, vi } from 'vitest';
import { DecisionRunner } from '../lessonReview/decisionRunner';
import type { DecisionPhase } from '../lessonReview/reviewQueue';

function makeRunner(submit: (kind: string, planId: string) => Promise<unknown>) {
  const phases: DecisionPhase[] = [];
  const onError = vi.fn();
  const runner = new DecisionRunner({
    submit: submit as never,
    setPhase: (p) => phases.push(p),
    onError,
  });
  return { runner, phases, onError };
}

/** A promise we can resolve/reject from the test to model a slow network. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('DecisionRunner — duplicate submission', () => {
  it('issues exactly ONE request for three rapid clicks', async () => {
    const gate = deferred<void>();
    const submit = vi.fn(() => gate.promise);
    const { runner, phases } = makeRunner(submit);

    // All three fire synchronously, before any await resolves.
    const a = runner.run('approve', 'plan-1');
    const b = runner.run('approve', 'plan-1');
    const c = runner.run('approve', 'plan-1');

    expect(submit).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await Promise.all([a, b, c])).toEqual([true, false, false]);

    // Exactly one submitting phase and one done phase — no flicker.
    expect(phases.filter((p) => p.phase === 'submitting')).toHaveLength(1);
    expect(phases.filter((p) => p.phase === 'done')).toHaveLength(1);
  });

  it('blocks a different decision while one is in flight', async () => {
    const gate = deferred<void>();
    const submit = vi.fn(() => gate.promise);
    const { runner } = makeRunner(submit);

    void runner.run('approve', 'plan-1');
    expect(await runner.run('reject', 'plan-1')).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    gate.resolve();
  });

  it('accepts a new decision once the previous one settles', async () => {
    const submit = vi.fn(async () => undefined);
    const { runner } = makeRunner(submit);

    await runner.run('approve', 'plan-1');
    await runner.run('revision', 'plan-2');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a selected plan', async () => {
    const submit = vi.fn(async () => undefined);
    const { runner, phases } = makeRunner(submit);
    expect(await runner.run('approve', null)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(phases).toHaveLength(0);
  });
});

describe('DecisionRunner — never a false success', () => {
  it('shows submitting BEFORE the server answers, and done only after', async () => {
    const gate = deferred<void>();
    const { runner, phases } = makeRunner(() => gate.promise);

    const run = runner.run('approve', 'plan-1');
    // Server has not answered yet.
    expect(phases).toEqual([{ phase: 'submitting', kind: 'approve' }]);
    expect(phases.some((p) => p.phase === 'done')).toBe(false);

    gate.resolve();
    await run;
    expect(phases[phases.length - 1]).toEqual({ phase: 'done', kind: 'approve' });
  });

  it('reports failure with a recoverable error phase, never done', async () => {
    const { runner, phases, onError } = makeRunner(async () => {
      throw new Error('network down');
    });

    await runner.run('approve', 'plan-1');

    expect(phases.some((p) => p.phase === 'done')).toBe(false);
    expect(phases[phases.length - 1]).toEqual({
      phase: 'error', kind: 'approve', message: 'network down',
    });
    expect(onError).toHaveBeenCalledWith('approve', 'network down');
  });

  it('unblocks after a failure so Try again works', async () => {
    let fail = true;
    const submit = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return undefined;
    });
    const { runner, phases } = makeRunner(submit);

    await runner.run('approve', 'plan-1');
    fail = false;
    expect(await runner.run('approve', 'plan-1')).toBe(true);
    expect(phases[phases.length - 1]).toEqual({ phase: 'done', kind: 'approve' });
  });
});

describe('DecisionRunner — rapid plan switching', () => {
  it('does not paint plan A\'s success onto plan B', async () => {
    const gate = deferred<void>();
    const { runner, phases } = makeRunner(() => gate.promise);

    void runner.run('approve', 'plan-A');
    // Supervisor jumps to another plan before the response lands.
    runner.detach();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Last phase is the reset from detach(), NOT a success for plan A.
    expect(phases[phases.length - 1]).toEqual({ phase: 'idle' });
    expect(phases.some((p) => p.phase === 'done')).toBe(false);
  });

  it('does not paint a stale FAILURE onto the newly selected plan either', async () => {
    const gate = deferred<void>();
    const { runner, phases, onError } = makeRunner(() => gate.promise);

    void runner.run('reject', 'plan-A');
    runner.detach();
    gate.reject(new Error('timeout'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(phases.some((p) => p.phase === 'error')).toBe(false);
    // The failure is still surfaced out-of-band so it is not silently lost.
    expect(onError).toHaveBeenCalledWith('reject', 'timeout');
  });
});
