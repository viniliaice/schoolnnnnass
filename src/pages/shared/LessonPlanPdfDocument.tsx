import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { DAYS_OF_WEEK, LessonPlan, LessonPlanPeriod, AIReview, PeriodActivity, UnitPlan, Subject, LessonPeriodAIReview } from '../../types';
import { summarizeDay } from '../../lib/lessonPlanReview';

const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const BLUE = '#1d4ed8';
const BLUE_DARK = '#1e3a8a';

// Do not register remote/browser fonts here. @react-pdf supports built-in
// Helvetica reliably in both dev and production; remote .woff files caused
// "Unknown font format" crashes in PDF export. If a custom font is added later,
// register a local .ttf only and keep this built-in fallback.
const FONT_FAMILY = 'Helvetica';

function assertFinitePdfNumber(label: string, value: unknown) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${label} is not finite: ${String(value)}`);
  }
  if (typeof value === 'number' && Math.abs(value) > 10_000) {
    throw new Error(`${label} is suspiciously large: ${value}`);
  }
  if (typeof value === 'string' && /%$/.test(value.trim())) {
    throw new Error(`${label} uses an unsafe percentage value: ${value}`);
  }
}

function safeWidth(label: string, value: number, min = 0, max = 430): number {
  try {
    assertFinitePdfNumber(label, value);
    return Math.max(min, Math.min(max, value));
  } catch (err) {
    console.error('[LessonPlanPdf] invalid dynamic width', { label, value, err });
    return min;
  }
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 74,
    paddingBottom: 54,
    paddingHorizontal: 34,
    fontFamily: FONT_FAMILY,
    fontSize: 10.5,
    color: INK,
    lineHeight: 1.45,
    backgroundColor: '#ffffff',
  },
  fixedHeader: {
    position: 'absolute',
    top: 24,
    left: 34,
    right: 34,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  fixedFooter: {
    position: 'absolute',
    bottom: 22,
    left: 34,
    right: 34,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: LINE,
    flexDirection: 'row',
    justifyContent: 'space-between',
    color: MUTED,
    fontSize: 8.5,
  },
  headerTitle: { fontSize: 12, fontWeight: 'bold', color: BLUE_DARK },
  headerMeta: { fontSize: 8.5, color: MUTED, marginTop: 2 },
  pageNumber: { fontSize: 8.5, color: MUTED },

  hero: {
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 12,
    padding: 16,
    marginBottom: 18,
    backgroundColor: '#eff6ff',
  },
  title: { fontSize: 22, fontWeight: 'bold', color: '#172554', marginBottom: 6 },
  subtitle: { fontSize: 11, color: '#334155', marginBottom: 2 },
  statusPill: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#ffffff',
    color: BLUE_DARK,
    fontSize: 9,
    fontWeight: 'bold',
  },

  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: 'bold', marginBottom: 9, color: '#1e293b' },
  dayCard: {
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 12,
    marginBottom: 14,
    overflow: 'hidden',
  },
  dayHeader: { padding: 12, backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: LINE },
  dayTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  dayName: { fontSize: 15, fontWeight: 'bold', color: '#0f172a' },
  dayPercent: { fontSize: 11, fontWeight: 'bold', color: BLUE },
  statRow: { flexDirection: 'row', marginBottom: 7 },
  statPill: { borderRadius: 7, backgroundColor: '#ffffff', paddingHorizontal: 8, paddingVertical: 4, marginRight: 6, fontSize: 9, color: '#334155' },
  progressTrack: { height: 5, borderRadius: 20, backgroundColor: '#e2e8f0' },
  progressFill: { height: 5, borderRadius: 20, backgroundColor: BLUE },

  periodCard: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  periodTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  periodBadge: {
    width: 26,
    height: 24,
    borderRadius: 7,
    backgroundColor: '#eef2ff',
    color: '#3730a3',
    fontSize: 10,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingTop: 6,
  },
  periodTitle: { flex: 1, fontSize: 13, fontWeight: 'bold', color: INK, marginLeft: 8 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  tag: { borderRadius: 6, backgroundColor: '#f1f5f9', color: '#475569', paddingHorizontal: 7, paddingVertical: 3, marginRight: 5, marginBottom: 4, fontSize: 8.5, fontWeight: 'bold' },
  label: { fontSize: 9, fontWeight: 'bold', color: '#334155', marginTop: 4, marginBottom: 2 },
  body: { fontSize: 10, color: '#334155', lineHeight: 1.5 },
  activity: { fontSize: 9.5, color: '#475569', marginBottom: 2, lineHeight: 1.45 },
  freeText: { fontSize: 10.5, color: MUTED, fontStyle: 'italic' },

  coachBox: { marginTop: 8, borderRadius: 9, padding: 9, borderWidth: 1 },
  coachFull: { borderColor: '#bbf7d0', backgroundColor: '#f0fdf4' },
  coachPartial: { borderColor: '#fde68a', backgroundColor: '#fffbeb' },
  coachNone: { borderColor: '#fecdd3', backgroundColor: '#fff1f2' },
  coachUnknown: { borderColor: LINE, backgroundColor: '#f8fafc' },
  coachTitle: { fontSize: 9.5, fontWeight: 'bold', color: '#1e293b', marginBottom: 3 },
  coachBody: { fontSize: 9.5, color: '#334155', lineHeight: 1.45 },
  coachReason: { fontSize: 8.5, color: MUTED, marginTop: 3 },
  coachGap: { fontSize: 8.5, color: '#334155', marginTop: 5, padding: 6, borderRadius: 6, backgroundColor: '#ffffff' },
  suggestionBox: { marginTop: 7, borderRadius: 7, backgroundColor: '#ffffff', padding: 7 },
  suggestionTitle: { fontSize: 8.5, fontWeight: 'bold', color: '#334155', marginBottom: 3 },
  suggestionItem: { fontSize: 8.7, color: '#334155', lineHeight: 1.35, marginBottom: 2 },

  reviewSummary: { borderWidth: 1, borderColor: '#c7d2fe', backgroundColor: '#eef2ff', borderRadius: 12, padding: 12, marginBottom: 12 },
  reviewScore: { fontSize: 16, fontWeight: 'bold', color: '#3730a3', marginBottom: 4 },
  summary: { fontSize: 10.5, color: '#334155', lineHeight: 1.5 },
  scoreGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  scoreItem: { width: 160, backgroundColor: '#f8fafc', borderRadius: 9, borderWidth: 1, borderColor: '#e2e8f0', padding: 8, marginBottom: 7 },
  scoreLabel: { fontSize: 8.5, color: MUTED, marginBottom: 3, textTransform: 'capitalize' },
  scoreValue: { fontSize: 14, fontWeight: 'bold', color: INK },
  scoreExplanation: { fontSize: 8, color: '#475569', marginTop: 3, lineHeight: 1.35 },
  listItem: { fontSize: 9.5, color: '#475569', marginBottom: 3, lineHeight: 1.4 },
  improvementItem: { backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a', borderRadius: 9, padding: 8, marginBottom: 6 },
  improvementArea: { fontSize: 10, fontWeight: 'bold', color: '#92400e' },
  improvementText: { fontSize: 9, color: '#92400e', marginTop: 2, lineHeight: 1.4 },
});

function auditLessonPlanPdfStyles() {
  try {
    Object.entries(styles).forEach(([styleName, styleValue]) => {
      Object.entries(styleValue as Record<string, unknown>).forEach(([key, value]) => {
        if (key === 'gap') throw new Error(`${styleName}.${key}: gap is not allowed in LessonPlanPdfDocument`);
        assertFinitePdfNumber(`${styleName}.${key}`, value);
      });
    });
  } catch (err) {
    console.error('[LessonPlanPdf] unsafe static style value', err);
    throw err;
  }
}

auditLessonPlanPdfStyles();

interface LessonPlanPdfDocumentProps {
  plan: LessonPlan;
  periods: LessonPlanPeriod[];
  review?: AIReview | null;
  unitPlans?: UnitPlan[];
  subjects?: Subject[];
  periodAiReviews?: LessonPeriodAIReview[];
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function alignmentStyle(status: LessonPeriodAIReview['alignment_status'] | undefined) {
  if (status === 'fully_aligned') return [styles.coachBox, styles.coachFull];
  if (status === 'partially_aligned') return [styles.coachBox, styles.coachPartial];
  if (status === 'not_aligned') return [styles.coachBox, styles.coachNone];
  return [styles.coachBox, styles.coachUnknown];
}

function pdfAlignmentLabel(status: LessonPeriodAIReview['alignment_status'] | undefined): string {
  if (status === 'fully_aligned') return 'Fully Aligned';
  if (status === 'partially_aligned') return 'Partially Aligned';
  if (status === 'not_aligned') return 'Not Aligned';
  return 'AI Review Pending';
}

function pdfRevisionLabel(status: LessonPeriodAIReview['revision_status'] | undefined): string {
  if (status === 'included') return 'Revision included';
  if (status === 'missing') return 'Revision missing';
  return 'Revision not applicable';
}

const DAY_ORDER: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
function reviewOrder(period: Pick<LessonPlanPeriod, 'day' | 'period_number'>): number {
  return (DAY_ORDER[period.day] ?? 99) * 10 + period.period_number;
}

function inferSubjectFromUnitName(value: string): string | null {
  const text = value.toLowerCase();
  if (/math|addition|subtraction|multiplication|division|numeracy/.test(text)) return 'Mathematics';
  if (/english|literacy|reading|writing|grammar|language/.test(text)) return 'English';
  if (/science|biology|chemistry|physics|environment/.test(text)) return 'Science';
  if (/arabic|quran|qur/.test(text)) return 'Arabic';
  if (/social|history|geography|civic|somali|islamic/.test(text)) return 'Social Studies';
  return null;
}

function subjectName(subjects: Subject[] | undefined, value: string | null | undefined, unitPlans: UnitPlan[] = []): string {
  if (!value) return 'Subject —';
  const match = subjects?.find((subject) => subject.id === value);
  if (match) return match.name;
  const unitMatch = unitPlans.find((unit) => unit.subject_id === value);
  const inferred = unitMatch ? inferSubjectFromUnitName(`${unitMatch.name} ${unitMatch.objectives}`) : null;
  if (inferred) return inferred;
  return value.startsWith('subject-') ? 'Subject' : value;
}

function activityLines(period: LessonPlanPeriod): string[] {
  const details: PeriodActivity[] = period.details || [];
  if (details.length) {
    return details.map((a, i) => `${i + 1}. ${a.activity || '—'}${a.time ? ` (${a.time})` : ''}${a.resource ? ` [${a.resource}]` : ''}${a.place ? ` @${a.place}` : ''}`);
  }
  return period.activities ? [period.activities] : [];
}

function PeriodBlock({ period, unitPlans, subjects, periodReview }: { period: LessonPlanPeriod; unitPlans: UnitPlan[]; subjects?: Subject[]; periodReview?: LessonPeriodAIReview }) {
  const isFree = !!period.is_free || period.subject === '__FREE__';
  const activities = activityLines(period);

  return (
    <View style={styles.periodCard}>
      <View style={styles.periodTop}>
        <Text style={styles.periodBadge}>P{period.period_number}</Text>
        <Text style={styles.periodTitle}>{isFree ? 'Free period' : period.topic || 'No topic entered'}</Text>
      </View>

      {!isFree && (
        <>
          <View style={styles.tagRow}>
            <Text style={styles.tag}>{subjectName(subjects, period.subject, unitPlans)}</Text>
            <Text style={styles.tag}>Class {period.class_name || '—'}</Text>
            {period.slide_number && <Text style={styles.tag}>Page {period.slide_number}</Text>}
          </View>
          {period.objective && (
            <>
              <Text style={styles.label}>Objective</Text>
              <Text style={styles.body}>{period.objective}</Text>
            </>
          )}
          {activities.length > 0 && (
            <>
              <Text style={styles.label}>Activities</Text>
              {activities.map((activity, index) => <Text key={index} style={styles.activity}>{activity}</Text>)}
            </>
          )}
        </>
      )}

      {isFree && <Text style={styles.freeText}>No instructional activities scheduled.</Text>}

      <View style={alignmentStyle(periodReview?.alignment_status)}>
        <Text style={styles.coachTitle}>AI Review: {pdfAlignmentLabel(periodReview?.alignment_status)} · {pdfRevisionLabel(periodReview?.revision_status)}</Text>
        <Text style={styles.coachBody}>{periodReview?.review_text || 'No saved period AI review yet. Supervisors can regenerate the AI review for this plan.'}</Text>
        {periodReview?.alignment_reason && <Text style={styles.coachReason}>{periodReview.alignment_reason}</Text>}
        {periodReview?.revision_reason && <Text style={styles.coachReason}>{periodReview.revision_reason}</Text>}
        {periodReview?.alignment_status !== 'fully_aligned' && periodReview?.alignment_gap && (
          <Text style={styles.coachGap}>Alignment gap: {periodReview.alignment_gap}</Text>
        )}
        {!!periodReview?.suggested_activities?.length && (
          <View style={styles.suggestionBox}>
            <Text style={styles.suggestionTitle}>Suggested Activities</Text>
            {periodReview.suggested_activities.map((activity, index) => (
              <Text key={activity} style={styles.suggestionItem}>{index + 1}. {activity}</Text>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function DaySection({ day, periods, periodCount, unitPlans, subjects, periodAiReviews }: { day: string; periods: LessonPlanPeriod[]; periodCount: number; unitPlans: UnitPlan[]; subjects?: Subject[]; periodAiReviews: LessonPeriodAIReview[] }) {
  const dayPeriods = Array.from({ length: periodCount }, (_, pi) =>
    periods.find((p) => p.day === day && p.period_number === pi + 1) ?? ({
      id: `${day}-${pi + 1}-missing`,
      plan_id: '',
      day: day as LessonPlanPeriod['day'],
      period_number: pi + 1,
      class_name: null,
      subject: null,
      is_free: true,
      topic: '',
      objective: null,
      activities: '',
      slide_number: null,
      details: [],
      sort_order: pi + 1,
      created_at: '',
      updated_at: '',
    } satisfies LessonPlanPeriod)
  );
  const summary = summarizeDay(dayPeriods, periodCount);

  return (
    <View style={styles.dayCard}>
      <View style={styles.dayHeader} wrap={false}>
        <View style={styles.dayTop}>
          <Text style={styles.dayName}>{day}</Text>
          <Text style={styles.dayPercent}>{summary.percent}% complete</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statPill}>{summary.planned} planned</Text>
          <Text style={styles.statPill}>{summary.free} free</Text>
          <Text style={styles.statPill}>{summary.total} total periods</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: safeWidth(`${day}.progressWidth`, summary.percent * 4.3, 1, 430) }]} />
        </View>
      </View>
      {dayPeriods.map((period) => (
        <PeriodBlock
          key={`${period.day}-${period.period_number}`}
          period={period}
          unitPlans={unitPlans}
          subjects={subjects}
          periodReview={periodAiReviews.find((review) => review.period_order === reviewOrder(period))}
        />
      ))}
    </View>
  );
}

export function LessonPlanPdfDocument({ plan, periods, review, unitPlans = [], subjects, periodAiReviews = [] }: LessonPlanPdfDocumentProps) {
  return (
    <Document title={`${plan.title} — ${plan.class_name} ${plan.week_label}`}>
      <Page size="A4" style={styles.page} wrap>
        <View fixed style={styles.fixedHeader}>
          <View>
            <Text style={styles.headerTitle}>MBK Lesson Plan Review</Text>
            <Text style={styles.headerMeta}>{plan.class_name} · {plan.week_label}</Text>
          </View>
          <Text style={styles.pageNumber} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>

        <View fixed style={styles.fixedFooter}>
          <Text>MBK International School</Text>
          <Text>{formatStatus(plan.status)}</Text>
        </View>

        <View style={styles.hero} wrap={false}>
          <Text style={styles.title}>{plan.title}</Text>
          <Text style={styles.subtitle}>{plan.class_name} · {plan.week_label} · {plan.period_count} periods/day</Text>
          <Text style={styles.subtitle}>Generated for supervisor review and print export.</Text>
          <Text style={styles.statusPill}>Status: {formatStatus(plan.status)}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Weekly Lesson Plan</Text>
          {DAYS_OF_WEEK.map((day) => (
            <DaySection key={day} day={day} periods={periods} periodCount={plan.period_count} unitPlans={unitPlans} subjects={subjects} periodAiReviews={periodAiReviews} />
          ))}
        </View>

        {review && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Overall AI Review</Text>
            <View style={styles.reviewSummary} wrap={false}>
              <Text style={styles.reviewScore}>{review.percentage}% · {review.performance_level}</Text>
              <Text style={styles.summary}>{review.executive_summary}</Text>
            </View>

            <View style={styles.scoreGrid}>
              {Object.entries(review.scores).map(([key, val]: [string, any]) => (
                <View key={key} style={styles.scoreItem} wrap={false}>
                  <Text style={styles.scoreLabel}>{key.replace(/_/g, ' ')}</Text>
                  <Text style={styles.scoreValue}>{val.score}/5</Text>
                  <Text style={styles.scoreExplanation}>{val.explanation}</Text>
                </View>
              ))}
            </View>

            {review.strengths.length > 0 && (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.sectionTitle}>Strengths</Text>
                {review.strengths.map((s, i) => (
                  <Text key={i} style={styles.listItem}>• {s}</Text>
                ))}
              </View>
            )}

            {review.improvements.length > 0 && (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.sectionTitle}>Improvements</Text>
                {review.improvements.map((imp, i) => (
                  <View key={i} style={styles.improvementItem} wrap={false}>
                    <Text style={styles.improvementArea}>{imp.area}</Text>
                    <Text style={styles.improvementText}>{imp.why}</Text>
                    <Text style={styles.improvementText}>{imp.recommendation}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </Page>
    </Document>
  );
}
