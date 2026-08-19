// Grade on the printed family card.
//
// Source of truth is students.className — there is no grade/year column on
// students in any migration, and the app already labels this value "Grade"
// (StudentDirectory, transport import, gate strings).
//
// The literal "Name — Grade 12-C" on one line was measured and REJECTED: at
// the card's ~123pt row width, "Xalimo Xasan Maxamed" (94.1pt) + "Grade 12-C"
// (36.3pt) = 133.8pt, and @react-pdf 4.3.2 does not truncate. The shipped
// layout is a compact, fixed-width, right-aligned chip that lives inside the
// student's own row so it cannot drift onto a sibling.

import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { renderToBuffer } from '@react-pdf/renderer';
import {
  buildFamilyCardData, familyTransportLabel, FamilyCardsDocument, type FamilyCardData,
} from '../familyCards';
import type { Student } from '../../../types';

const student = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: 'p1', createdAt: '', transport: 'WALKER',
  parentPhone: '612345678', familyId: '0042', ...over,
});

/** Concatenated, decompressed content of every page stream. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const a = m.index + m[0].length;
    const b = raw.indexOf('endstream', a);
    if (b < 0) continue;
    try { out.push(zlib.inflateSync(Buffer.from(raw.slice(a, b), 'latin1')).toString('latin1')); } catch { /* not flate */ }
  }
  return out.join('\n');
}

/**
 * Glyphs are subset-encoded as hex inside TJ arrays. @react-pdf emits one
 * byte per glyph for these Helvetica subsets, so decode in 2-hex-digit steps.
 */
function visibleText(buf: Buffer): string {
  const content = pdfText(buf);
  const chunks: string[] = [];
  const tj = /\[(.*?)\]\s*TJ/gs;
  let m: RegExpExecArray | null;
  while ((m = tj.exec(content))) {
    const hex = [...m[1].matchAll(/<([0-9a-fA-F]+)>/g)].map(h => h[1]).join('');
    let s = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16);
      if (!Number.isNaN(code)) s += String.fromCharCode(code);
    }
    chunks.push(s);
  }
  return chunks.join('|');
}

const FAMILY: FamilyCardData = {
  familyId: '0042',
  parentName: 'Xasan Maxamed Cabdi',
  parentPhone: '612345678',
  students: [
    student({ id: 's1', name: 'Ahmed Sheikh', className: 'Grade 7-A' }),
    student({ id: 's2', name: 'Amina Sheikh', className: 'Grade 4-B' }),
    student({ id: 's3', name: 'Yasmin Sheikh', className: 'KG-C' }),
  ],
};

describe('grade appears beside every student name', () => {
  it('renders a grade chip for each sibling', async () => {
    const buf = await renderToBuffer(<FamilyCardsDocument families={[FAMILY]} layout="pocket" />);
    const text = visibleText(buf);
    expect(text).toContain('Ahmed Sheikh');
    expect(text).toContain('Amina Sheikh');
    expect(text).toContain('Yasmin Sheikh');
    // one chip per student, from their own className
    expect(text).toContain('G7');
    expect(text).toContain('G4');
    expect(text).toContain('KG');
  }, 120_000);

  it('keeps each grade adjacent to its own student (no cross-contamination)', async () => {
    const buf = await renderToBuffer(<FamilyCardsDocument families={[FAMILY]} layout="pocket" />);
    const runs = visibleText(buf).split('|');
    const idxName = (n: string) => runs.findIndex(r => r.includes(n));
    const idxAfter = (from: number, token: string) =>
      runs.findIndex((r, i) => i > from && r.trim() === token);

    // Each name is immediately followed by ITS grade, before the next name.
    const ahmed = idxName('Ahmed Sheikh');
    const amina = idxName('Amina Sheikh');
    const yasmin = idxName('Yasmin Sheikh');
    expect(ahmed).toBeGreaterThanOrEqual(0);
    expect(idxAfter(ahmed, 'G7')).toBeLessThan(amina);
    expect(idxAfter(amina, 'G4')).toBeLessThan(yasmin);
    expect(idxAfter(yasmin, 'KG')).toBeGreaterThan(yasmin);
  }, 120_000);

  it('renders grades on the placard layout too', async () => {
    const buf = await renderToBuffer(<FamilyCardsDocument families={[FAMILY]} layout="placard" />);
    const text = visibleText(buf);
    expect(text).toContain('G7');
    expect(text).toContain('KG');
  }, 120_000);

  it('omits the chip rather than printing junk when className is missing', async () => {
    const noClass: FamilyCardData = {
      ...FAMILY,
      students: [student({ id: 'x', name: 'Cabdi NoClass', className: '' })],
    };
    const buf = await renderToBuffer(<FamilyCardsDocument families={[noClass]} layout="pocket" />);
    expect(visibleText(buf)).toContain('Cabdi NoClass');
  }, 120_000);

  it('handles a long name plus a grade without dropping either', async () => {
    const long: FamilyCardData = {
      ...FAMILY,
      students: [student({ id: 'x', name: 'Cabdiraxmaan Maxamuud Warsame', className: 'Grade 12-C' })],
    };
    const buf = await renderToBuffer(<FamilyCardsDocument families={[long]} layout="pocket" />);
    const text = visibleText(buf);
    expect(text).toContain('Cabdiraxmaan');
    expect(text).toContain('G12');
  }, 120_000);

  it('renders a 6-child family on a single card (front + back only)', async () => {
    const big: FamilyCardData = {
      ...FAMILY,
      students: Array.from({ length: 6 }, (_, i) =>
        student({ id: `k${i}`, name: `Xalimo Xasan Maxamed ${i}`, className: `Grade ${i + 1}-A` })),
    };
    const buf = await renderToBuffer(<FamilyCardsDocument families={[big]} layout="pocket" />);
    const pageObjects = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pageObjects).toBe(2);
    const text = visibleText(buf);
    for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) expect(text).toContain(g);
  }, 120_000);
});

describe('familyTransportLabel — mixed-transport families', () => {
  it('shows every distinct mode, not just the first student', () => {
    expect(familyTransportLabel([
      student({ id: '1', name: 'A', transport: 'WALKER' }),
      student({ id: '2', name: 'B', transport: '9' }),
    ])).toBe('WALKER · Bus 9');
  });

  it('deduplicates identical modes', () => {
    expect(familyTransportLabel([
      student({ id: '1', name: 'A', transport: '9' }),
      student({ id: '2', name: 'B', transport: '9' }),
    ])).toBe('Bus 9');
  });

  it('ignores students who left', () => {
    expect(familyTransportLabel([
      student({ id: '1', name: 'A', transport: 'CAR' }),
      student({ id: '2', name: 'B', transport: 'LEFT' }),
    ])).toBe('CAR');
  });

  it('prints WALKER for a child with no transport set', () => {
    // Business rule: empty/NULL means WALKER everywhere, the printed card
    // included. This used to fall through to the 'GAAR / CAR' placeholder.
    expect(familyTransportLabel([student({ id: '1', name: 'A', transport: null })])).toBe('WALKER');
    expect(familyTransportLabel([student({ id: '1', name: 'A', transport: '' })])).toBe('WALKER');
  });

  it('still falls back when EVERY child has left', () => {
    // The only remaining path to the placeholder.
    expect(familyTransportLabel([student({ id: '1', name: 'A', transport: 'LEFT' })])).toBe('GAAR / CAR');
  });
});

describe('buildFamilyCardData — roster hygiene', () => {
  it('excludes students who left but keeps the rest of the family', async () => {
    const groups = new Map<string, Student[]>([['0042', [
      student({ id: 'a', name: 'Ahmed Sheikh' }),
      student({ id: 'b', name: 'Layla Sheikh', transport: 'LEFT' }),
    ]]]);
    const [card] = await buildFamilyCardData(groups);
    expect(card.students.map(s => s.name)).toEqual(['Ahmed Sheikh']);
  });

  it('drops a family whose members have all left (no blank card)', async () => {
    const groups = new Map<string, Student[]>([['0099', [
      student({ id: 'a', name: 'Gone One', transport: 'LEFT' }),
    ]]]);
    expect(await buildFamilyCardData(groups)).toEqual([]);
  });

  it('preserves alphabetical student ordering', async () => {
    const groups = new Map<string, Student[]>([['0042', [
      student({ id: 'c', name: 'Yasmin Sheikh' }),
      student({ id: 'a', name: 'Ahmed Sheikh' }),
      student({ id: 'b', name: 'Amina Sheikh' }),
    ]]]);
    const [card] = await buildFamilyCardData(groups);
    expect(card.students.map(s => s.name)).toEqual(['Ahmed Sheikh', 'Amina Sheikh', 'Yasmin Sheikh']);
  });
});
