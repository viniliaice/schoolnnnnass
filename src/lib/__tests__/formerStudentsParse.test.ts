// Former Students / Student Cleanup — FILE PARSING.
//
// The school's leaver lists arrive as CSV (comma, semicolon, pipe or tab
// separated — the feature request itself used `Example Student| student-123456`)
// and as Excel exports. These tests assert the parser reads all of them, finds
// the columns under the headers people actually write, reports honest problems
// per row, and never invents a System ID.

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildFormerStudentCsvExample,
  buildFormerStudentTemplate,
  detectCsvDelimiter,
  isCsvFileName,
  isSupportedFormerStudentFile,
  MAX_FORMER_IMPORT_ROWS,
  parseFormerStudentFile,
  summarizeFormerStudentFile,
} from '../import/formerStudents';

function workbookBuffer(rows: unknown[][], sheetName = 'Sheet1'): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('CSV delimiters', () => {
  it('detects comma, semicolon, pipe and tab separators', () => {
    expect(detectCsvDelimiter('Student Name,System ID\nA,student-1')).toBe(',');
    expect(detectCsvDelimiter('Student Name;System ID\nA;student-1')).toBe(';');
    expect(detectCsvDelimiter('Student Name|System ID\nA|student-1')).toBe('|');
    expect(detectCsvDelimiter('Student Name\tSystem ID\nA\tstudent-1')).toBe('\t');
  });

  it('parses the exact pipe-separated shape from the feature request', () => {
    const res = parseFormerStudentFile('Student Name|System ID\nExample Student| student-123456\n');
    expect(res.delimiter).toBe('|');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ name: 'Example Student', systemId: 'student-123456', rowNumber: 2 });
    expect(res.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('parses comma and semicolon CSV, trimming spaces around cells', () => {
    const comma = parseFormerStudentFile('Student Name,System ID\n  Aisha Hassan , student-9 \n');
    expect(comma.rows[0]).toMatchObject({ name: 'Aisha Hassan', systemId: 'student-9' });

    const semi = parseFormerStudentFile('Student Name;System ID\nAisha Hassan;student-9\n');
    expect(semi.rows[0]).toMatchObject({ name: 'Aisha Hassan', systemId: 'student-9' });
  });

  it('keeps quoted fields with embedded delimiters intact', () => {
    const res = parseFormerStudentFile('Student Name,System ID\n"Nuur, Cabdi",student-77\n');
    expect(res.rows[0].name).toBe('Nuur, Cabdi');
    expect(res.rows[0].systemId).toBe('student-77');
  });
});

describe('Excel workbooks', () => {
  it('parses .xlsx with the documented header row', () => {
    const res = parseFormerStudentFile(
      workbookBuffer([
        ['Student Name', 'System ID'],
        ['Example Student', 'student-123456'],
        ['Another Student', 'student-789012'],
      ]),
      'leavers.xlsx',
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map(r => r.systemId)).toEqual(['student-123456', 'student-789012']);
    expect(res.headers).toEqual(['Student Name', 'System ID']);
  });

  it('finds the header row when a title line sits above it', () => {
    const res = parseFormerStudentFile(
      workbookBuffer([
        ['MBK — students who left, October 2026'],
        [],
        ['Student Name', 'System ID'],
        ['Example Student', 'student-123456'],
      ]),
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].rowNumber).toBe(4);
  });

  it('accepts the header spellings people actually use', () => {
    for (const [nameHeader, idHeader] of [
      ['Student Name', 'System ID'],
      ['name', 'id'],
      ['Full Name', 'Student ID'],
      ['Student', 'student_id'],
      ['STUDENT NAME', 'SYSTEM ID'],
    ] as Array<[string, string]>) {
      const res = parseFormerStudentFile(workbookBuffer([[nameHeader, idHeader], ['A', 'student-1']]));
      expect(res.rows, `${nameHeader}/${idHeader}`).toHaveLength(1);
      expect(res.rows[0].name, `${nameHeader}/${idHeader}`).toBe('A');
      expect(res.rows[0].systemId, `${nameHeader}/${idHeader}`).toBe('student-1');
    }
  });

  it('flags an Excel cell that stored the System ID as a number', () => {
    const res = parseFormerStudentFile(
      workbookBuffer([['Student Name', 'System ID'], ['Example Student', 123456]]),
    );
    expect(res.rows[0].systemId).toBe('123456');
    expect(res.rows[0].numericSystemId).toBe(true);
    expect(res.issues.some(i => i.code === 'NUMERIC_SYSTEM_ID')).toBe(true);
  });

  it('skips fully blank padding rows but keeps half-filled ones as issues', () => {
    const res = parseFormerStudentFile(
      workbookBuffer([
        ['Student Name', 'System ID'],
        ['A', 'student-1'],
        ['', ''],
        ['', 'student-2'],
        ['B', ''],
        ['', ''],
      ]),
    );
    expect(res.rows.map(r => r.systemId)).toEqual(['student-1', 'student-2', '']);
    expect(res.issues.some(i => i.code === 'MISSING_NAME' && i.row === 4)).toBe(true);
    expect(res.issues.some(i => i.code === 'MISSING_SYSTEM_ID' && i.row === 5)).toBe(true);
  });
});

describe('header problems', () => {
  it('errors when the System ID column is missing entirely', () => {
    const res = parseFormerStudentFile('Student Name,Class\nA,Grade 2-C\n');
    expect(res.rows).toHaveLength(0);
    expect(res.issues.some(i => i.code === 'MISSING_SYSTEM_ID_COLUMN' && i.severity === 'error')).toBe(true);
  });

  it('warns when the name column is missing but still reads the IDs', () => {
    const res = parseFormerStudentFile('System ID\nstudent-1\n');
    expect(res.issues.some(i => i.code === 'MISSING_NAME_COLUMN' && i.severity === 'warning')).toBe(true);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ name: '', systemId: 'student-1' });
    // A row without a name can never be auto-applied — the server says so too.
    expect(res.issues.some(i => i.code === 'MISSING_NAME' && i.row === 2)).toBe(true);
  });

  it('falls back to positional columns for a headerless export, with a warning', () => {
    const res = parseFormerStudentFile('Example Student,student-123456\nAnother,student-2\n');
    expect(res.issues.some(i => i.code === 'NO_HEADER' && i.severity === 'warning')).toBe(true);
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ name: 'Example Student', systemId: 'student-123456', rowNumber: 1 });
  });

  it('reports an empty file and an unreadable file as errors, never as zero rows', () => {
    expect(parseFormerStudentFile('').issues.some(i => i.code === 'EMPTY_FILE')).toBe(true);
    expect(parseFormerStudentFile('Student Name,System ID\n').rows).toHaveLength(0);
    // Junk bytes must never turn into silently applicable rows: either the read
    // fails, or the result is reported as unusable.
    const broken = parseFormerStudentFile(new Uint8Array([1, 2, 3, 4, 5]).buffer, 'broken.xlsx');
    const usable = broken.rows.filter(r => r.name && r.systemId);
    expect(usable.length === 0 || broken.issues.length > 0).toBe(true);
  });
});

describe('file-level duplicates', () => {
  it('reports a repeated System ID on every colliding row', () => {
    const res = parseFormerStudentFile(
      'Student Name,System ID\nSame Kid,student-1\nSame Kid,student-1\nOther,student-2\n',
    );
    const flagged = res.issues.filter(i => i.code === 'DUPLICATE_SYSTEM_ID');
    expect(flagged.map(i => i.row)).toEqual([2, 3]);
    expect(summarizeFormerStudentFile(res.rows, res.issues).duplicateSystemIds).toBe(2);
  });

  it('reports the same name under different System IDs', () => {
    const res = parseFormerStudentFile(
      'Student Name,System ID\nSame Name,student-1\nsame   name,student-2\n',
    );
    const flagged = res.issues.filter(i => i.code === 'DUPLICATE_NAME');
    expect(flagged.map(i => i.row)).toEqual([2, 3]);
    expect(summarizeFormerStudentFile(res.rows, res.issues).duplicateNames).toBe(2);
  });
});

describe('file summary (preview dashboard numbers)', () => {
  it('counts uploaded, valid, missing and duplicate rows', () => {
    const res = parseFormerStudentFile(
      'Student Name,System ID\n' +
      'Good Row,student-1\n' +
      ',student-2\n' +                 // missing name
      'No Id Row,\n' +                 // missing id
      'Good Row,student-1\n' +         // duplicate id + duplicate name
      'Unknown,student-404\n',
    );
    const summary = summarizeFormerStudentFile(res.rows, res.issues);
    expect(summary.totalUploaded).toBe(5);
    expect(summary.validRecords).toBe(3);
    expect(summary.missingNames).toBe(1);
    expect(summary.missingSystemIds).toBe(1);
    expect(summary.duplicateSystemIds).toBe(2);
    expect(summary.duplicateNames).toBe(2);
    expect(summary.warnings).toBeGreaterThan(0);
    expect(summary.errors).toBe(0);
  });

  it('errors when the file is bigger than the documented row limit', () => {
    const lines = ['Student Name,System ID'];
    for (let i = 0; i < MAX_FORMER_IMPORT_ROWS + 1; i++) lines.push(`Student ${i},student-${i}`);
    const res = parseFormerStudentFile(lines.join('\n'));
    expect(res.rows).toHaveLength(MAX_FORMER_IMPORT_ROWS + 1);
    expect(res.issues.some(i => i.code === 'TOO_MANY_ROWS' && i.severity === 'error')).toBe(true);
  });
});

describe('template + accepted file types', () => {
  it('template round-trips through the parser', async () => {
    const blob = buildFormerStudentTemplate([{ id: 'student-123456', name: 'Example Student' }]);
    const buffer = await blob.arrayBuffer();
    const res = parseFormerStudentFile(buffer, 'former-students-template.xlsx');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ name: 'Example Student', systemId: 'student-123456' });
    expect(res.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('the CSV example is parseable too', () => {
    const res = parseFormerStudentFile(buildFormerStudentCsvExample());
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].systemId).toBe('student-123456');
  });

  it('accepts csv/txt/tsv/xlsx/xlsm/xls and nothing else', () => {
    for (const ok of ['a.csv', 'a.CSV', 'a.txt', 'a.tsv', 'a.xlsx', 'a.xlsm', 'a.xls']) {
      expect(isSupportedFormerStudentFile(ok), ok).toBe(true);
    }
    for (const bad of ['a.pdf', 'a.docx', 'a.numbers', 'noextension']) {
      expect(isSupportedFormerStudentFile(bad), bad).toBe(false);
    }
    expect(isCsvFileName('leavers.csv')).toBe(true);
    expect(isCsvFileName('leavers.xlsx')).toBe(false);
  });
});
