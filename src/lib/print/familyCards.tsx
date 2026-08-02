// Printable family cards + gate lookup list for the family-ID feature.
//
// Three layouts (design decision 7): pocket (85×54mm, car-line + general),
// lanyard (60×90mm portrait, walkers), placard (148×105mm landscape A5,
// windshield/rearview mirror). The QR is generated as a PNG data URL with the
// `qrcode` package and embedded — same 4-digit family ID in every layout; the
// 'MBK-' prefix appears only here, on the printed artifact (decision 8).
//
// Print specs (design decision 7): body ≥10pt, QR ≥25mm quiet zone, black-on-
// white contrast, MBK green (#0F4C3A) header band, gold (#C8A24A) accents.

import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import QRCode from 'qrcode';
import type { Student } from '../../types';
import { displayFamilyId, transportLabel } from '../transport';

export type CardLayout = 'pocket' | 'lanyard' | 'placard';

export interface FamilyCardData {
  familyId: string;
  students: Student[];
  parentPhone: string;
  /** QR PNG data URL, populated by buildFamilyCardData(). */
  qrDataUrl?: string;
}

const MBK_GREEN = '#0F4C3A';
const MBK_GOLD = '#C8A24A';
const INK = '#111827';
const MUTED = '#6b7280';

const MM = 2.83465; // 1mm in pt

const styles = StyleSheet.create({
  pocketPage: { flexDirection: 'row', flexWrap: 'wrap', padding: 10 * MM },
  lanyardPage: { flexDirection: 'row', flexWrap: 'wrap', padding: 10 * MM },
  placardPage: { padding: 6 * MM },
  lookupPage: { padding: 14 * MM },

  pocketCard: {
    width: 85 * MM, height: 54 * MM,
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4,
    margin: 3 * MM, overflow: 'hidden',
  },
  lanyardCard: {
    width: 60 * MM, height: 90 * MM,
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4,
    margin: 3 * MM, overflow: 'hidden',
  },
  placardCard: {
    width: 148 * MM, height: 105 * MM,
    borderWidth: 2, borderColor: '#9ca3af', borderRadius: 6,
    marginBottom: 6 * MM, overflow: 'hidden',
  },

  cardHeader: { backgroundColor: MBK_GREEN, paddingVertical: 2.5 * MM, paddingHorizontal: 3 * MM, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  schoolName: { color: '#ffffff', fontSize: 6.5, fontWeight: 'bold', letterSpacing: 0.4 },
  schoolNameLarge: { color: '#ffffff', fontSize: 9, fontWeight: 'bold', letterSpacing: 0.5 },
  yearBadge: { color: '#ffffff', backgroundColor: 'rgba(255,255,255,0.18)', fontSize: 5.5, paddingHorizontal: 2.5, paddingVertical: 1, borderRadius: 2 },

  cardBody: { padding: 3 * MM, flex: 1 },
  cardBodyWide: { padding: 5 * MM, flex: 1 },
  familyId: { fontSize: 15, fontWeight: 'bold', textAlign: 'center', letterSpacing: 1.2, color: INK },
  familyIdLarge: { fontSize: 26, fontWeight: 'bold', textAlign: 'center', letterSpacing: 2, color: INK },
  qrWrap: { alignItems: 'center', marginVertical: 1.5 * MM },
  qrImage: { width: 22 * MM, height: 22 * MM },
  qrImageLarge: { width: 34 * MM, height: 34 * MM },
  qrCap: { fontSize: 4.5, color: MUTED, marginTop: 0.5 * MM },
  qrCapLarge: { fontSize: 6, color: MUTED, marginTop: 1 * MM },

  kids: { borderTopWidth: 0.5, borderTopColor: '#e5e7eb', marginTop: 1.5 * MM, paddingTop: 1.5 * MM },
  kidRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 0.8 * MM },
  kidName: { fontSize: 6, fontWeight: 'bold', color: INK },
  kidNameLarge: { fontSize: 9, fontWeight: 'bold', color: INK },
  kidMeta: { fontSize: 5, color: MUTED },
  kidMetaLarge: { fontSize: 7.5, color: MUTED },

  cardFoot: { backgroundColor: '#f3f4f6', paddingVertical: 1.8 * MM, paddingHorizontal: 3 * MM, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  phone: { fontSize: 5.5, color: '#374151' },
  phoneLarge: { fontSize: 8, color: '#374151' },
  modeBadge: { fontSize: 5.5, color: MBK_GREEN, borderWidth: 0.6, borderColor: MBK_GOLD, borderRadius: 2, paddingHorizontal: 2, paddingVertical: 0.5, fontWeight: 'bold' },
  modeBadgeLarge: { fontSize: 8, color: MBK_GREEN, borderWidth: 0.8, borderColor: MBK_GOLD, borderRadius: 2, paddingHorizontal: 3, paddingVertical: 1, fontWeight: 'bold' },

  lookupTitle: { fontSize: 12, fontWeight: 'bold', marginBottom: 6, color: INK },
  lookupSub: { fontSize: 7, color: MUTED, marginBottom: 8 },
  lookupRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb', paddingVertical: 3, fontSize: 7 },
  lookupId: { width: 30 * MM, fontWeight: 'bold' },
  lookupNames: { flex: 1 },
  lookupPhone: { width: 38 * MM, textAlign: 'right', color: MUTED },
});

function kidLine(student: Student, large: boolean) {
  const name = large ? styles.kidNameLarge : styles.kidName;
  const meta = large ? styles.kidMetaLarge : styles.kidMeta;
  return (
    <View style={styles.kidRow} key={student.id}>
      <Text style={name}>{student.name}</Text>
      <Text style={meta}>{student.className} · {transportLabel(student.transport)}</Text>
    </View>
  );
}

function CardShell({ layout, data }: { layout: CardLayout; data: FamilyCardData }) {
  const large = layout === 'placard';
  const cardStyle = layout === 'pocket' ? styles.pocketCard : layout === 'lanyard' ? styles.lanyardCard : styles.placardCard;
  const bodyStyle = large ? styles.cardBodyWide : styles.cardBody;
  const nameStyle = large ? styles.schoolNameLarge : styles.schoolName;
  const idStyle = large ? styles.familyIdLarge : styles.familyId;
  const qr = large ? styles.qrImageLarge : styles.qrImage;
  const qrCap = large ? styles.qrCapLarge : styles.qrCap;
  const phone = large ? styles.phoneLarge : styles.phone;
  const badge = large ? styles.modeBadgeLarge : styles.modeBadge;

  return (
    <View style={cardStyle} wrap={false}>
      <View style={styles.cardHeader}>
        <Text style={nameStyle}>MBK INTERNATIONAL</Text>
        <Text style={styles.yearBadge}>2026–27</Text>
      </View>
      <View style={bodyStyle}>
        <Text style={idStyle}>{displayFamilyId(data.familyId)}</Text>
        <View style={styles.qrWrap}>
          {data.qrDataUrl && <Image src={data.qrDataUrl} style={qr} />}
          <Text style={qrCap}>scan = {data.familyId}</Text>
        </View>
        <View style={styles.kids}>
          {data.students.map(s => kidLine(s, large))}
        </View>
      </View>
      <View style={styles.cardFoot}>
        <Text style={phone}>{data.parentPhone ? `Tal: ${data.parentPhone}` : ''}</Text>
        <Text style={badge}>{data.students[0]?.transport ? transportLabel(data.students[0].transport) : 'GAAR / CAR'}</Text>
      </View>
    </View>
  );
}

interface FamilyCardsDocumentProps {
  families: FamilyCardData[];
  layout: CardLayout;
  includeLookupList?: boolean;
}

export function FamilyCardsDocument({ families, layout, includeLookupList }: FamilyCardsDocumentProps) {
  return (
    <Document title={`MBK family cards (${layout})`}>
      {layout === 'placard' ? (
        <Page size="A4" style={styles.placardPage}>
          {families.map(f => <CardShell key={f.familyId} layout="placard" data={f} />)}
        </Page>
      ) : (
        <Page size="A4" style={layout === 'pocket' ? styles.pocketPage : styles.lanyardPage}>
          {families.map(f => <CardShell key={f.familyId} layout={layout} data={f} />)}
        </Page>
      )}
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
 * Build card data from grouped students. The QR data URL is computed up
 * front (async) so the Document can embed it as an image.
 */
export async function buildFamilyCardData(groups: Map<string, Student[]>): Promise<FamilyCardData[]> {
  const out: FamilyCardData[] = [];
  for (const [familyId, students] of groups) {
    const parentPhone =
      students.map(s => s.parentPhone ?? '').find(p => p.trim() !== '') ?? '';
    out.push({
      familyId,
      students: [...students].sort((a, b) => a.name.localeCompare(b.name)),
      parentPhone,
      qrDataUrl: await QRCode.toDataURL(familyId, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 220,
        color: { dark: '#000000', light: '#ffffff' },
      }),
    });
  }
  return out.sort((a, b) => a.familyId.localeCompare(b.familyId));
}
