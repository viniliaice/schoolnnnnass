// WorkflowHelp — reusable visual "?" help system for multi-step workflows.
//
// Renders a small, clearly visible "?" button next to a workflow header. Clicking
// it opens an overlay dialog (bottom sheet on phones, centered modal on larger
// screens) that walks the teacher through the workflow step by step using mock
// renderings of the REAL screens.
//
// The component itself is generic and knows nothing about any workflow:
// everything (title, steps, icons, visuals, warnings, checklists) comes from a
// `WorkflowHelpConfig` defined in `workflows.tsx`, so new workflows can be
// added by writing a config — no component changes required.
//
// Important properties:
//   * Opening/closing the dialog never unmounts, navigates, or resets the page
//     around it — the dialog is a pure overlay, so in-progress upload state is
//     preserved exactly.
//   * When `currentStep` is given, the dialog opens directly on that step with
//     a "You are here" marker, and the teacher can still browse every step.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  LocateFixed,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../utils/cn';

export type WorkflowHelpAccent = 'teal' | 'indigo';

export interface WorkflowHelpStep {
  /** Unique step id — matches the workflow's own step/tab id for context-sensitivity. */
  id: string;
  icon: LucideIcon;
  /** Short title, e.g. "Resolve & Validate". */
  title: string;
  /** 1–2 sentence explanation. */
  summary: string;
  /** Visual mock of the real screen for this step (see visuals.tsx helpers). */
  visual?: ReactNode;
  /** Numbered legend/callouts explaining the highlighted parts of the visual. */
  legend?: ReactNode;
  /** Optional amber warning specific to this step. */
  warning?: string;
}

export interface WorkflowHelpChecklist {
  title: string;
  items: string[];
}

export interface WorkflowHelpConfig {
  /** Stable identifier, e.g. "bulk-grade-upload". */
  id: string;
  /** Workflow title as shown in the app, e.g. "Bulk Upload Grades". */
  title: string;
  /** One-line description of the whole workflow. */
  tagline: string;
  /** Accent color — matches the workflow's own accent (teal / indigo). */
  accent: WorkflowHelpAccent;
  steps: WorkflowHelpStep[];
  /** ✅ Correct checklist. */
  good: WorkflowHelpChecklist;
  /** ❌ Common mistakes checklist. */
  mistakes: WorkflowHelpChecklist;
  /** Optional closing note shown above the footer. */
  finalNote?: string;
}

interface AccentStyle {
  button: string;
  iconBox: string;
  activeStep: string;
  stepNumber: string;
  primary: string;
  youAreHere: string;
}

const ACCENTS: Record<WorkflowHelpAccent, AccentStyle> = {
  teal: {
    button: 'border-teal-400 bg-teal-50 text-teal-700 hover:border-teal-600 hover:bg-teal-100',
    iconBox: 'bg-teal-100 text-teal-700',
    activeStep: 'border-teal-300 bg-teal-50 text-teal-800',
    stepNumber: 'bg-teal-600 text-white',
    primary: 'bg-teal-600 text-white hover:bg-teal-700',
    youAreHere: 'border-teal-300 bg-teal-50 text-teal-800',
  },
  indigo: {
    button: 'border-indigo-400 bg-indigo-50 text-indigo-700 hover:border-indigo-600 hover:bg-indigo-100',
    iconBox: 'bg-indigo-100 text-indigo-700',
    activeStep: 'border-indigo-300 bg-indigo-50 text-indigo-800',
    stepNumber: 'bg-indigo-600 text-white',
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    youAreHere: 'border-indigo-300 bg-indigo-50 text-indigo-800',
  },
};

interface WorkflowHelpProps {
  config: WorkflowHelpConfig;
  /**
   * The step/tab the user is currently on in the workflow. When set, the dialog
   * opens directly on that step with a "You are here" marker.
   */
  currentStep?: string;
  className?: string;
}

/**
 * The "?" button + dialog pair for one workflow. Drop it next to the workflow's
 * header/title:
 *
 *   <WorkflowHelp config={bulkGradeUploadHelp} currentStep={step} />
 */
export function WorkflowHelp({ config, currentStep, className }: WorkflowHelpProps) {
  const [open, setOpen] = useState(false);
  const accent = ACCENTS[config.accent];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Help: ${config.title}`}
        title="How this works"
        className={cn(
          'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-lg font-bold leading-none shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          accent.button,
          className,
        )}
      >
        <span aria-hidden>?</span>
      </button>
      {open && <WorkflowHelpDialog config={config} initialStepId={currentStep} onClose={() => setOpen(false)} />}
    </>
  );
}

interface WorkflowHelpDialogProps {
  config: WorkflowHelpConfig;
  initialStepId?: string;
  onClose: () => void;
}

function WorkflowHelpDialog({ config, initialStepId, onClose }: WorkflowHelpDialogProps) {
  const accent = ACCENTS[config.accent];
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const initialIndex = Math.max(
    0,
    config.steps.findIndex(step => step.id === initialStepId),
  );
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const activeStep = config.steps[activeIndex] ?? config.steps[0];
  const total = config.steps.length;
  const isYouAreHere = activeStep.id === config.steps[initialIndex]?.id && Boolean(initialStepId);

  // Close on Escape + lock body scroll while open (matches the app's Dialog).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const selectStep = (index: number) => {
    setActiveIndex(index);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${config.title} — how it works`}
        tabIndex={-1}
        className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:max-h-[88vh] sm:max-w-4xl sm:rounded-3xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', accent.iconBox)}>
              <HelpCircle className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight text-slate-900">
                {config.title} — How it works
              </h2>
              <p className="mt-0.5 text-xs leading-snug text-slate-500 sm:text-sm">{config.tagline}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Step rail (desktop) */}
          <nav
            aria-label={`${config.title} steps`}
            className="hidden w-60 shrink-0 overflow-y-auto border-r border-slate-100 bg-slate-50/70 p-3 sm:block"
          >
            <ol className="space-y-1">
              {config.steps.map((step, index) => (
                <li key={step.id}>
                  <button
                    type="button"
                    data-help-nav-step={step.id}
                    onClick={() => selectStep(index)}
                    aria-current={activeIndex === index ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-sm transition-colors',
                      activeIndex === index
                        ? cn('border-transparent font-semibold', accent.activeStep)
                        : 'border-transparent text-slate-600 hover:bg-white hover:shadow-sm',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                        activeIndex === index ? accent.stepNumber : 'bg-slate-200 text-slate-500',
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <step.icon className="h-4 w-4 shrink-0 opacity-70" />
                      <span className="truncate">{step.title}</span>
                    </span>
                    {step.id === initialStepId && (
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                          accent.youAreHere,
                        )}
                      >
                        Here
                      </span>
                    )}
                  </button>
                  {index < total - 1 && (
                    <div aria-hidden className="flex justify-center py-0.5 text-slate-300">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </nav>

          {/* Step chips (mobile) */}
          <div className="border-b border-slate-100 bg-slate-50/70 px-3 py-2.5 sm:hidden">
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {config.steps.map((step, index) => (
                <Fragment key={step.id}>
                  {index > 0 && <ChevronRight aria-hidden className="h-3 w-3 shrink-0 text-slate-300" />}
                  <button
                    type="button"
                    data-help-nav-step={step.id}
                    aria-label={`Step ${index + 1}: ${step.title}`}
                    aria-current={activeIndex === index ? 'step' : undefined}
                    onClick={() => selectStep(index)}
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors',
                      activeIndex === index
                        ? cn('border-transparent', accent.stepNumber)
                        : 'border-slate-200 bg-white text-slate-500',
                    )}
                  >
                    {index + 1}
                  </button>
                </Fragment>
              ))}
            </div>
          </div>

          {/* Content */}
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="space-y-4 px-4 pb-5 pt-4 sm:px-6 sm:pb-6">
              {isYouAreHere && (
                <div
                  className={cn('flex items-start gap-2 rounded-xl border p-3 text-sm', accent.youAreHere)}
                  data-testid="help-you-are-here"
                >
                  <LocateFixed aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <strong>You are here:</strong> this guide opened on step {activeIndex + 1} because that is
                    where you are in the workflow right now.
                  </span>
                </div>
              )}

              <div className="flex items-start gap-3">
                <div
                  aria-hidden
                  className={cn(
                    'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold',
                    accent.stepNumber,
                  )}
                >
                  {activeIndex + 1}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                    Step {activeIndex + 1} of {total} · {config.title}
                  </p>
                  <h3
                    data-testid="help-step-title"
                    className="flex items-center gap-2 text-lg font-bold text-slate-900"
                  >
                    <activeStep.icon aria-hidden className="h-5 w-5 shrink-0 text-slate-400" />
                    {activeStep.title}
                  </h3>
                </div>
              </div>

              <p className="text-sm leading-relaxed text-slate-600">{activeStep.summary}</p>

              {activeStep.warning && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">
                  <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <span>{activeStep.warning}</span>
                </div>
              )}

              {activeStep.visual && (
                <figure>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
                    {activeStep.visual}
                  </div>
                  {activeStep.legend && <figcaption>{activeStep.legend}</figcaption>}
                </figure>
              )}

              {/* Prev / Next — guided browsing through every step */}
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => selectStep(Math.max(0, activeIndex - 1))}
                  disabled={activeIndex === 0}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowLeft className="h-4 w-4" /> Previous
                </button>
                <span aria-hidden className="text-xs text-slate-400">
                  Step {activeIndex + 1} of {total}
                </span>
                <button
                  type="button"
                  onClick={() => selectStep(Math.min(total - 1, activeIndex + 1))}
                  disabled={activeIndex === total - 1}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next <ArrowRight className="h-4 w-4" />
                </button>
              </div>

              {/* ✅ / ❌ checklists */}
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold text-emerald-900">
                    <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-emerald-600" />
                    {config.good.title}
                  </h4>
                  <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-emerald-900">
                    {config.good.items.map(item => (
                      <li key={item} className="flex items-start gap-2">
                        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                  <h4 className="flex items-center gap-2 text-sm font-bold text-red-900">
                    <XCircle aria-hidden className="h-4 w-4 shrink-0 text-red-600" />
                    {config.mistakes.title}
                  </h4>
                  <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-red-900">
                    {config.mistakes.items.map(item => (
                      <li key={item} className="flex items-start gap-2">
                        <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {config.finalNote && (
                <p className="text-center text-xs leading-relaxed text-slate-500">{config.finalNote}</p>
              )}
            </div>
          </div>
        </div>

        {/* Footer — always visible "Got it" */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-white px-4 py-3 sm:px-6">
          <span className="hidden text-xs text-slate-400 sm:inline">
            Opening help never changes or resets your work.
          </span>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors sm:w-auto',
              accent.primary,
            )}
          >
            Got it <CheckCircle2 aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
