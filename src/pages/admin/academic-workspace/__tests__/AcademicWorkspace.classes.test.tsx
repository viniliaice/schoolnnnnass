// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASSES } from '../../../../types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  createClassSubject: vi.fn(),
  updateClassSubject: vi.fn(),
  deleteClassSubject: vi.fn(),
  refresh: vi.fn(),
  setMappings: vi.fn(),
  workspace: {
    loading: false,
    refreshing: false,
    subjects: [{
      id: 'math',
      name: 'Mathematics',
      shortName: 'MATH',
      weeklyLessons: 5,
      createdAt: '2026-09-01',
    }],
    years: [],
    terms: [],
    mappings: [] as Array<Record<string, unknown>>,
    teachers: [{
      id: 'teacher-12',
      name: 'Grade 12 Teacher',
      email: 'teacher12@school.edu',
      role: 'teacher',
      assignedClasses: ['Grade 12-A'],
      assignedSubjects: ['math'],
      createdAt: '2026-09-01',
    }],
    currentTerm: null,
    partialErrors: [],
  },
}));

vi.mock('../../../../context/ToastContext', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

vi.mock('../hooks/useAcademicWorkspaceData', () => ({
  useAcademicWorkspaceData: () => ({
    ...mocks.workspace,
    refresh: mocks.refresh,
    setMappings: mocks.setMappings,
  }),
}));

vi.mock('../../../../lib/db/classes', () => ({
  createClassSubject: (...args: unknown[]) => mocks.createClassSubject(...args),
  updateClassSubject: (...args: unknown[]) => mocks.updateClassSubject(...args),
  deleteClassSubject: (...args: unknown[]) => mocks.deleteClassSubject(...args),
}));

vi.mock('../../../../lib/db/academic', () => ({
  createAcademicYear: vi.fn(),
  createTerm: vi.fn(),
  deleteAcademicYear: vi.fn(),
  deleteTerm: vi.fn(),
  updateAcademicYear: vi.fn(),
  updateTerm: vi.fn(),
}));

vi.mock('../../../../lib/db/subjects', () => ({
  createSubject: vi.fn(),
  deleteSubject: vi.fn(),
  updateSubject: vi.fn(),
}));

vi.mock('../../../../lib/db/audit', () => ({ createAuditLog: vi.fn() }));
vi.mock('../../../../lib/db/bulk', () => ({ bulkCreateTeachersWithAssignments: vi.fn() }));
vi.mock('../../../../lib/db/profiles', () => ({ updateUser: vi.fn() }));
vi.mock('../components/CurriculumPdf', () => ({ CurriculumPdfDocument: () => null }));

import { AcademicWorkspace } from '../AcademicWorkspace';

async function mountWorkspace(): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AcademicWorkspace />);
  });
  return { host, root };
}

function buttonWithExactText(host: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function setNativeSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.addToast.mockClear();
  mocks.createClassSubject.mockReset();
  mocks.updateClassSubject.mockReset();
  mocks.deleteClassSubject.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.setMappings.mockClear();
  mocks.workspace.mappings = [];
  mocks.createClassSubject.mockResolvedValue({
    id: 'new-mapping',
    className: 'Grade 12-A',
    subjectId: 'math',
  });
  mocks.updateClassSubject.mockResolvedValue({
    id: 'grade-12-math',
    className: 'Grade 12-A',
    subjectId: 'math',
    teacherId: 'teacher-12',
  });
});

describe('Academic Workspace class selector', () => {
  it('shows all 35 active classes in Cards and Matrix views', async () => {
    const { host, root } = await mountWorkspace();
    const workspaceMain = Array.from(host.querySelectorAll('main')).find(main =>
      main.textContent?.includes('Classes & Assignments'),
    );
    expect(workspaceMain).toBeDefined();

    const cardClassButtons = Array.from(workspaceMain!.querySelectorAll('button'))
      .map(button => button.textContent?.trim())
      .filter(label => label && CLASSES.includes(label));
    expect(cardClassButtons).toEqual(CLASSES);
    // Required result: every Foundation section (A, B and C) must be visible
    // in the Classes & Assignments selector even with no students/mappings.
    expect(cardClassButtons).toEqual(
      expect.arrayContaining(['Foundation A', 'Foundation B', 'Foundation C']),
    );

    await act(async () => {
      buttonWithExactText(workspaceMain!, 'Classes').click();
    });
    const selectorClasses = Array.from(workspaceMain!.querySelectorAll('input[type="checkbox"]'))
      .map(input => input.closest('label')?.textContent?.trim());
    expect(selectorClasses).toEqual(CLASSES);
    expect(selectorClasses).toEqual(
      expect.arrayContaining(['Foundation A', 'Foundation B', 'Foundation C']),
    );

    await act(async () => {
      buttonWithExactText(workspaceMain!, 'Matrix').click();
    });
    const matrixHeaders = Array.from(workspaceMain!.querySelectorAll('thead th'))
      .slice(1)
      .map(header => header.textContent?.trim());
    expect(matrixHeaders).toEqual(CLASSES);
    expect(matrixHeaders).toEqual(
      expect.arrayContaining(['Foundation A', 'Foundation B', 'Foundation C']),
    );

    await act(async () => root.unmount());
  });

  it('can add a subject inline to a class with no students or mappings', async () => {
    const { host, root } = await mountWorkspace();

    await act(async () => {
      buttonWithExactText(host, 'Grade 12-A').click();
    });
    expect(host.textContent).toContain('No subjects assigned to Grade 12-A.');

    const addMath = Array.from(host.querySelectorAll('button')).find(button => {
      const label = button.textContent?.replace(/\s+/g, ' ').trim() || '';
      return label.includes('+ Add') && label.includes('MATH');
    });
    expect(addMath).toBeDefined();
    await act(async () => {
      addMath!.click();
    });

    expect(mocks.createClassSubject).toHaveBeenCalledWith({
      className: 'Grade 12-A',
      subjectId: 'math',
      teacherId: undefined,
    });

    await act(async () => root.unmount());
  });

  it('can assign a teacher inline for the selected class', async () => {
    mocks.workspace.mappings = [{
      id: 'grade-12-math',
      className: 'Grade 12-A',
      subjectId: 'math',
    }];
    const { host, root } = await mountWorkspace();

    await act(async () => {
      buttonWithExactText(host, 'Grade 12-A').click();
    });
    const assignmentCard = Array.from(host.querySelectorAll('article')).find(article =>
      article.textContent?.includes('Mathematics'),
    );
    const teacherSelect = assignmentCard?.querySelector('select');
    expect(teacherSelect).not.toBeNull();

    await act(async () => {
      setNativeSelectValue(teacherSelect!, 'teacher-12');
      teacherSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.updateClassSubject).toHaveBeenCalledWith('grade-12-math', {
      teacherId: 'teacher-12',
    });

    await act(async () => root.unmount());
  });
});
