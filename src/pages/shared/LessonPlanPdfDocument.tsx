import { Document, Page, Text, View, StyleSheet, Font } from '@react-pdf/renderer';
import { DAYS_OF_WEEK, LessonPlan, LessonPlanPeriod, AIReview, PeriodActivity } from '../../types';

Font.register({
  family: 'Helvetica',
  fonts: [
    { src: 'https://fonts.cdnfonts.com/s/29107/HelveticaNeue.woff', fontWeight: 'normal' },
    { src: 'https://fonts.cdnfonts.com/s/29107/HelveticaNeueBd.woff', fontWeight: 'bold' },
  ],
});

const styles = StyleSheet.create({
  page: { padding: 30, fontFamily: 'Helvetica', fontSize: 10 },
  header: { marginBottom: 20 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 4 },
  subtitle: { fontSize: 10, color: '#64748b', marginBottom: 2 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: 'bold', marginBottom: 8, color: '#1e293b' },
  grid: { width: '100%' },
  gridHeader: { flexDirection: 'row', backgroundColor: '#f8fafc', borderBottomWidth: 1, borderBottomColor: '#e2e8f0', paddingVertical: 4 },
  gridRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f1f5f9', paddingVertical: 4 },
  cellPeriod: { width: 20, paddingHorizontal: 4, fontWeight: 'bold', color: '#94a3b8', fontSize: 8 },
  cellDay: { flex: 1, paddingHorizontal: 4 },
  cellTopic: { fontWeight: 'medium', fontSize: 9 },
  cellObjective: { fontSize: 8, color: '#64748b', marginTop: 1, fontStyle: 'italic' },
  cellActivities: { fontSize: 8, color: '#64748b', marginTop: 1 },
  cellSlide: { fontSize: 7, color: '#94a3b8', marginTop: 1 },
  scoreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  scoreItem: { width: '20%', backgroundColor: '#f8fafc', padding: 6, marginBottom: 4 },
  scoreLabel: { fontSize: 8, color: '#64748b', marginBottom: 2, textTransform: 'capitalize' },
  scoreValue: { fontSize: 14, fontWeight: 'bold' },
  scoreExplanation: { fontSize: 7, color: '#94a3b8', marginTop: 2 },
  summary: { fontSize: 10, color: '#475569', lineHeight: 1.5, marginBottom: 8 },
  badge: { fontSize: 9, color: '#059669', marginBottom: 4 },
  list: { marginLeft: 12 },
  listItem: { fontSize: 9, color: '#475569', marginBottom: 2 },
  improvementItem: { backgroundColor: '#fffbeb', padding: 6, marginBottom: 4 },
  improvementArea: { fontSize: 9, fontWeight: 'bold', color: '#92400e' },
  improvementWhy: { fontSize: 8, color: '#b45309' },
  improvementRec: { fontSize: 8, color: '#d97706', marginTop: 1 },
});

interface LessonPlanPdfDocumentProps {
  plan: LessonPlan;
  periods: LessonPlanPeriod[];
  review?: AIReview | null;
}

export function LessonPlanPdfDocument({ plan, periods, review }: LessonPlanPdfDocumentProps) {
  const periodList = Array.from({ length: plan.period_count }, (_, pi) => pi + 1);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>{plan.title}</Text>
          <Text style={styles.subtitle}>{plan.class_name} &middot; {plan.week_label}</Text>
          <Text style={styles.subtitle}>Status: {plan.status.replace('_', ' ')}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Lesson Plan</Text>
          <View style={styles.grid}>
            <View style={styles.gridHeader}>
              <Text style={styles.cellPeriod}>#</Text>
              {DAYS_OF_WEEK.map((day) => (
                <Text key={day} style={styles.cellDay}>{day}</Text>
              ))}
            </View>
            {periodList.map((pi) => (
              <View key={pi} style={styles.gridRow}>
                <Text style={styles.cellPeriod}>P{pi}</Text>
                {DAYS_OF_WEEK.map((day) => {
                  const period = periods.find((p) => p.day === day && p.period_number === pi);
                  const details: PeriodActivity[] = period?.details || [];
                  return (
                    <View key={day} style={styles.cellDay}>
                      <Text style={styles.cellTopic}>{period?.topic || '—'}</Text>
                      {period?.objective && <Text style={styles.cellObjective}>Obj: {period.objective}</Text>}
                      {details.length > 0 ? (
                        details.map((a, i) => (
                          <Text key={i} style={styles.cellActivities}>
                            {i + 1}. {a.activity}{a.time ? ` (${a.time})` : ''}{a.resource ? ` [{a.resource}]` : ''}{a.place ? ` @{a.place}` : ''}
                          </Text>
                        ))
                      ) : period?.activities ? (
                        <Text style={styles.cellActivities}>{period.activities}</Text>
                      ) : null}
                      {period?.slide_number && <Text style={styles.cellSlide}>Slide: {period.slide_number}</Text>}
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        </View>

        {review && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>AI Review</Text>
            <Text style={styles.badge}>{review.percentage}% &middot; {review.performance_level}</Text>
            <Text style={styles.summary}>{review.executive_summary}</Text>

            <View style={styles.scoreGrid}>
              {Object.entries(review.scores).map(([key, val]: [string, any]) => (
                <View key={key} style={styles.scoreItem}>
                  <Text style={styles.scoreLabel}>{key.replace(/_/g, ' ')}</Text>
                  <Text style={styles.scoreValue}>{val.score}/5</Text>
                  <Text style={styles.scoreExplanation}>{val.explanation}</Text>
                </View>
              ))}
            </View>

            {review.strengths.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 8 }]}>Strengths</Text>
                <View style={styles.list}>
                  {review.strengths.map((s, i) => (
                    <Text key={i} style={styles.listItem}>• {s}</Text>
                  ))}
                </View>
              </>
            )}

            {review.improvements.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 8 }]}>Improvements</Text>
                {review.improvements.map((imp, i) => (
                  <View key={i} style={styles.improvementItem}>
                    <Text style={styles.improvementArea}>{imp.area}</Text>
                    <Text style={styles.improvementWhy}>{imp.why}</Text>
                    <Text style={styles.improvementRec}>{imp.recommendation}</Text>
                  </View>
                ))}
              </>
            )}
          </View>
        )}
      </Page>
    </Document>
  );
}
