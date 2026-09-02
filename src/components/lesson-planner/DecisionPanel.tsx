import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Loader2, Unlock } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Dialog } from '../ui/Dialog';
import {
  confirmedLabel, submittingLabel, type DecisionKind, type DecisionPhase,
} from '../../lib/lessonReview/reviewQueue';

interface DecisionPanelProps {
  /** Current lifecycle state — the ONLY source of success/failure messaging. */
  phase: DecisionPhase;
  /** Shared comment: also the revision note, so it is never typed twice. */
  comment: string;
  onCommentChange: (value: string) => void;
  onDecide: (kind: DecisionKind) => void;
  onRetry: () => void;
  /** Advance to the next plan; absent when the queue is empty. */
  onNext: (() => void) | null;
  /** Plans still awaiting a decision, excluding the current one. */
  remaining: number;
  hasAiScore: boolean;
  /** True while the AI review is still running. */
  waitingOnAi: boolean;
  /** True when the AI review failed and the supervisor decides unaided. */
  aiFailed: boolean;
  /** Already sent back — the revision action is not repeatable. */
  alreadyRevision: boolean;
  commentPlaceholder: string;
  labels: { heading: string; approve: string; reject: string; requestRevisions: string };
}

const ACTION_BASE =
  'inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ' +
  'transition-[background-color,box-shadow,opacity] duration-150 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function DecisionPanel({
  phase, comment, onCommentChange, onDecide, onRetry, onNext, remaining,
  hasAiScore, waitingOnAi, aiFailed, alreadyRevision, commentPlaceholder, labels,
}: DecisionPanelProps) {
  const [confirmReject, setConfirmReject] = useState(false);
  const nextRef = useRef<HTMLButtonElement>(null);

  const busy = phase.phase === 'submitting';
  const done = phase.phase === 'done';
  // Once a decision has landed the actions are gone — the plan is decided and
  // the only forward move is the next plan. This also makes a duplicate click
  // physically impossible after success.
  const actionsDisabled = busy || done;

  const handleReject = useCallback(() => {
    setConfirmReject(false);
    onDecide('reject');
  }, [onDecide]);

  return (
    <section
      aria-labelledby="decision-heading"
      className={cn(
        'review-decision no-print z-10 rounded-2xl border-2 p-4 shadow-sm sm:p-5',
        'lg:sticky lg:bottom-4',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="decision-heading" className="review-decision-text text-base font-bold">{labels.heading}</h2>
        {waitingOnAi && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-800">
            <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" /> AI review pending
          </span>
        )}
        {aiFailed && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-2.5 py-1 text-xs font-bold text-orange-900">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Deciding without an AI score
          </span>
        )}
      </div>

      {/* AI is advisory. Small, secondary, one line — present so the point is
          on record, but never competing with the plan or the buttons.
          Suppressed when a chip above already says the same thing, so the
          panel never states the AI situation twice in a row. */}
      {(hasAiScore || !(aiFailed || waitingOnAi)) && (
        <p className="review-decision-muted mt-1 text-xs leading-5">
          {hasAiScore
            ? 'AI review is advisory. The decision is yours.'
            : 'No AI score — decide from the plan above.'}
        </p>
      )}

      {/* Live region: announces in-flight, success and failure to screen readers.
          Reserved as a block so its appearance never shifts the buttons. */}
      <div aria-live="polite" role="status" className="mt-3">
        {busy && (
          <p className="flex items-center gap-2 rounded-xl bg-white px-3 py-2.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200">
            <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
            {submittingLabel(phase.kind)}
          </p>
        )}
        {done && (
          <div className="rounded-xl bg-emerald-50 px-3 py-2.5 ring-1 ring-emerald-200 motion-safe:animate-[fadeIn_0.2s_ease-out]">
            <p className="flex items-start gap-2 text-sm font-semibold text-emerald-900">
              <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{confirmedLabel(phase.kind)}</span>
            </p>
          </div>
        )}
        {phase.phase === 'error' && (
          <div className="rounded-xl bg-rose-50 px-3 py-2.5 ring-1 ring-rose-200">
            <p className="flex items-start gap-2 text-sm font-semibold text-rose-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                {phase.kind === 'approve'
                  ? 'Could not approve this lesson plan. The plan was not changed.'
                  : phase.kind === 'reject'
                    ? 'Could not reject this lesson plan. The plan was not changed.'
                    : 'Could not send this lesson plan back. The plan was not changed.'}
              </span>
            </p>
            {phase.message && (
              <p className="mt-1 break-words pl-6 text-xs text-rose-700">{phase.message}</p>
            )}
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 ml-6 inline-flex min-h-[44px] items-center rounded-lg bg-rose-600 px-3 text-xs font-bold text-white transition-colors duration-150 hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {done ? (
        // Success state: a single forward affordance, autofocused so keyboard
        // users continue without hunting for it.
        <div className="mt-3">
          {onNext ? (
            <button
              ref={nextRef}
              type="button"
              autoFocus
              onClick={onNext}
              className={cn(ACTION_BASE, 'bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:outline-indigo-700')}
            >
              Next lesson plan <ArrowRight className="h-4 w-4" aria-hidden="true" />
              {remaining > 0 && <span className="font-normal opacity-80">({remaining} left)</span>}
            </button>
          ) : (
            <p className="rounded-xl bg-white px-3 py-3 text-center text-sm font-medium text-slate-600 ring-1 ring-slate-200">
              ✓ All caught up — no other plans are waiting.
            </p>
          )}
        </div>
      ) : (
        <>
          <label htmlFor="decision-comment" className="review-decision-text mt-3 block text-xs font-semibold">
            Note for the teacher <span className="review-decision-muted font-normal">(optional)</span>
          </label>
          {/* rows=2 keeps the buttons above the fold on a laptop; the field is
              resize-y for the rare long note. */}
          <textarea
            id="decision-comment"
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder={commentPlaceholder}
            rows={2}
            disabled={busy}
            className="mt-1 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
          />

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {/* Approve is primary: solid fill, full width, first in DOM and
                reading order. Send back / Reject are quiet outlines sharing the
                row below — same weight as each other, clearly subordinate. */}
            <button
              type="button"
              onClick={() => onDecide('approve')}
              disabled={actionsDisabled}
              className={cn(ACTION_BASE, 'bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-emerald-800 sm:col-span-2')}
            >
              {busy && phase.kind === 'approve'
                ? <><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> {submittingLabel('approve')}</>
                : <><Check className="h-4 w-4" aria-hidden="true" /> {labels.approve}</>}
            </button>

            <button
              type="button"
              onClick={() => onDecide('revision')}
              disabled={actionsDisabled || alreadyRevision}
              className={cn(ACTION_BASE, 'review-decision-secondary border font-semibold focus-visible:outline-amber-600')}
            >
              {busy && phase.kind === 'revision'
                ? <><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> {submittingLabel('revision')}</>
                : <><Unlock className="h-4 w-4" aria-hidden="true" /> {alreadyRevision ? 'Already sent back' : labels.requestRevisions}</>}
            </button>

            <button
              type="button"
              onClick={() => setConfirmReject(true)}
              disabled={actionsDisabled}
              className={cn(ACTION_BASE, 'review-decision-secondary border focus-visible:outline-slate-400')}
            >
              {busy && phase.kind === 'reject'
                ? <><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> {submittingLabel('reject')}</>
                : labels.reject}
            </button>
          </div>

          <p className="review-decision-muted mt-2 text-xs">
            Sending back unlocks the plan so the teacher can edit and resubmit.
          </p>
        </>
      )}

      <Dialog
        open={confirmReject}
        onClose={() => setConfirmReject(false)}
        title="Reject lesson plan?"
        description="This will mark the lesson plan as rejected."
        className="max-w-md"
        hideCloseButton
      >
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setConfirmReject(false)}
            className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleReject}
            className="min-h-[44px] rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-rose-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-800"
          >
            Reject plan
          </button>
        </div>
      </Dialog>
    </section>
  );
}
