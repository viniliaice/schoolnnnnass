// The concurrency-sensitive half of the decision flow, kept out of the React
// component so it can be tested directly (see lesson-review-runner.test.ts).
//
// Two hazards it exists to prevent:
//   1. Duplicate submission. Three fast clicks all execute before React
//      re-renders, so a check against component state would let 2 and 3
//      through. The guard flag is written synchronously.
//   2. Stale success. A supervisor can approve plan A and immediately click
//      plan B; when A's response lands the panel is showing B and must not be
//      painted with A's outcome.

import { IDLE, type DecisionKind, type DecisionPhase } from './reviewQueue';

export interface DecisionRunnerOptions {
  /** Performs the decision against the server. */
  submit: (kind: DecisionKind, planId: string) => Promise<unknown>;
  /** Applies a new phase to the UI. */
  setPhase: (phase: DecisionPhase) => void;
  /** Reports a failure out-of-band (toast/log). Optional. */
  onError?: (kind: DecisionKind, message: string) => void;
}

export class DecisionRunner {
  private busy = false;
  /** The plan whose result is currently allowed to update the UI. */
  private ownerPlanId: string | null = null;

  constructor(private readonly options: DecisionRunnerOptions) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * Called when the supervisor navigates to another plan. Any in-flight
   * response is disowned, so it can still finish (and still commit on the
   * server) without writing a phase for the plan now on screen.
   */
  detach(): void {
    this.ownerPlanId = null;
    this.options.setPhase(IDLE);
  }

  /**
   * Run one decision. Returns true if the request was actually issued, false
   * if it was suppressed as a duplicate.
   */
  async run(kind: DecisionKind, planId: string | null): Promise<boolean> {
    if (!planId || this.busy) return false;
    this.busy = true;
    this.ownerPlanId = planId;
    this.options.setPhase({ phase: 'submitting', kind });

    try {
      await this.options.submit(kind, planId);
      // Only claim success once the server has answered, and only if this plan
      // is still the one on screen.
      if (this.ownerPlanId === planId) this.options.setPhase({ phase: 'done', kind });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (this.ownerPlanId === planId) this.options.setPhase({ phase: 'error', kind, message });
      this.options.onError?.(kind, message);
      return true;
    } finally {
      this.busy = false;
    }
  }
}
