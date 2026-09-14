// @vitest-environment jsdom
//
// Tests for the reusable WorkflowHelp "?" help system:
//   * a visible, accessible "?" button renders for each workflow
//   * the button opens the correct workflow-specific guide
//   * the guide opens on the current step ("You are here") and lets the teacher
//     browse every step
//   * closing the help (Got it / X / backdrop) never resets surrounding state
//   * the guide content matches the real workflows (real buttons/labels/messages)
//   * configs are structurally valid and unique

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { WorkflowHelp } from '../../components/workflow-help/WorkflowHelp';
import {
  bulkGradeUploadHelp,
  lessonPlanHelp,
  unitPlanHelp,
  WORKFLOW_HELP_CONFIGS,
} from '../../components/workflow-help/workflows';
import type { WorkflowHelpConfig } from '../../components/workflow-help/WorkflowHelp';

const allConfigs: WorkflowHelpConfig[] = [bulkGradeUploadHelp, lessonPlanHelp, unitPlanHelp];

let mounted: ReturnType<typeof createRoot>[] = [];
let containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const root of mounted) {
    act(() => root.unmount());
  }
  mounted = [];
  for (const container of containers) {
    container.remove();
  }
  containers = [];
  document.body.style.overflow = '';
});

/** Renders a tree into a fresh container and returns it for querying. */
function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  mounted.push(root);
  act(() => root.render(element));
  return container;
}

function helpButton(container: HTMLElement, title: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="Help: ${title}"]`);
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function openHelp(container: HTMLElement, title: string): void {
  act(() => helpButton(container, title).click());
}

function dialogIn(container: HTMLElement): HTMLElement {
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog).toBeTruthy();
  return dialog as HTMLElement;
}

describe('WorkflowHelp button', () => {
  it('renders a visible, accessible "?" button for each workflow', () => {
    for (const config of allConfigs) {
      const container = render(<WorkflowHelp config={config} />);
      const button = helpButton(container, config.title);
      expect(button.textContent).toContain('?');
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });
});

describe('WorkflowHelp dialog', () => {
  it('opens the correct workflow-specific guide and closes again', () => {
    const container = render(<WorkflowHelp config={bulkGradeUploadHelp} />);
    openHelp(container, bulkGradeUploadHelp.title);

    const dialog = dialogIn(container);
    expect(dialog.textContent).toContain('Bulk Upload Grades — How it works');
    expect(dialog.textContent).toContain('Class & Subjects');

    // Close with the footer "Got it" button.
    const gotIt = Array.from(dialog.querySelectorAll('button')).find(button =>
      button.textContent?.includes('Got it'),
    );
    expect(gotIt).toBeTruthy();
    act(() => gotIt!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes from the X button and from the backdrop', () => {
    const container = render(<WorkflowHelp config={unitPlanHelp} />);
    openHelp(container, unitPlanHelp.title);
    let dialog = dialogIn(container);
    act(() => {
      (dialog.querySelector('button[aria-label="Close help"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    openHelp(container, unitPlanHelp.title);
    dialog = dialogIn(container);
    act(() => {
      (dialog.parentElement!.firstElementChild as HTMLElement).click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens directly on the current step with a "You are here" marker and allows browsing all steps', () => {
    const container = render(<WorkflowHelp config={bulkGradeUploadHelp} currentStep="resolve" />);
    openHelp(container, bulkGradeUploadHelp.title);

    let dialog = dialogIn(container);
    expect(dialog.textContent).toContain('You are here');
    expect(dialog.querySelector('[data-testid="help-step-title"]')!.textContent).toContain(
      'Resolve & Validate',
    );

    // Browse to another step via the step rail.
    act(() => {
      (dialog.querySelector('[data-help-nav-step="class"]') as HTMLButtonElement).click();
    });
    dialog = dialogIn(container);
    expect(dialog.querySelector('[data-testid="help-step-title"]')!.textContent).toContain(
      'Class & Subjects',
    );

    // Walk through every remaining step with the Next button.
    const titles = bulkGradeUploadHelp.steps.map(step => step.title);
    for (const title of titles.slice(1)) {
      act(() => {
        const next = Array.from(dialog.querySelectorAll('button')).find(button =>
          button.textContent?.trim().endsWith('Next'),
        );
        next!.click();
      });
      expect(dialog.querySelector('[data-testid="help-step-title"]')!.textContent).toContain(title);
    }
  });

  it('preserves the surrounding workflow state when opened and closed', () => {
    function Harness() {
      const [value, setValue] = useState('Grade 5-A');
      return (
        <div>
          <label>
            Class
            <input data-testid="class-input" value={value} onChange={e => setValue(e.target.value)} />
          </label>
          <WorkflowHelp config={lessonPlanHelp} currentStep="plan" />
        </div>
      );
    }
    const container = render(<Harness />);

    const input = container.querySelector('[data-testid="class-input"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Grade 6-B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('Grade 6-B');

    openHelp(container, lessonPlanHelp.title);
    const dialog = dialogIn(container);
    expect(dialog.textContent).toContain('Fill the weekly grid');
    act(() => {
      (Array.from(dialog.querySelectorAll('button')).find(button =>
        button.textContent?.includes('Got it'),
      ) as HTMLButtonElement).click();
    });

    // State unchanged and the input still mounted (never unmounted/reset).
    expect(container.querySelector('[data-testid="class-input"]')).toBeTruthy();
    expect((container.querySelector('[data-testid="class-input"]') as HTMLInputElement).value).toBe(
      'Grade 6-B',
    );
  });
});

describe('WorkflowHelp guide content matches the real app', () => {
  it('bulk grade guide references the real wizard labels and rules', () => {
    const html = guideMarkup(bulkGradeUploadHelp);
    for (const expected of [
      'Class & Subjects',
      'Assessment blocks',
      'Download & upload the workbook',
      'Resolve & Validate',
      'Review changes',
      'Confirm & Upload',
      'Download example',
      'Select or drop the grade workbook',
      'Excel only, maximum 5 MB',
      'Use this student',
      'Exclude row',
      'Validate',
      'Approved → Pending',
      'Grades saved: 18 created, 4 updated',
      'Student Name',
      'HW1',
      'CPW1',
      'Attendance',
      'Akhlaaq',
      'one class at a time',
      'maximum 5 MB',
    ]) {
      expect(html).toContain(expected);
    }
  });

  it('lesson plan guide references the real planner labels and rules', () => {
    const html = guideMarkup(lessonPlanHelp);
    for (const expected of [
      'Setup — class, week & periods',
      'Fill the weekly grid',
      'Import from Excel (optional)',
      'Review & Submit',
      'My Lesson Plans',
      'Start Planning',
      'Periods per day',
      'Upload from Excel',
      'Free Period',
      'Export PDF',
      'Submit to Supervisor',
      'This plan is ready to submit',
      'Submitted to supervisor',
      'Revisions requested',
      'Topic',
      'Objective',
      // The Excel-import step mirrors the real importer columns + messages.
      'Weekly Slide Number',
      'Activity 1',
      'Time 1',
      '.xlsx, .xls or .csv',
      'No valid rows found',
      'Check that the file has Date, Period, and Subject columns',
      '8 periods imported from Excel',
      'One row per period',
    ]) {
      expect(html).toContain(expected);
    }
  });

  it('unit plan guide references the real form labels and rules', () => {
    const html = guideMarkup(unitPlanHelp);
    for (const expected of [
      'Open the unit form',
      'Fill in the unit details',
      'Create the unit',
      'Review & manage your units',
      'New Unit Plan',
      'Unit Name',
      'Class',
      'Subject',
      'Term',
      'Start Week',
      'End Week',
      'Learning Objectives',
      'Please fill in all required fields',
      'End week must be after start week',
      'Unit plan created',
      'no file upload needed',
    ]) {
      expect(html).toContain(expected);
    }
  });
});

describe('WorkflowHelp config integrity', () => {
  it('every config has a unique id and complete steps', () => {
    const ids = new Set<string>();
    for (const config of allConfigs) {
      expect(ids.has(config.id)).toBe(false);
      ids.add(config.id);
      expect(config.title.length).toBeGreaterThan(0);
      expect(config.tagline.length).toBeGreaterThan(0);
      expect(config.steps.length).toBeGreaterThanOrEqual(3);
      expect(config.good.items.length).toBeGreaterThanOrEqual(3);
      expect(config.mistakes.items.length).toBeGreaterThanOrEqual(3);
      for (const step of config.steps) {
        expect(step.id.length).toBeGreaterThan(0);
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.summary.length).toBeGreaterThan(0);
        expect(step.icon).toBeTruthy();
      }
      // Step ids are unique within a workflow.
      expect(new Set(config.steps.map(step => step.id)).size).toBe(config.steps.length);
    }
  });

  it('WORKFLOW_HELP_CONFIGS registers all three guides by id', () => {
    expect(Object.keys(WORKFLOW_HELP_CONFIGS).sort()).toEqual(
      ['bulk-grade-upload', 'lesson-plan', 'unit-plan'].sort(),
    );
  });
});

/** Opens the dialog and walks every step, returning all rendered guide text. */
function guideMarkup(config: WorkflowHelpConfig): string {
  const container = render(<WorkflowHelp config={config} currentStep={config.steps[0]?.id} />);
  openHelp(container, config.title);
  let text = dialogIn(container).textContent ?? '';
  for (const step of config.steps.slice(1)) {
    act(() => {
      (container.querySelector(`[data-help-nav-step="${step.id}"]`) as HTMLButtonElement).click();
    });
    text += ' ' + (dialogIn(container).textContent ?? '');
  }
  return text;
}
