// Printable family cards + gate lookup list for the family-ID feature.
//
// Three layouts (design decision 7): pocket (60×90mm portrait), lanyard
// (60×90mm portrait, walkers), placard (148×105mm landscape A5,
// windshield/rearview mirror). Both card sizes fit the 65×95mm laminating
// pouch film with a ~5mm sealing margin. Each card prints FRONT + BACK:
//   - front  : branded hero (gradient + logo badge + title), kid rows with
//              circular icon badges, family-ID + parent-phone rows.
//   - back   : large scanning QR (~60–70% of the shorter dimension), family
//              ID, "Present at gate for scanning." caption, bold school footer.
//
// Duplex alignment (grid layouts: pocket/lanyard): when a sheet is printed
// double-sided and flipped on the LONG edge (the standard for portrait
// cards), the front's top-left card lands top-RIGHT on the back. We mirror
// each back-page row horizontally (reverse order within each row of `COLS`
// cards) so every back aligns with its front. If your printer uses SHORT-edge
// flip, mirror vertically instead — see `mirrorForLongEdge` / the
// `MIRROR_VERTICAL` flag below.
//
// The QR is drawn as a vector path at render time (see CardShell / CardBack);
// the 'MBK-' prefix appears only on the printed artifact (decision 8).

import {
  Document, Image, Page, StyleSheet, Svg, Path, Text, View,
  Defs, LinearGradient, Rect, Circle, Stop,
} from '@react-pdf/renderer';
import type { Student } from '../../types';
import { displayFamilyId, formatGradeLabel, transportLabel } from '../transport';
import { buildQrPath } from './qrPath';
import mbkLogo from '../../../assets/MBK Internatinal Logo.png';

export type CardLayout = 'pocket' | 'lanyard' | 'placard';

export interface FamilyCardData {
  familyId: string;
  students: Student[];
  parentPhone: string;
  parentName: string;
}

const MBK_BLUE = '#3C618E';
const MBK_BLUE_DARK = '#26466B';
const MBK_BLUE_DEEP = '#1E3A5F';
const INK = '#111827';
const MUTED = '#4b5563';
const HAIR = '#e5e7eb';
const PANEL = '#ffffff';

const MM = 2.83465; // 1mm in pt

// Duplex flip model. Long-edge flip (default) → mirror each back-page row
// horizontally. For short-edge flip, set this to `true` to mirror rows
// vertically instead.
const MIRROR_VERTICAL = false;

// Grid: 2 columns × 2 rows = 4 cards per A4 sheet for pocket/lanyard.
// A4 portrait 210×297mm, page padding 10mm → usable 190×277mm; card+margin
// 66×96mm → 2 cols, 2 rows. Placard: 1 per page (A5 landscape card on A4).
const COLS = 2;
const PER_PAGE = COLS * COLS;

const styles = StyleSheet.create({
  // ── Pages ─────────────────────────────────────────────────────────
  // justify-content: center centers each wrapped line so cards sit in the
  // middle of the sheet — critical for exact print/cut position and for
  // keeping front/back duplex alignment (both sides are centered identically).
  gridPage: { flexDirection: 'row', flexWrap: 'wrap', padding: 10 * MM, justifyContent: 'center' },
  placardPage: { padding: 6 * MM, alignItems: 'center' },
  lookupPage: { padding: 14 * MM },

  // ── Card shells (front & back share dims) ─────────────────────────
  card: {
    width: 60 * MM, height: 90 * MM,
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4,
    margin: 3 * MM, overflow: 'hidden',
    backgroundColor: PANEL,
  },
  cardLarge: {
    width: 148 * MM, height: 105 * MM,
    borderWidth: 2, borderColor: '#9ca3af', borderRadius: 6,
    marginBottom: 6 * MM, overflow: 'hidden',
    backgroundColor: PANEL,
  },
  backCard: {
    width: 60 * MM, height: 90 * MM,
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4,
    margin: 3 * MM, overflow: 'hidden',
    backgroundColor: PANEL,
    padding: 4 * MM,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backCardLarge: {
    width: 148 * MM, height: 105 * MM,
    borderWidth: 2, borderColor: '#9ca3af', borderRadius: 6,
    marginBottom: 6 * MM, overflow: 'hidden',
    backgroundColor: PANEL,
    padding: 8 * MM,
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  // ── Front: hero ───────────────────────────────────────────────────
  hero: { position: 'relative', height: 19 * MM, paddingVertical: 0, paddingHorizontal: 3 * MM, flexDirection: 'row', alignItems: 'stretch' },
  heroLarge: { position: 'relative', height: 24 * MM, paddingVertical: 0, paddingHorizontal: 6 * MM, flexDirection: 'row', alignItems: 'stretch' },
  heroWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  brandBlock: { flex: 1, marginLeft: 3 * MM, justifyContent: 'center', paddingVertical: 1.5 * MM },
  brandTitle: { color: '#ffffff', fontSize: 10.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 0.35 },
  brandTitleLarge: { color: '#ffffff', fontSize: 16, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 0.5 },
  brandSub: { color: '#f8fafc', fontSize: 6.7, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 1.4, marginTop: 0.8 * MM },
  brandSubLarge: { color: '#f8fafc', fontSize: 10, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 1.8, marginTop: 1 * MM },
  heroSpacer: { marginLeft: 'auto' },

  // Logo fills the full hero height while the image itself keeps its aspect ratio.
  logoBadge: { width: 15 * MM, height: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#ffffff' },
  logoBadgeLarge: { width: 22 * MM, height: '100%', justifyContent: 'center', alignItems: 'center', backgroundColor: '#ffffff' },
  logoFill: { width: '100%', height: '100%', objectFit: 'contain' },

  // ── Front: rows panel ──────────────────────────────────────────────
  panel: { flex: 1, paddingHorizontal: 3.5 * MM, paddingTop: 4 * MM, paddingBottom: 3 * MM },
  panelLarge: { flex: 1, paddingHorizontal: 7 * MM, paddingTop: 5 * MM, paddingBottom: 4.5 * MM },
  panelLabel: { fontSize: 6.2, color: MBK_BLUE_DARK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginBottom: 2 * MM },
  panelLabelLarge: { fontSize: 9.5, color: MBK_BLUE_DARK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 1, marginBottom: 2.5 * MM },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 1.35 * MM },
  rowLarge: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 * MM },
  rowBody: { flex: 1, marginLeft: 2.3 * MM, paddingRight: 1 * MM },
  rowName: { fontSize: 8.3, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: INK },
  rowNameLarge: { fontSize: 12.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: INK },
  rowMeta: { fontSize: 6.3, color: MUTED, fontWeight: 'bold' },
  rowMetaLarge: { fontSize: 9.5, color: MUTED, fontWeight: 'bold' },

  // Name + grade share one baseline row. The name flexes (and wraps if a name
  // is genuinely enormous); the grade chip is fixed-width, right-aligned and
  // never shrinks, so it stays anchored to ITS student and can never be
  // mistaken for a sibling's grade. Measured: rowBody is ~123pt on a 60mm
  // card, which is why the chip is compact (formatGradeLabel) rather than a
  // full class name.
  nameLine: { flexDirection: 'row', alignItems: 'baseline' },
  rowNameFlex: { flex: 1, flexShrink: 1 },
  gradeChip: {
    width: 26, flexShrink: 0, textAlign: 'right', paddingLeft: 1.2 * MM,
    fontSize: 6.8, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: MBK_BLUE_DARK,
  },
  gradeChipLarge: {
    width: 38, flexShrink: 0, textAlign: 'right', paddingLeft: 2 * MM,
    fontSize: 9.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: MBK_BLUE_DARK,
  },
  divider: { height: 0.5, backgroundColor: HAIR, marginVertical: 1.5 * MM },

  // circular icon badge (initial/glyph in a colored disc)
  badgeWrap: { width: 5.5 * MM, height: 5.5 * MM, alignItems: 'center', justifyContent: 'center' },
  badgeWrapLarge: { width: 8.5 * MM, height: 8.5 * MM, alignItems: 'center', justifyContent: 'center' },
  badgeSvg: { position: 'absolute', top: 0, left: 0 },
  badgeChar: { fontSize: 5.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: '#ffffff' },
  badgeCharLarge: { fontSize: 8.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: '#ffffff' },

  // ── Front: footer ──────────────────────────────────────────────────
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 3 * MM, paddingVertical: 2 * MM, backgroundColor: '#f3f4f6' },
  footLarge: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 6 * MM, paddingVertical: 3 * MM, backgroundColor: '#f3f4f6' },
  footText: { fontSize: 6.3, color: INK, fontWeight: 'bold' },
  footTextLarge: { fontSize: 9, color: INK, fontWeight: 'bold' },
  modeBadge: { fontSize: 6.3, color: MBK_BLUE_DARK, borderWidth: 0.6, borderColor: MBK_BLUE, borderRadius: 2, paddingHorizontal: 2.5, paddingVertical: 1, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },
  modeBadgeLarge: { fontSize: 9, color: MBK_BLUE_DARK, borderWidth: 0.8, borderColor: MBK_BLUE, borderRadius: 2, paddingHorizontal: 4, paddingVertical: 1.5, fontWeight: 'bold', fontFamily: 'Helvetica-Bold' },

  // ── Back side ──────────────────────────────────────────────────────
  backTop: { alignItems: 'center' },
  backId: { fontSize: 14, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: INK, letterSpacing: 1.5, marginTop: 1.5 * MM },
  backIdLarge: { fontSize: 26, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: INK, letterSpacing: 2, marginTop: 2 * MM },
  backIdTag: { fontSize: 6.3, color: MBK_BLUE_DARK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 2 },
  backIdTagLarge: { fontSize: 9, color: MBK_BLUE_DARK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', letterSpacing: 2 },
  backCaption: { fontSize: 7.2, color: INK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', marginTop: 2 * MM, letterSpacing: 0.3 },
  backCaptionLarge: { fontSize: 10.5, color: INK, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', marginTop: 3 * MM, letterSpacing: 0.3 },
  backFooter: { flexDirection: 'row', alignItems: 'center', gap: 1.5 * MM },
  backFooterLarge: { flexDirection: 'row', alignItems: 'center', gap: 2.5 * MM },
  backFooterLogo: { width: 5 * MM, height: 5 * MM },
  backFooterLogoLarge: { width: 8 * MM, height: 8 * MM },
  backFooterName: { fontSize: 8, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: MBK_BLUE_DARK, letterSpacing: 0.4 },
  backFooterNameLarge: { fontSize: 13, fontWeight: 'bold', fontFamily: 'Helvetica-Bold', color: MBK_BLUE_DARK, letterSpacing: 0.5 },

  // ── Gate lookup list page (unchanged) ──────────────────────────────
  lookupTitle: { fontSize: 12, fontWeight: 'bold', marginBottom: 6, color: INK },
  lookupSub: { fontSize: 7, color: MUTED, marginBottom: 8 },
  lookupRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb', paddingVertical: 3, fontSize: 7 },
  lookupId: { width: 30 * MM, fontWeight: 'bold' },
  lookupNames: { flex: 1 },
  lookupPhone: { width: 38 * MM, textAlign: 'right', color: MUTED },
});

/** Diagonal gradient background for the front hero. Stretched to fill its parent. */
function GradientBg({ large }: { large: boolean }) {
  const w = large ? 148 * MM : 60 * MM;
  const h = large ? 24 * MM : 19 * MM; // hero height only; clipped by hero overflow
  return (
    <Svg width={w} height={h} style={styles.heroWrap}>
      <Defs>
        <LinearGradient id="mbkGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor={MBK_BLUE} />
          <Stop offset="100%" stopColor={MBK_BLUE_DEEP} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width={w} height={h} fill="url(#mbkGrad)" />
    </Svg>
  );
}

/** Circular icon badge: colored disc with a centered white character. */
function Badge({ char, color, large }: { char: string; color: string; large: boolean }) {
  const wrap = large ? styles.badgeWrapLarge : styles.badgeWrap;
  const size = large ? 8 * MM : 5 * MM;
  const charStyle = large ? styles.badgeCharLarge : styles.badgeChar;
  return (
    <View style={wrap}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={styles.badgeSvg}>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={color} />
      </Svg>
      <Text style={charStyle}>{char}</Text>
    </View>
  );
}

function initialOf(name: string): string {
  return (name?.trim()?.[0] ?? '?').toUpperCase();
}

/** One kid row: circular initial badge + name + class · transport. */
/**
 * Footer transport badge for the WHOLE family.
 *
 * Previously this read `students[0].transport`, so a family with a walker and
 * a bus rider was labelled by whichever child sorted first. Show every
 * distinct mode instead ('Bus 9 · WALKER'), in roster order.
 */
export function familyTransportLabel(students: Student[]): string {
  const seen: string[] = [];
  for (const s of students) {
    if (!s.transport || s.transport === 'LEFT') continue;
    const label = transportLabel(s.transport);
    if (!seen.includes(label)) seen.push(label);
  }
  if (seen.length === 0) return 'GAAR / CAR';
  return seen.join(' · ');
}

function KidRow({ student, large }: { student: Student; large: boolean }) {
  const grade = formatGradeLabel(student.className);
  return (
    <View style={large ? styles.rowLarge : styles.row} key={student.id} wrap={false}>
      <Badge char={initialOf(student.name)} color={MBK_BLUE} large={large} />
      <View style={styles.rowBody}>
        {/* Grade sits on the name's baseline, inside THIS student's row, so it
            can never drift onto a sibling. The transport moves to the meta
            line alone (the class used to live there). */}
        <View style={styles.nameLine}>
          <Text style={[large ? styles.rowNameLarge : styles.rowName, styles.rowNameFlex]}>
            {student.name}
          </Text>
          {grade !== '' && (
            <Text style={large ? styles.gradeChipLarge : styles.gradeChip}>{grade}</Text>
          )}
        </View>
        <Text style={large ? styles.rowMetaLarge : styles.rowMeta}>
          {transportLabel(student.transport)}
        </Text>
      </View>
    </View>
  );
}

/** Front side of one family card. */
function CardFront({ layout, data }: { layout: CardLayout; data: FamilyCardData }) {
  const large = layout === 'placard';
  const cardStyle = large ? styles.cardLarge : styles.card;
  const heroStyle = large ? styles.heroLarge : styles.hero;
  const titleStyle = large ? styles.brandTitleLarge : styles.brandTitle;
  const subStyle = large ? styles.brandSubLarge : styles.brandSub;
  const logoBadge = large ? styles.logoBadgeLarge : styles.logoBadge;
  const panel = large ? styles.panelLarge : styles.panel;
  const panelLabel = large ? styles.panelLabelLarge : styles.panelLabel;
  const footStyle = large ? styles.footLarge : styles.foot;
  const footText = large ? styles.footTextLarge : styles.footText;
  const badge = large ? styles.modeBadgeLarge : styles.modeBadge;

  return (
    <View style={cardStyle} wrap={false}>
      {/* Hero */}
      <View style={heroStyle}>
        <GradientBg large={large} />
        <View style={logoBadge}>
          <Image style={styles.logoFill} src={mbkLogo} />
        </View>
        <View style={styles.brandBlock}>
          <Text style={titleStyle}>MBK International</Text>
          <Text style={subStyle}>FAMILY CARD</Text>
        </View>
        <View style={styles.heroSpacer} />
      </View>

      {/* Kids + family ID + parent phone */}
      <View style={panel}>
        <Text style={panelLabel}>{data.students.length === 1 ? 'CHILD' : 'CHILDREN'}</Text>
        {data.students.map(s => <KidRow key={s.id} student={s} large={large} />)}
        <View style={styles.divider} />
        <View style={large ? styles.rowLarge : styles.row} wrap={false}>
          <Badge char="#" color={MBK_BLUE_DARK} large={large} />
          <View style={styles.rowBody}>
            <Text style={large ? styles.rowNameLarge : styles.rowName}>{displayFamilyId(data.familyId)}</Text>
            <Text style={large ? styles.rowMetaLarge : styles.rowMeta}>Family ID</Text>
          </View>
        </View>
        <View style={large ? styles.rowLarge : styles.row} wrap={false}>
          <Badge char="P" color={MUTED} large={large} />
          <View style={styles.rowBody}>
            <Text style={large ? styles.rowNameLarge : styles.rowName}>{data.parentName || '—'}</Text>
            <Text style={large ? styles.rowMetaLarge : styles.rowMeta}>{data.parentPhone ? `Tel ${data.parentPhone}` : 'No phone'}</Text>
          </View>
        </View>
      </View>

      {/* Foot */}
      <View style={footStyle}>
        <Text style={footText}>2026–27</Text>
        <Text style={badge}>{familyTransportLabel(data.students)}</Text>
      </View>
    </View>
  );
}

/** Back side of one family card: large centered scanning QR + family id. */
function CardBack({ layout, data }: { layout: CardLayout; data: FamilyCardData }) {
  const large = layout === 'placard';
  const cardStyle = large ? styles.backCardLarge : styles.backCard;
  const idStyle = large ? styles.backIdLarge : styles.backId;
  const tagStyle = large ? styles.backIdTagLarge : styles.backIdTag;
  const capStyle = large ? styles.backCaptionLarge : styles.backCaption;
  const footer = large ? styles.backFooterLarge : styles.backFooter;
  const footerLogo = large ? styles.backFooterLogoLarge : styles.backFooterLogo;
  const footerName = large ? styles.backFooterNameLarge : styles.backFooterName;

  // Large scanning QR: ~62% of the shorter card dimension.
  const shortDim = large ? 105 : 60; // placard short edge 105mm; pocket short edge 60mm
  const qrMm = Math.round(shortDim * 0.62);
  const qrPath = buildQrPath(data.familyId);

  return (
    <View style={cardStyle} wrap={false}>
      <View style={styles.backTop}>
        <Text style={tagStyle}>FAMILY ID</Text>
        <Text style={idStyle}>{displayFamilyId(data.familyId)}</Text>
      </View>

      <View style={{ alignItems: 'center' }}>
        <Svg width={qrMm * MM} height={qrMm * MM} viewBox={`0 0 ${qrPath.size} ${qrPath.size}`}>
          <Path d={qrPath.d} fill="#000" />
        </Svg>
        <Text style={capStyle}>Present at gate for scanning.</Text>
      </View>

      <View style={footer}>
        <View style={footerLogo}>
          <Image style={styles.logoFill} src={mbkLogo} />
        </View>
        <Text style={footerName}>MBK International</Text>
      </View>
    </View>
  );
}

interface FamilyCardsDocumentProps {
  families: FamilyCardData[];
  layout: CardLayout;
  includeLookupList?: boolean;
}

/**
 * Mirror a flat array of card slots so the back of a duplex sheet aligns with
 * its front after a long-edge flip. We chunk the array into rows of `cols`,
 * reverse each row, then flatten. For short-edge flip, reverse the row order
 * instead of the columns (set `MIRROR_VERTICAL = true` above).
 */
function mirrorForLongEdge<T>(items: T[], cols: number): T[] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  if (MIRROR_VERTICAL) rows.reverse();
  else rows.forEach(r => r.reverse());
  return rows.flat();
}

function chunk<T>(items: T[], perPage: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
  return out;
}

export function FamilyCardsDocument({ families, layout, includeLookupList }: FamilyCardsDocumentProps) {
  const large = layout === 'placard';
  const cols = large ? 1 : COLS;
  const perPage = large ? 1 : PER_PAGE;

  // Front pages: render in natural order.
  const frontPages = chunk(families, perPage);
  // Back pages: same chunks, but cards inside each page are row-mirrored so
  // that after a long-edge flip each back aligns with its front.
  const backPages = chunk(families, perPage).map(page => mirrorForLongEdge(page, cols));

  return (
    <Document title={`MBK family cards (${layout})`}>
      {frontPages.map((page, i) => (
        <Page key={`f-${i}`} size="A4" style={large ? styles.placardPage : styles.gridPage}>
          {page.map(f => <CardFront key={`f-${i}-${f.familyId}`} layout={layout} data={f} />)}
        </Page>
      ))}
      {backPages.map((page, i) => (
        <Page key={`b-${i}`} size="A4" style={large ? styles.placardPage : styles.gridPage}>
          {page.map(f => <CardBack key={`b-${i}-${f.familyId}`} layout={layout} data={f} />)}
        </Page>
      ))}
      {includeLookupList && (
        <Page size="A4" style={styles.lookupPage}>
          <Text style={styles.lookupTitle}>Gate Lookup List — MBK Family IDs</Text>
          <Text style={styles.lookupSub}>Sorted by family ID. Gate staff: type the 4-digit number into /gate.</Text>
          {[...families]
            .sort((a, b) => a.familyId.localeCompare(b.familyId))
            .map(f => (
              <View style={styles.lookupRow} key={f.familyId} wrap={false}>
                <Text style={styles.lookupId}>{displayFamilyId(f.familyId)}</Text>
                <Text style={styles.lookupNames}>{f.students.map(s => s.name).join(', ')}</Text>
                <Text style={styles.lookupPhone}>{f.parentPhone || ''}</Text>
              </View>
            ))}
        </Page>
      )}
    </Document>
  );
}

/**
 * Build card data from grouped students. Purely synchronous data prep —
 * the QR is drawn as a vector path at render time (see CardFront / CardBack),
 * so there is no canvas, no async work, and no image payload to wait for.
 * `parentNames` is an optional map of parentId → profile name, used to
 * print the parent's name on the card.
 */
export async function buildFamilyCardData(groups: Map<string, Student[]>, parentNames?: Map<string, string>): Promise<FamilyCardData[]> {
  const out: FamilyCardData[] = [];
  for (const [familyId, students] of groups) {
    // A student who left the school keeps their familyId (so restoring them
    // rejoins the same family) but must never appear on a printed card.
    const active = students.filter(s => s.transport !== 'LEFT');
    if (active.length === 0) continue;
    const parentPhone =
      active.map(s => s.parentPhone ?? '').find(p => p.trim() !== '') ?? '';
    const parentId = active.map(s => s.parentId).find(Boolean) ?? null;
    out.push({
      familyId,
      students: [...active].sort((a, b) => a.name.localeCompare(b.name)),
      parentPhone,
      parentName: (parentId && parentNames?.get(parentId)) || '',
    });
  }
  return out.sort((a, b) => a.familyId.localeCompare(b.familyId));
}
