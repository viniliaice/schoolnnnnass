import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseTransportImport } from '../import/transportImport';
import {
  buildExampleWorkbook,
  TRANSPORT_EXAMPLE_CSV,
  TRANSPORT_EXAMPLE_HEADER,
  TRANSPORT_EXAMPLE_ROWS,
} from '../import/transportTemplate';

describe('transport import template', () => {
  it('example CSV parses cleanly with the real import parser', () => {
    const result = parseTransportImport(TRANSPORT_EXAMPLE_CSV);
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    expect(result.rows).toHaveLength(TRANSPORT_EXAMPLE_ROWS.length);
  });

  it('example CSV rows carry the expected transport kinds', () => {
    const result = parseTransportImport(TRANSPORT_EXAMPLE_CSV);
    const kinds = result.rows.map(r => r.transport.kind);
    // NB → walker, 9 → bus, 19 → bus, 0 → walker
    expect(kinds).toEqual(['walker', 'bus', 'bus', 'walker']);
  });

  it('workbook has the data sheet first, then the instructions sheet', () => {
    const wb = buildExampleWorkbook();
    expect(wb.SheetNames[0]).toBe('Transport');
    expect(wb.SheetNames).toContain('How to fill');
  });

  it('workbook data sheet header matches the example header', () => {
    const wb = buildExampleWorkbook();
    const sheet = wb.Sheets['Transport'];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    expect(aoa[0].map(String)).toEqual(TRANSPORT_EXAMPLE_HEADER);
  });

  it('workbook data sheet parses identically to the CSV text', () => {
    const wb = buildExampleWorkbook();
    const sheet = wb.Sheets['Transport'];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
    const text = aoa.map(row => row.map(cell => String(cell ?? '')).join(',')).join('\n');
    const result = parseTransportImport(text);
    expect(result.rows).toHaveLength(TRANSPORT_EXAMPLE_ROWS.length);
    expect(result.rows.map(r => r.name)).toEqual(TRANSPORT_EXAMPLE_ROWS.map(r => r[4]));
  });
});
