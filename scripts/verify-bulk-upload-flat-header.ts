import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { buildRosterWorkbook, GRADES_SHEET_NAME, parseRosterWorkbook } from '../src/lib/bulk-grades/workbook';
import type { AssessmentLabel } from '../src/lib/excel-parser';
import type { Student, Subject } from '../src/types';

const ALL_BLOCKS: AssessmentLabel[] = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'];

const subjects: Subject[] = [
  { id: 'ta', name: 'Tarbiya', createdAt: 'x' } as Subject,
  { id: 'ar', name: 'Arabic', createdAt: 'x' } as Subject,
  { id: 'en', name: 'English', createdAt: 'x' } as Subject,
  { id: 'ma', name: 'Math', createdAt: 'x' } as Subject,
  { id: 'so', name: 'Social Studies', createdAt: 'x' } as Subject,
  { id: 'sc', name: 'Science', createdAt: 'x' } as Subject,
  { id: 'sm', name: 'Somali', createdAt: 'x' } as Subject,
];

const roster: Student[] = [
  { id: 'S-001', name: 'Amiir Sakariye', className: 'Grade 11-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S-002', name: 'Axmed Cabdale Maxamuud', className: 'Grade 11-A', parentId: null, createdAt: 'x' } as Student,
];

function headerIndex(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`Missing header: ${name}`);
  return index;
}

function main() {
  const bytes = buildRosterWorkbook({
    className: 'Grade 11-A',
    subjects,
    blocks: ALL_BLOCKS,
    roster,
    termName: 'Term 1',
    month: 'September',
    assessmentDate: '2026-09-09',
  });

  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[GRADES_SHEET_NAME];
  const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[];

  const put = (rowNumber: number, headerName: string, value: number) => {
    const c = headerIndex(header, headerName);
    sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c })] = { t: 'n', v: value };
  };

  put(2, 'ENGLISH HW1', 4.5);
  put(2, 'ENGLISH CPW1', 12.5);
  put(2, 'MATH HW2', 3.5);
  put(2, 'ARABIC MT', 17.5);
  put(2, 'SOCIAL Attendance', 19.5);
  put(2, 'TARABIYA Akhlaaq', 9.5);

  const finalBytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  const outPath = path.join(os.tmpdir(), 'bulk-upload-flat-header-example.xlsx');
  fs.writeFileSync(outPath, Buffer.from(finalBytes));

  const diskBytes = fs.readFileSync(outPath);
  const diskWorkbook = XLSX.read(diskBytes, { type: 'buffer' });
  const diskSheet = diskWorkbook.Sheets[GRADES_SHEET_NAME];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(diskSheet, { header: 1, defval: null, raw: true });
  const parsed = parseRosterWorkbook(
    diskBytes.buffer.slice(diskBytes.byteOffset, diskBytes.byteOffset + diskBytes.byteLength) as ArrayBuffer,
    {
      expectedSubjects: subjects.map(subject => subject.name),
      expectedBlocks: ALL_BLOCKS,
    },
  );
  const student = parsed.students.find(row => row.studentId === 'S-001');

  if (!student) throw new Error('Parsed workbook did not resolve the first student');

  const summary = {
    outputPath: outPath,
    sheets: diskWorkbook.SheetNames,
    gradesHeaderCount: header.length,
    firstHeader: header[0],
    hasMergedSubjectHeader: Boolean((diskSheet['!merges'] || []).length),
    duplicateHeaders: header.filter((value, index) => header.indexOf(value) !== index),
    subjectOrder: [
      'ENGLISH', 'MATH', 'SCIENCE', 'SOCIAL', 'SOMALI', 'ARABIC', 'TARABIYA',
    ],
    firstTwelveHeaders: header.slice(0, 12),
    firstDataRow: rows[1],
    parsedIssues: parsed.issues,
    parsedScores: {
      englishHw1: student.scores.find(score => score.subjectName === 'English' && score.assessmentLabel === 'HW1')?.score,
      englishCpw1: student.scores.find(score => score.subjectName === 'English' && score.assessmentLabel === 'CPW1')?.score,
      mathHw2: student.scores.find(score => score.subjectName === 'Math' && score.assessmentLabel === 'HW2')?.score,
      arabicMt: student.scores.find(score => score.subjectName === 'Arabic' && score.assessmentLabel === 'MT')?.score,
      socialAttendance: student.scores.find(score => score.subjectName === 'Social' && score.assessmentLabel === 'ATTENDANCE')?.score,
      tarabiyaAkhlaaq: student.scores.find(score => score.subjectName === 'Tarabiya' && score.assessmentLabel === 'AKHLAAQ')?.score,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
