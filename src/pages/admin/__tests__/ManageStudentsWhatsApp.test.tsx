// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageStudents } from '../ManageStudents';
import { Student, User } from '../../../types';

const mockStudents: Student[] = [
  // Prompt example: Barwaaqo Maxamed Heeban, Grade 2-C, parent ikraan cabdi khaliif
  {
    id: 'stu-barwaaqo',
    name: 'Barwaaqo Maxamed Heeban',
    className: 'Grade 2-C',
    parentId: 'parent-1',
    createdAt: '2026-06-01',
    parentPhone: '252634506719',
  },
  // Sibling with same parent: Sara Abdullahi
  {
    id: 'stu-sara',
    name: 'Sara Abdullahi',
    className: 'Grade 1-A',
    parentId: 'parent-1',
    createdAt: '2026-06-01',
    parentPhone: '252634506719',
  },
  // Student with different parent: Ahmed Ali Yusuf
  {
    id: 'stu-ahmed',
    name: 'Ahmed Ali Yusuf',
    className: 'Grade 2-C',
    parentId: 'parent-2',
    createdAt: '2026-06-01',
    parentPhone: '252634511111',
  },
  // Student whose parent email is missing: Hassan Jaamac
  {
    id: 'stu-hassan',
    name: 'Hassan Jaamac',
    className: 'Grade 2-C',
    parentId: 'parent-no-email',
    createdAt: '2026-06-01',
    parentPhone: '252634599999',
  },
  // Student unassigned
  {
    id: 'stu-aisha',
    name: 'Aisha Hassan',
    className: 'Grade 2-C',
    parentId: null,
    createdAt: '2026-06-01',
  },
];

const mockParents: Record<string, User> = {
  'parent-1': {
    id: 'parent-1',
    name: 'ikraan cabdi khaliif',
    email: 'parent1@example.com',
    role: 'parent',
    phone1: '252634506719',
    createdAt: '2026-06-01',
  },
  'parent-2': {
    id: 'parent-2',
    name: 'Ali Yusuf',
    email: 'ali.yusuf@example.com',
    role: 'parent',
    phone1: '252634511111',
    createdAt: '2026-06-01',
  },
  'parent-no-email': {
    id: 'parent-no-email',
    name: 'Sahra Jaamac',
    email: '',
    role: 'parent',
    phone1: '252634599999',
    createdAt: '2026-06-01',
  },
};

const getStudentsPaginatedMock = vi.fn().mockImplementation(async () => ({
  students: mockStudents,
  total: mockStudents.length,
}));
const getStudentsByClassesMock = vi.fn().mockImplementation(async () => mockStudents);
const getUserByIdMock = vi.fn().mockImplementation(async (id: string) => mockParents[id] || null);

vi.mock('../../../lib/db/students', () => ({
  getStudentsPaginated: (...a: unknown[]) => getStudentsPaginatedMock(...a),
  getStudentsByClasses: (...a: unknown[]) => getStudentsByClassesMock(...a),
  getStudentById: vi.fn(),
  createStudent: vi.fn(),
  updateStudent: vi.fn(),
  deleteStudent: vi.fn(),
}));

vi.mock('../../../lib/db/profiles', () => ({
  getUserById: (id: string) => getUserByIdMock(id),
  searchParents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../lib/db/exams', () => ({
  getExamsByStudent: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../lib/db/academic', () => ({
  getCurrentTerm: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../lib/db/reports', () => ({
  getReportCommentsForStudentTerm: vi.fn().mockResolvedValue([]),
}));

const addToastMock = vi.fn();
vi.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

describe('ManageStudents - Send WhatsApp', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  async function renderPage() {
    let root: any;
    await act(async () => {
      root = createRoot(container);
      root.render(<ManageStudents />);
    });
    // Wait for students to load
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    return root;
  }

  it('renders View Parent & WhatsApp button, and upon viewing, clicking Send WhatsApp opens WhatsApp with parent email', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Find the row for Barwaaqo Maxamed Heeban
    const barwaaqoText = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Barwaaqo Maxamed Heeban'
    );
    expect(barwaaqoText).toBeDefined();

    const row = barwaaqoText!.closest('tr')!;

    // Click "View Parent & WhatsApp"
    const viewButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('View Parent & WhatsApp')
    );
    expect(viewButton).toBeDefined();

    await act(async () => {
      viewButton!.click();
    });

    // Wait for parent to load
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Now parent name and email should be visible, along with "Send WhatsApp"
    expect(row.textContent).toContain('ikraan cabdi khaliif');
    expect(row.textContent).toContain('252634506719');
    expect(row.textContent).toContain('parent1@example.com');

    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    expect(sendButton).toBeDefined();

    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;

    // Verify WhatsApp link format
    expect(openedUrl).toContain('https://wa.me/252634506719?text=');
    const urlObj = new URL(openedUrl);
    const text = urlObj.searchParams.get('text')!;

    // Verify username and password are parent email, NOT student name or parent name
    expect(text).toContain('username: parent1@example.com');
    expect(text).toContain('password: parent1@example.com');
    expect(text).not.toContain('username: Barwaaqo');
    expect(text).not.toContain('username: ikraan');
    expect(text).toBe(
      'Walidka sharafta leh, app cusub oo walidka ka arki karo ardadu website-ka waa: https://schoolnnnnass.vercel.app waxaad ku gasho username: parent1@example.com iyo password: parent1@example.com.'
    );

    openSpy.mockRestore();
  });

  it('handles multiple students belonging to the same parent', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Sibling: Sara Abdullahi
    const saraText = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Sara Abdullahi'
    );
    expect(saraText).toBeDefined();
    const row = saraText!.closest('tr')!;

    // View parent
    const viewButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('View Parent & WhatsApp')
    );
    await act(async () => {
      viewButton!.click();
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;
    const text = new URL(openedUrl).searchParams.get('text')!;

    // Should use the same parent email
    expect(text).toContain('username: parent1@example.com iyo password: parent1@example.com');
    expect(openedUrl).toContain('https://wa.me/252634506719');

    openSpy.mockRestore();
  });

  it('handles a student with a different parent email', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Ahmed Ali Yusuf
    const ahmedText = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Ahmed Ali Yusuf'
    );
    expect(ahmedText).toBeDefined();
    const row = ahmedText!.closest('tr')!;

    // View parent
    const viewButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('View Parent & WhatsApp')
    );
    await act(async () => {
      viewButton!.click();
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;
    const text = new URL(openedUrl).searchParams.get('text')!;

    expect(text).toContain('username: ali.yusuf@example.com iyo password: ali.yusuf@example.com');
    expect(openedUrl).toContain('https://wa.me/252634511111');

    openSpy.mockRestore();
  });

  it('shows error toast "Parent email not found" when parent email is missing and does not open WhatsApp', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Hassan Jaamac (parent has empty email)
    const hassanText = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Hassan Jaamac'
    );
    expect(hassanText).toBeDefined();
    const row = hassanText!.closest('tr')!;

    // View parent
    const viewButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('View Parent & WhatsApp')
    );
    await act(async () => {
      viewButton!.click();
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).not.toHaveBeenCalled();
    expect(addToastMock).toHaveBeenCalledWith({
      type: 'error',
      title: 'Parent email not found',
    });

    openSpy.mockRestore();
  });
});
