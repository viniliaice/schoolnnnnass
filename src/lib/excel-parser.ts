import * as XLSX from 'xlsx';

export interface ParsedScore {
  examType: string;
  score: number;
  total: number;
}

export interface ParsedStudentRow {
  studentName: string;
  subjectScores: Record<string, ParsedScore[]>;
}

export interface ParseResult {
  subjects: string[];
  students: ParsedStudentRow[];
  studentCount: number;
  totalExams: number;
}

const KNOWN_SUBJECTS = ['english', 'math', 'science', 'social', 'somali', 'mathematics', 'islamic', 'arabic', 'quran'];

const COLUMN_TYPES = [
  { examType: 'Homework', total: 5 },
  { examType: 'Homework', total: 5 },
  { examType: 'Homework', total: 5 },
  { examType: 'Homework', total: 5 },
  { examType: 'Classwork', total: 15 },
  { examType: 'Classwork', total: 15 },
  { examType: 'Classwork', total: 15 },
  { examType: 'Classwork', total: 15 },
  { examType: 'Attendance', total: 20 },
  { examType: 'Quiz', total: 20 },
  { examType: 'Discipline', total: 10 },
];

const BLOCK_SIZE = COLUMN_TYPES.length;

export function parseExcel(file: ArrayBuffer): ParseResult {
  const wb = XLSX.read(file, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (rows.length < 3) {
    throw new Error('File has fewer than 3 rows — expected a header row with "Student Name" followed by data rows');
  }

  const headerIdx = rows.findIndex(r =>
    String(r?.[0] || '').toLowerCase().includes('student name')
  );
  if (headerIdx === -1) {
    throw new Error('Could not find a header row with "Student Name" in the first cell');
  }

  const headerRow = rows[headerIdx];
  const subjectRow = rows[headerIdx - 1] || [];

  const dataCols = headerRow.length - 1;
  const numBlocks = Math.floor(dataCols / BLOCK_SIZE);

  const subjectRowStart = (() => {
    for (let c = 0; c < subjectRow.length; c++) {
      const val = String(subjectRow[c] || '').toLowerCase().trim();
      if (KNOWN_SUBJECTS.includes(val)) return c;
    }
    return 0;
  })();

  const subjects: string[] = [];
  for (let b = 0; b < numBlocks; b++) {
    const subjectCol = subjectRowStart + b * BLOCK_SIZE;
    const name = String(subjectRow[subjectCol] || '').trim();
    subjects.push(name || `Subject ${b + 1}`);
  }

  const students: ParsedStudentRow[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !String(row[0] || '').trim()) continue;

    const studentName = String(row[0] || '').trim();
    if (!studentName || studentName === '0') continue;

    const subjectScores: Record<string, ParsedScore[]> = {};

    for (let b = 0; b < numBlocks; b++) {
      const subject = subjects[b];
      const baseCol = 1 + b * BLOCK_SIZE;
      const scores: ParsedScore[] = [];

      for (let i = 0; i < BLOCK_SIZE; i++) {
        const col = baseCol + i;
        if (col >= row.length) continue;

        const raw = row[col];
        const trimmed = raw != null ? String(raw).trim() : '';
        if (trimmed === '' || trimmed === '-') continue;

        const score = typeof raw === 'number' ? raw : parseFloat(trimmed);
        if (!isNaN(score) && score >= 0) {
          scores.push({
            examType: COLUMN_TYPES[i].examType,
            score: Math.round(score),
            total: COLUMN_TYPES[i].total,
          });
        }
      }

      subjectScores[subject] = scores;
    }

    if (Object.values(subjectScores).some(s => s.length > 0)) {
      students.push({ studentName, subjectScores });
    }
  }

  const totalExams = students.reduce(
    (sum, s) => sum + Object.values(s.subjectScores).reduce((a, b) => a + b.length, 0),
    0,
  );

  return { subjects, students, studentCount: students.length, totalExams };
}
