// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TeacherStudents } from '../TeacherStudents';
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
  // Sibling with same parent: Sara Abdullahi in Grade 2-C
  {
    id: 'stu-sara',
    name: 'Sara Abdullahi',
    className: 'Grade 2-C',
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

const teacherUser: User = {
  id: 'teacher-1',
  name: 'Ms. Fatima',
  email: 'fatima@mbk.edu',
  role: 'teacher',
  assignedClasses: ['Grade 2-C'],
  createdAt: '2026-06-01',
};

const getStudentsByClassesMock = vi.fn().mockImplementation(async () => mockStudents);
const getUsersByIdsMock = vi.fn().mockImplementation(async (ids: string[]) =>
  ids.map(id => mockParents[id]).filter(Boolean)
);
const getUserByIdMock = vi.fn().mockImplementation(async (id: string) => {
  if (id === 'teacher-1') return teacherUser;
  return mockParents[id] || null;
});

vi.mock('../../../lib/db/students', () => ({
  getStudentsByClasses: (...a: unknown[]) => getStudentsByClassesMock(...a),
}));

vi.mock('../../../lib/db/profiles', () => ({
  getUserById: (id: string) => getUserByIdMock(id),
  getUsersByIds: (ids: string[]) => getUsersByIdsMock(ids),
}));

const mockSession = {
  userId: 'teacher-1',
  role: 'teacher' as const,
  userName: 'Ms. Fatima',
};
vi.mock('../../../context/RoleContext', () => ({
  useRole: () => ({ session: mockSession }),
}));

const addToastMock = vi.fn();
vi.mock('../../../context/ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

describe('TeacherStudents (My Classes) - Send WhatsApp', () => {
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
      root.render(<TeacherStudents />);
    });
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    return root;
  }

  it('renders My Classes with students and clicking Send WhatsApp opens WhatsApp with parent email', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Verify title
    expect(container.querySelector('h1')?.textContent).toBe('My Classes');

    // Find row for Barwaaqo Maxamed Heeban
    const barwaaqoSpan = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Barwaaqo Maxamed Heeban'
    );
    expect(barwaaqoSpan).toBeDefined();

    const row = barwaaqoSpan!.closest('tr')!;
    expect(row.textContent).toContain('ikraan cabdi khaliif');
    expect(row.textContent).toContain('252634506719');

    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    expect(sendButton).toBeDefined();

    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;

    // Verify standard WhatsApp format
    expect(openedUrl).toContain('https://wa.me/252634506719?text=');
    const urlObj = new URL(openedUrl);
    const text = urlObj.searchParams.get('text')!;

    // Verify exact required message
    expect(text).toBe(
      'Walidka sharafta leh, app cusub oo walidka ka arki karo ardadu website-ka waa: https://schoolnnnnass.vercel.app waxaad ku gasho username: parent1@example.com iyo password: parent1@example.com.'
    );
    expect(text).toContain('username: parent1@example.com');
    expect(text).toContain('password: parent1@example.com');

    openSpy.mockRestore();
  });

  it('handles multiple students belonging to the same parent in My Classes', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Sara Abdullahi (same parent as Barwaaqo)
    const saraSpan = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Sara Abdullahi'
    );
    expect(saraSpan).toBeDefined();

    const row = saraSpan!.closest('tr')!;
    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    expect(sendButton).toBeDefined();

    await act(async () => {
      sendButton!.click();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const openedUrl = openSpy.mock.calls[0][0] as string;
    const text = new URL(openedUrl).searchParams.get('text')!;

    expect(text).toContain('username: parent1@example.com iyo password: parent1@example.com');
    expect(openedUrl).toContain('https://wa.me/252634506719');

    openSpy.mockRestore();
  });

  it('handles a student with a different parent email in My Classes', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Ahmed Ali Yusuf (parent: Ali Yusuf, ali.yusuf@example.com)
    const ahmedSpan = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Ahmed Ali Yusuf'
    );
    expect(ahmedSpan).toBeDefined();

    const row = ahmedSpan!.closest('tr')!;
    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    expect(sendButton).toBeDefined();

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

  it('shows error toast "Parent email not found" when parent email is missing in My Classes', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPage();

    // Hassan Jaamac (parent: Sahra Jaamac, empty email)
    const hassanSpan = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Hassan Jaamac'
    );
    expect(hassanSpan).toBeDefined();

    const row = hassanSpan!.closest('tr')!;
    const sendButton = Array.from(row.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Send WhatsApp')
    );
    expect(sendButton).toBeDefined();

    await act(async () => {
      sendButton!.click();
    });

    // WhatsApp must NOT open
    expect(openSpy).not.toHaveBeenCalled();
    // Toast must show "Parent email not found"
    expect(addToastMock).toHaveBeenCalledWith({
      type: 'error',
      title: 'Parent email not found',
    });

    openSpy.mockRestore();
  });

  it('shows Unassigned for students without a parent', async () => {
    await renderPage();

    // Aisha Hassan (parentId: null)
    const aishaSpan = Array.from(container.querySelectorAll('span')).find(
      s => s.textContent === 'Aisha Hassan'
    );
    expect(aishaSpan).toBeDefined();

    const row = aishaSpan!.closest('tr')!;
    expect(row.textContent).toContain('Unassigned');
    // Unassigned does not have a Send WhatsApp button
    expect(row.querySelector('button')).toBeNull();
  });
});
