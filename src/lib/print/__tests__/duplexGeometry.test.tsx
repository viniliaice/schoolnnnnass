// REGRESSION LOCK — duplex front/back alignment of printed family cards.
//
// Background: two design reviews claimed partial pages were misaligned,
// because mirrorForLongEdge() reverses each row IN PLACE, so a lone card's
// array position never changes. Rendering the real PDFs disproved it: the
// grid page uses `justifyContent: 'center'`, so a partial row is CENTRED, and
// a centred card is its own mirror image:
//
//   single card centred at x = (595.28 - 170.08) / 2 = 212.6
//   its mirror        = 595.28 - (212.6 + 170.08)    = 212.6   ✔
//
// The layout engine cancels the apparent bug — and "padding the rows", the
// fix both reviews proposed, would have LEFT-ALIGNED partial rows and
// actually introduced the misalignment.
//
// This test measures real rendered output and fails if that property is ever
// lost (e.g. someone changes justifyContent, page padding, card size, or the
// mirroring helper). It asserts the physical requirement directly: after a
// long-edge flip, every back must land on the mirrored x of its own front.

import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { renderToBuffer } from '@react-pdf/renderer';
import { FamilyCardsDocument, type FamilyCardData } from '../familyCards';

const MM = 2.83465;
const A4_WIDTH = 595.28;
const CARD_W = 60 * MM;
const CARD_H = 90 * MM;
const COLS = 2;
const PER_PAGE = 4;

const fam = (id: string): FamilyCardData => ({
  familyId: id,
  parentName: `Parent ${id}`,
  parentPhone: '612345678',
  students: [{
    id: `${id}-0`, name: `Kid ${id}`, className: 'Grade 7-A', parentId: `p${id}`,
    createdAt: '', transport: 'WALKER', parentPhone: '612345678', familyId: id,
  }],
});

/** Decode each page's content stream, in document (/Kids) order. */
function pageContents(buf: Buffer): string[] {
  const raw = buf.toString('latin1');
  const objects = new Map<number, { body: string; start: number; end: number }>();
  const objRe = /(\d+) 0 obj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    objects.set(Number(m[1]), { body: raw.slice(start, end), start, end });
  }
  const pagesNode = [...objects.values()].find(o => /\/Type\s*\/Pages/.test(o.body));
  if (!pagesNode) return [];
  const kidsRaw = pagesNode.body.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? '';
  const kids = [...kidsRaw.matchAll(/(\d+) 0 R/g)].map(k => Number(k[1]));

  return kids.map(pageNum => {
    const page = objects.get(pageNum)!;
    const contentRef = Number(page.body.match(/\/Contents\s+(\d+) 0 R/)![1]);
    const obj = objects.get(contentRef)!;
    const sm = /stream\r?\n/.exec(raw.slice(obj.start, obj.end))!;
    const a = obj.start + sm.index + sm[0].length;
    const b = raw.indexOf('endstream', a);
    const bytes = Buffer.from(raw.slice(a, b), 'latin1');
    try { return zlib.inflateSync(bytes).toString('latin1'); } catch { return bytes.toString('latin1'); }
  });
}

/** Card shell rectangles, in element emission order (= React child order). */
function cardShellXs(content: string): number[] {
  const xs: number[] = [];
  const re = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const [x, , w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (Math.abs(w - CARD_W) < 2 && Math.abs(h - CARD_H) < 2) xs.push(x);
  }
  return xs;
}

/** Mirror each row of a page's slots — mirrors familyCards' internal helper. */
function mirroredOrder<T>(items: T[]): T[] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += COLS) rows.push(items.slice(i, i + COLS));
  rows.forEach(r => r.reverse());
  return rows.flat();
}

describe('duplex geometry (pocket layout, long-edge flip)', () => {
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    it(`${count} card(s): every back lands on the mirrored x of its own front`, async () => {
      const families = Array.from({ length: count }, (_, i) => fam(String(i + 1).padStart(4, '0')));
      const buf = await renderToBuffer(
        <FamilyCardsDocument families={families} layout="pocket" />
      );

      const pages = pageContents(buf).map(cardShellXs);
      const pageCount = Math.ceil(count / PER_PAGE);
      const fronts = pages.slice(0, pageCount);
      const backs = pages.slice(pageCount, pageCount * 2);

      expect(fronts).toHaveLength(pageCount);
      expect(backs).toHaveLength(pageCount);

      fronts.forEach((frontXs, pageIndex) => {
        const pageFamilies = families
          .slice(pageIndex * PER_PAGE, pageIndex * PER_PAGE + PER_PAGE)
          .map(f => f.familyId);
        const backFamilies = mirroredOrder([...pageFamilies]);

        expect(frontXs).toHaveLength(pageFamilies.length);
        expect(backs[pageIndex]).toHaveLength(pageFamilies.length);

        const frontXById = new Map(pageFamilies.map((id, i) => [id, frontXs[i]]));
        backFamilies.forEach((id, slot) => {
          const requiredBackX = A4_WIDTH - (frontXById.get(id)! + CARD_W);
          expect(backs[pageIndex][slot]).toBeCloseTo(requiredBackX, 1);
        });
      });
    }, 120_000);
  }

  it('a lone card is centred, which makes it self-mirroring', async () => {
    const buf = await renderToBuffer(<FamilyCardsDocument families={[fam('0001')]} layout="pocket" />);
    const [front, back] = pageContents(buf).map(cardShellXs);
    const centred = (A4_WIDTH - CARD_W) / 2;
    expect(front[0]).toBeCloseTo(centred, 1);
    expect(back[0]).toBeCloseTo(centred, 1);
  }, 120_000);
});
