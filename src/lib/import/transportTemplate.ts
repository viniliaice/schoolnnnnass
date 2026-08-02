// Example / template for the family-ID transport import.
//
// The Family IDs page lets admins download an example workbook so they can see
// exactly how the sheet must look before uploading. The data sheet is built
// from the same rows as the CSV that the "Paste example" button drops into the
// paste box, and both are verified against the real import parser in
// src/lib/__tests__/transportTemplate.test.ts — if the example ever stops
// parsing cleanly, that test fails.
//
// Important: the parser reads only the FIRST sheet of a workbook
// (workbook.SheetNames[0]), so the data sheet ("Transport") is appended before
// the instructions sheet ("How to fill").

import * as XLSX from 'xlsx';

/** Header row of the example — mirrors the real MBK Google Sheet export. */
export const TRANSPORT_EXAMPLE_HEADER = ['number', 'Gov-id', 'Bus', 'Grade', 'Name', 'SECOND NUMBER', 'STATUS'];

/** Four realistic rows: two walkers (NB / 0) and two bus riders. */
export const TRANSPORT_EXAMPLE_ROWS: string[][] = [
  ['1', '634555034', 'NB', 'G7A', 'Xalimo Xasan Maxamed', '+252634555034', 'active'],
  ['2', '634537584', '9', 'F3A', 'Cadnan Maxamed Barkhad', '+252634564899', 'active'],
  ['3', '22-992343', '19', 'G2A', 'Abdalla Cumar Maxamud', '', 'orphan'],
  ['4', '', '0', 'G2A', 'Muxsin Xamse Axmed', '', 'orphan'],
];

/** Same rows as plain CSV text, for the paste box ("Paste example"). */
export const TRANSPORT_EXAMPLE_CSV = [
  TRANSPORT_EXAMPLE_HEADER.join(','),
  ...TRANSPORT_EXAMPLE_ROWS.map(row => row.join(',')),
].join('\n');

const INSTRUCTIONS_SHEET: string[][] = [
  ['MBK family-ID import — how to fill this sheet (Sida loo buuxiyo)'],
  [],
  ['Column', 'Meaning', 'Example', 'Required?'],
  ['Name', 'Student name exactly as it appears in the app', 'Xalimo Xasan Maxamed', 'Yes'],
  ['Grade', 'Class code from the master sheet (G7A, F3A …)', 'G7A', 'No — used to disambiguate same names'],
  ['Bus', 'Bus number, or NB / 0 / empty for walkers', '9', 'No'],
  ['Gov-id', 'Government / admission number', '634555034', 'No'],
  ['SECOND NUMBER', 'Parent contact phone', '+252634555034', 'No'],
  ['STATUS', 'Student status (active, orphan …)', 'active', 'No'],
  [],
  ['Tips'],
  ['• Header names are matched by name — column order does not matter, extra columns are ignored.'],
  ['• NB / 0 / empty in Bus = WALKER; a number = bus rider.'],
  ['• LEFT in Bus or STATUS means the student may have left — it is flagged for review.'],
  ['• Delete summary rows at the bottom (e.g. "0 students, 0 free").'],
  ['• Only the first sheet ("Transport") is read; the other sheets are ignored.'],
];

/** Builds the example workbook: data sheet first, instructions second. */
export function buildExampleWorkbook(): XLSX.WorkBook {
  const dataSheet = XLSX.utils.aoa_to_sheet([TRANSPORT_EXAMPLE_HEADER, ...TRANSPORT_EXAMPLE_ROWS]);
  dataSheet['!cols'] = [
    { wch: 8 }, { wch: 12 }, { wch: 6 }, { wch: 8 },
    { wch: 26 }, { wch: 16 }, { wch: 10 },
  ];
  const instructionsSheet = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_SHEET);
  instructionsSheet['!cols'] = [{ wch: 18 }, { wch: 52 }, { wch: 24 }, { wch: 30 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, dataSheet, 'Transport');
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'How to fill');
  return workbook;
}

/** Triggers the browser download of the example workbook. */
export function downloadExampleWorkbook(): void {
  XLSX.writeFile(buildExampleWorkbook(), 'mbk-family-ids-example.xlsx');
}
