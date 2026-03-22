import { User, Student, Exam, ExamStatus, ExamType, Role } from '../types';

const KEYS = {
  users: 'cc_users',
  students: 'cc_students',
  exams: 'cc_exams',
  seeded: 'cc_seeded',
};

function get<T>(key: string): T[] {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function set<T>(key: string, data: T[]): void {
  localStorage.setItem(key, JSON.stringify(data));
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// ── Users ──
export function getUsers(): User[] {
  return get<User>(KEYS.users);
}

export function getUsersByRole(role: Role): User[] {
  return getUsers().filter(u => u.role === role);
}

export function getUserById(id: string): User | undefined {
  return getUsers().find(u => u.id === id);
}

export function createUser(data: Omit<User, 'id' | 'createdAt'>): User {
  const users = getUsers();
  const user: User = { ...data, id: generateId(), createdAt: new Date().toISOString() };
  users.push(user);
  set(KEYS.users, users);
  return user;
}

export function updateUser(id: string, data: Partial<User>): User | null {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...data };
  set(KEYS.users, users);
  return users[idx];
}

export function deleteUser(id: string): boolean {
  const users = getUsers();
  const filtered = users.filter(u => u.id !== id);
  if (filtered.length === users.length) return false;
  set(KEYS.users, filtered);
  // Also unlink students from deleted parent
  const students = getStudents();
  const updated = students.map(s => s.parentId === id ? { ...s, parentId: null } : s);
  set(KEYS.students, updated);
  return true;
}

// ── Students ──
export function getStudents(): Student[] {
  return get<Student>(KEYS.students);
}

export function getStudentById(id: string): Student | undefined {
  return getStudents().find(s => s.id === id);
}

export function getStudentsByParent(parentId: string): Student[] {
  return getStudents().filter(s => s.parentId === parentId);
}

export function getStudentsByClass(className: string): Student[] {
  return getStudents().filter(s => s.className === className);
}

export function getStudentsByClasses(classNames: string[]): Student[] {
  return getStudents().filter(s => classNames.includes(s.className));
}

export function createStudent(data: Omit<Student, 'id' | 'createdAt'>): Student {
  const students = getStudents();
  const student: Student = { ...data, id: generateId(), createdAt: new Date().toISOString() };
  students.push(student);
  set(KEYS.students, students);
  return student;
}

export function updateStudent(id: string, data: Partial<Student>): Student | null {
  const students = getStudents();
  const idx = students.findIndex(s => s.id === id);
  if (idx === -1) return null;
  students[idx] = { ...students[idx], ...data };
  set(KEYS.students, students);
  return students[idx];
}

export function deleteStudent(id: string): boolean {
  const students = getStudents();
  const filtered = students.filter(s => s.id !== id);
  if (filtered.length === students.length) return false;
  set(KEYS.students, filtered);
  const exams = getExams().filter(e => e.studentId !== id);
  set(KEYS.exams, exams);
  return true;
}

// ── Exams ──
export function getExams(): Exam[] {
  return get<Exam>(KEYS.exams);
}

export function getExamsByStudent(studentId: string): Exam[] {
  return getExams().filter(e => e.studentId === studentId);
}

export function getExamsByParent(parentId: string, statusFilter?: ExamStatus): Exam[] {
  let exams = getExams().filter(e => e.parentId === parentId);
  if (statusFilter) exams = exams.filter(e => e.status === statusFilter);
  return exams;
}

export function getExamsByTeacher(teacherId: string): Exam[] {
  return getExams().filter(e => e.teacherId === teacherId);
}

export function getExamsByStatus(status: ExamStatus): Exam[] {
  return getExams().filter(e => e.status === status);
}

export function createExam(data: Omit<Exam, 'id' | 'createdAt'>): Exam {
  const exams = getExams();
  const exam: Exam = { ...data, id: generateId(), createdAt: new Date().toISOString() };
  exams.push(exam);
  set(KEYS.exams, exams);
  return exam;
}

export function updateExamStatus(id: string, status: ExamStatus): Exam | null {
  const exams = getExams();
  const idx = exams.findIndex(e => e.id === id);
  if (idx === -1) return null;
  exams[idx] = { ...exams[idx], status };
  set(KEYS.exams, exams);
  return exams[idx];
}

export function deleteExam(id: string): boolean {
  const exams = getExams();
  const filtered = exams.filter(e => e.id !== id);
  if (filtered.length === exams.length) return false;
  set(KEYS.exams, filtered);
  return true;
}

// ── Bulk Operations ──
export function bulkCreateUsers(dataList: Omit<User, 'id' | 'createdAt'>[]): User[] {
  const users = getUsers();
  const created: User[] = [];
  for (const data of dataList) {
    const user: User = { ...data, id: generateId(), createdAt: new Date().toISOString() };
    users.push(user);
    created.push(user);
  }
  set(KEYS.users, users);
  return created;
}

export function bulkCreateStudents(dataList: Omit<Student, 'id' | 'createdAt'>[]): Student[] {
  const students = getStudents();
  const created: Student[] = [];
  for (const data of dataList) {
    const student: Student = { ...data, id: generateId(), createdAt: new Date().toISOString() };
    students.push(student);
    created.push(student);
  }
  set(KEYS.students, students);
  return created;
}

export function bulkCreateExams(dataList: Omit<Exam, 'id' | 'createdAt'>[]): Exam[] {
  const exams = getExams();
  const created: Exam[] = [];
  for (const data of dataList) {
    const exam: Exam = { ...data, id: generateId(), createdAt: new Date().toISOString() };
    exams.push(exam);
    created.push(exam);
  }
  set(KEYS.exams, exams);
  return created;
}

// ── Stats ──
export function getSystemStats() {
  const users = getUsers();
  const students = getStudents();
  const exams = getExams();
  return {
    totalTeachers: users.filter(u => u.role === 'teacher').length,
    totalParents: users.filter(u => u.role === 'parent').length,
    totalStudents: students.length,
    totalExams: exams.length,
    pendingExams: exams.filter(e => e.status === 'pending').length,
    approvedExams: exams.filter(e => e.status === 'approved').length,
    rejectedExams: exams.filter(e => e.status === 'rejected').length,
    averageScore: exams.length > 0
      ? Math.round(exams.reduce((sum, e) => sum + (e.score / e.total) * 100, 0) / exams.length)
      : 0,
  };
}

// ── Seeding ──
export function isSeeded(): boolean {
  return localStorage.getItem(KEYS.seeded) === 'true';
}

export function seedDatabase(): void {
  localStorage.removeItem(KEYS.users);
  localStorage.removeItem(KEYS.students);
  localStorage.removeItem(KEYS.exams);

  const now = new Date().toISOString();

  // Users
  const admin: User = {
    id: 'admin-001', name: 'Dr. Sarah Mitchell', email: 'admin@campus.edu',
    role: 'admin', createdAt: now,
  };

  const teacher1: User = {
    id: 'teacher-001', name: 'Prof. James Wilson', email: 'jwilson@campus.edu',
    role: 'teacher', assignedClasses: ['Grade 10-A', 'Grade 9-A', 'Grade 8-B'],
    createdAt: now,
  };

  const teacher2: User = {
    id: 'teacher-002', name: 'Ms. Emily Chen', email: 'echen@campus.edu',
    role: 'teacher', assignedClasses: ['Grade 7-C', 'Grade 10-A'],
    createdAt: now,
  };

  const parent1: User = {
    id: 'parent-001', name: 'Michael Johnson', email: 'mjohnson@email.com',
    role: 'parent', phone1: '0612345678', phone2: '0612345679',
    xafada: 'Hodan', udow: 'Bakaaraha', paymentNumber: 'EVC-0612345678',
    createdAt: now,
  };

  const parent2: User = {
    id: 'parent-002', name: 'Lisa Rodriguez', email: 'lrodriguez@email.com',
    role: 'parent', phone1: '0617654321', phone2: '0617654322',
    xafada: 'Warta Nabadda', udow: 'Km4 Junction', paymentNumber: 'EVC-0617654321',
    createdAt: now,
  };

  const parent3: User = {
    id: 'parent-003', name: 'David Thompson', email: 'dthompson@email.com',
    role: 'parent', phone1: '0615551234', phone2: '0615551235',
    xafada: 'Dharkenley', udow: 'Ex-Control', paymentNumber: 'EVC-0615551234',
    createdAt: now,
  };

  const users = [admin, teacher1, teacher2, parent1, parent2, parent3];

  // Students
  const students: Student[] = [
    { id: 'student-001', name: 'Emma Johnson', className: 'Grade 10-A', parentId: 'parent-001', createdAt: now },
    { id: 'student-002', name: 'Liam Johnson', className: 'Grade 8-B', parentId: 'parent-001', createdAt: now },
    { id: 'student-003', name: 'Sofia Rodriguez', className: 'Grade 10-A', parentId: 'parent-002', createdAt: now },
    { id: 'student-004', name: 'Noah Thompson', className: 'Grade 9-A', parentId: 'parent-003', createdAt: now },
    { id: 'student-005', name: 'Ava Thompson', className: 'Grade 7-C', parentId: 'parent-003', createdAt: now },
  ];

  // Comprehensive exam data for reports
  const subjects = ['Mathematics', 'English', 'Science', 'Somali', 'Islamic Studies'];
  const exams: Exam[] = [];
  let examCounter = 1;

  function addExam(
    studentId: string, subject: string, score: number, total: number,
    examType: ExamType, month: string, status: ExamStatus,
    parentId: string, teacherId: string, dateStr: string
  ) {
    exams.push({
      id: `exam-${String(examCounter++).padStart(3, '0')}`,
      studentId, subject, score, total, examType, month, status,
      parentId, date: dateStr, createdAt: now, teacherId,
    });
  }

  // ─── Student 1: Emma Johnson (Grade 10-A, parent-001) ───
  // January CA work
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [85, 78, 92, 88, 76][i], 100, 'CA', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-15');
    addExam('student-001', sub, [80, 82, 88, 85, 70][i], 100, 'Homework', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-20');
  });
  // February CA work
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [90, 85, 95, 82, 80][i], 100, 'CA', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-10');
    addExam('student-001', sub, [88, 80, 90, 86, 78][i], 100, 'Classwork', 'February', 'approved', 'parent-001', 'teacher-002', '2025-02-18');
    addExam('student-001', sub, [82, 76, 88, 84, 72][i], 100, 'Quiz', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-25');
  });
  // March - Midterm
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [88, 82, 94, 86, 78][i], 100, 'Midterm', 'March', 'approved', 'parent-001', 'teacher-001', '2025-03-15');
  });
  // April CA
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [92, 88, 96, 90, 82][i], 100, 'CA', 'April', 'approved', 'parent-001', 'teacher-001', '2025-04-10');
    addExam('student-001', sub, [86, 84, 90, 88, 80][i], 100, 'Homework', 'April', 'approved', 'parent-001', 'teacher-002', '2025-04-20');
  });
  // May - Final
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [90, 86, 95, 88, 80][i], 100, 'Final', 'May', 'approved', 'parent-001', 'teacher-001', '2025-05-20');
  });

  // ─── Student 2: Liam Johnson (Grade 8-B, parent-001) ───
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [72, 68, 80, 75, 65][i], 100, 'CA', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-15');
    addExam('student-002', sub, [70, 72, 78, 74, 60][i], 100, 'Homework', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-22');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [78, 74, 82, 80, 68][i], 100, 'CA', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-12');
    addExam('student-002', sub, [75, 70, 80, 76, 66][i], 100, 'Quiz', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-26');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [76, 72, 84, 78, 66][i], 100, 'Midterm', 'March', 'approved', 'parent-001', 'teacher-001', '2025-03-15');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [80, 76, 86, 82, 70][i], 100, 'CA', 'April', 'approved', 'parent-001', 'teacher-001', '2025-04-12');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [78, 74, 85, 80, 68][i], 100, 'Final', 'May', 'approved', 'parent-001', 'teacher-001', '2025-05-22');
  });

  // ─── Student 3: Sofia Rodriguez (Grade 10-A, parent-002) ───
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [95, 90, 88, 92, 86][i], 100, 'CA', 'January', 'approved', 'parent-002', 'teacher-001', '2025-01-15');
    addExam('student-003', sub, [92, 88, 85, 90, 84][i], 100, 'Homework', 'January', 'approved', 'parent-002', 'teacher-002', '2025-01-21');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [96, 92, 90, 94, 88][i], 100, 'CA', 'February', 'approved', 'parent-002', 'teacher-001', '2025-02-14');
    addExam('student-003', sub, [90, 86, 88, 92, 82][i], 100, 'Classwork', 'February', 'approved', 'parent-002', 'teacher-002', '2025-02-20');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [94, 90, 92, 96, 88][i], 100, 'Midterm', 'March', 'approved', 'parent-002', 'teacher-001', '2025-03-15');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [98, 94, 92, 96, 90][i], 100, 'CA', 'April', 'approved', 'parent-002', 'teacher-001', '2025-04-10');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [96, 92, 94, 98, 90][i], 100, 'Final', 'May', 'approved', 'parent-002', 'teacher-001', '2025-05-20');
  });

  // ─── Student 4: Noah Thompson (Grade 9-A, parent-003) ───
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [65, 70, 58, 72, 60][i], 100, 'CA', 'January', 'approved', 'parent-003', 'teacher-001', '2025-01-16');
    addExam('student-004', sub, [60, 68, 55, 70, 58][i], 100, 'Homework', 'January', 'approved', 'parent-003', 'teacher-001', '2025-01-23');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [70, 72, 62, 76, 64][i], 100, 'CA', 'February', 'approved', 'parent-003', 'teacher-001', '2025-02-11');
    addExam('student-004', sub, [68, 74, 60, 72, 62][i], 100, 'Quiz', 'February', 'approved', 'parent-003', 'teacher-001', '2025-02-24');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [72, 76, 64, 78, 66][i], 100, 'Midterm', 'March', 'approved', 'parent-003', 'teacher-001', '2025-03-16');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [74, 78, 66, 80, 68][i], 100, 'CA', 'April', 'pending', 'parent-003', 'teacher-001', '2025-04-14');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [70, 74, 62, 76, 64][i], 100, 'Final', 'May', 'pending', 'parent-003', 'teacher-001', '2025-05-21');
  });

  // ─── Student 5: Ava Thompson (Grade 7-C, parent-003) ───
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [88, 82, 90, 84, 78][i], 100, 'CA', 'January', 'approved', 'parent-003', 'teacher-002', '2025-01-17');
    addExam('student-005', sub, [85, 80, 88, 82, 76][i], 100, 'Classwork', 'January', 'approved', 'parent-003', 'teacher-002', '2025-01-24');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [90, 86, 92, 88, 82][i], 100, 'CA', 'February', 'approved', 'parent-003', 'teacher-002', '2025-02-13');
    addExam('student-005', sub, [86, 82, 90, 84, 78][i], 100, 'Quiz', 'February', 'approved', 'parent-003', 'teacher-002', '2025-02-27');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [88, 84, 92, 86, 80][i], 100, 'Midterm', 'March', 'approved', 'parent-003', 'teacher-002', '2025-03-17');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [92, 88, 94, 90, 84][i], 100, 'CA', 'April', 'approved', 'parent-003', 'teacher-002', '2025-04-11');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [90, 86, 94, 88, 82][i], 100, 'Final', 'May', 'approved', 'parent-003', 'teacher-002', '2025-05-22');
  });

  set(KEYS.users, users);
  set(KEYS.students, students);
  set(KEYS.exams, exams);
  localStorage.setItem(KEYS.seeded, 'true');
}

export function clearDatabase(): void {
  localStorage.removeItem(KEYS.users);
  localStorage.removeItem(KEYS.students);
  localStorage.removeItem(KEYS.exams);
  localStorage.removeItem(KEYS.seeded);
}
