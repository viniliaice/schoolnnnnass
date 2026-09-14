// Standalone visual preview of the three WorkflowHelp guides.
//
// Served by the Vite dev server at /help-preview.html — no login required.
// This harness does not modify the app: it only renders the reusable help
// component with the three real configs so the guides can be checked on
// desktop and mobile widths without Supabase credentials.
//
// Each tile simulates the surrounding workflow (a step selector + an
// in-progress input) so you can verify that opening/closing help never
// resets or interrupts the workflow state.

import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './src/index.css';
import { WorkflowHelp } from './src/components/workflow-help/WorkflowHelp';
import {
  bulkGradeUploadHelp,
  lessonPlanHelp,
  unitPlanHelp,
} from './src/components/workflow-help/workflows';
import type { WorkflowHelpConfig } from './src/components/workflow-help/WorkflowHelp';

function WorkflowTile({ config, subtitle }: { config: WorkflowHelpConfig; subtitle: string }) {
  const [step, setStep] = useState(config.steps[0].id);
  const [draft, setDraft] = useState('');

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-900">{config.title}</h1>
        <WorkflowHelp config={config} currentStep={step} />
      </div>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold text-slate-700">
          Simulated current step
          <select
            value={step}
            onChange={e => setStep(e.target.value)}
            className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            {config.steps.map(s => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold text-slate-700">
          In-progress data (kept when help opens)
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="e.g. Grade 5-A · HW1–HW4"
            className="mt-1 block w-64 rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
    </section>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Dev preview only</p>
          <h1 className="mt-1 text-xl font-bold text-slate-900">
            Workflow Help — “?” guides for the three upload workflows
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Press each <strong>?</strong> button to open the step-by-step guide. The guide opens on the
            simulated current step, lets you browse all steps, and never resets the in-progress input.
            Resize to ~320px to check the mobile bottom sheet.
          </p>
        </header>

        <WorkflowTile
          config={bulkGradeUploadHelp}
          subtitle="Bulk Upload Grades — 6-step class-specific wizard (teal accent)."
        />
        <WorkflowTile config={lessonPlanHelp} subtitle="Lesson Plans — 4-tab weekly planner (indigo accent)." />
        <WorkflowTile config={unitPlanHelp} subtitle="Unit Plans — create form + unit list (indigo accent)." />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
