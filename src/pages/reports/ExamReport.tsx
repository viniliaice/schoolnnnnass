import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import {
  getStudents,
  getStudentById,
  getStudentsByClasses,
  getStudentsByClass,
  getStudentsByParent,
} from '../../lib/db/students';
import { getUserById } from '../../lib/db/profiles';
import { getClasses } from '../../lib/db/classes';
import { getCurrentTerm, getAcademicYears, getTerms } from '../../lib/db/academic';
import {
  getMonthlyReport,
  getMidtermReport,
  getFinalReport,
  getReportComment,
  upsertReportComment,
  getReportCommentsForStudentTerm,
} from '../../lib/db/reports';
import type { ReportComment } from '../../types';
import { Student, MONTHS, MonthlyScore, AcademicYear, Term } from '../../types';
import { pdf, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { MidtermReport, FinalReport } from '../../types';
import {
  FileBarChart,
  ChevronDown,
  ChevronUp,
  Save,
  Download,
  Share2,
  MessageCircle,
  FileText,
  Printer,
  Eye,
  X,
  Check,
  Loader2,
  AlertCircle,
  Users,
  Award,
  Calendar as CalendarIcon,
  BookOpen,
  MoreVertical,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatReportPercent, overallMonthlyAverage } from '../../lib/monthlyReport';
import { MonthlyScoresTable } from './MonthlyScoresTable';
import { normalizeSomaliPhoneToWa, formatInternationalPhone, isValidPhone, buildWhatsAppLink, buildReportWhatsAppMessage } from '../../lib/whatsapp';

// ============================================================================
// PDF Document — professional, print-ready, multi-page
// ============================================================================

const pdfStyles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 36,
    paddingHorizontal: 32,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: '#1e293b',
    backgroundColor: '#ffffff',
    lineHeight: 1.5,
  },
  headerBand: {
    backgroundColor: '#1e3a8a',
    marginTop: -28,
    marginHorizontal: -32,
    paddingHorizontal: 32,
    paddingTop: 20,
    paddingBottom: 16,
    marginBottom: 16,
  },
  schoolName: { fontSize: 13, fontWeight: 'bold', color: '#ffffff', letterSpacing: 0.5, textAlign: 'center' },
  schoolSub: { fontSize: 8, color: '#cbd5e1', textAlign: 'center', marginTop: 2, letterSpacing: 0.8, textTransform: 'uppercase' },
  reportTitle: { fontSize: 16, fontWeight: 'bold', color: '#ffffff', textAlign: 'center', marginTop: 10 },
  reportSubtitle: { fontSize: 9, color: '#e0e7ff', textAlign: 'center', marginTop: 4 },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  metaCard: {
    width: '48%',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    padding: 8,
  },
  metaLabel: { fontSize: 7, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 'bold' },
  metaValue: { fontSize: 9, color: '#0f172a', fontWeight: 'bold', marginTop: 2 },
  averageCard: {
    backgroundColor: '#1e3a8a',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  averageLabel: { fontSize: 8, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 },
  averageValue: { fontSize: 26, fontWeight: 'bold', color: '#ffffff' },
  averageSub: { fontSize: 7, color: '#93c5fd', marginTop: 2 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1e3a8a',
    borderBottomWidth: 1.5,
    borderBottomColor: '#1e3a8a',
    paddingBottom: 4,
    marginTop: 14,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#1e3a8a',
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  th: { fontSize: 7, fontWeight: 'bold', color: '#ffffff', textTransform: 'uppercase', letterSpacing: 0.4 },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  tableRowAlt: { backgroundColor: '#f8fafc' },
  td: { fontSize: 8, color: '#334155' },
  tdBold: { fontSize: 8, color: '#0f172a', fontWeight: 'bold' },
  badge: {
    backgroundColor: '#e0e7ff',
    color: '#1e3a8a',
    fontSize: 7,
    fontWeight: 'bold',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    textAlign: 'center',
  },
  badgeSuccess: { backgroundColor: '#dcfce7', color: '#166534' },
  badgeWarn: { backgroundColor: '#fef9c3', color: '#854d0e' },
  badgeDanger: { backgroundColor: '#fee2e2', color: '#991b1b' },
  detailSection: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    marginBottom: 8,
    overflow: 'hidden',
  },
  detailHeader: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  detailSubject: { fontSize: 9, fontWeight: 'bold', color: '#1e293b', textTransform: 'uppercase' },
  detailAvg: { fontSize: 9, fontWeight: 'bold', color: '#1e3a8a' },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#f1f5f9',
  },
  detailLabel: { fontSize: 8, color: '#475569' },
  detailScore: { fontSize: 8, color: '#334155', fontWeight: 'bold' },
  detailPercent: { fontSize: 8, color: '#64748b', minWidth: 32, textAlign: 'right' },
  footer: {
    position: 'absolute',
    bottom: 12,
    left: 32,
    right: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 6,
  },
  footerText: { fontSize: 7, color: '#94a3b8' },
  pageNumber: { fontSize: 7, color: '#64748b', textAlign: 'right' },
  commentBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 6,
    padding: 10,
    marginTop: 8,
  },
  commentLabel: { fontSize: 7, color: '#64748b', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: 4 },
  commentText: { fontSize: 8, color: '#334155', lineHeight: 1.4 },
  emptyText: { fontSize: 8, color: '#94a3b8', fontStyle: 'italic', textAlign: 'center', paddingVertical: 12 },
});

function gradeBadgeStyle(grade: string | null) {
  if (!grade) return pdfStyles.badge;
  if (grade === 'A' || grade === 'B') return { ...pdfStyles.badge, ...pdfStyles.badgeSuccess };
  if (grade === 'C' || grade === 'D') return { ...pdfStyles.badge, ...pdfStyles.badgeWarn };
  if (grade === 'F') return { ...pdfStyles.badge, ...pdfStyles.badgeDanger };
  return pdfStyles.badge;
}

const ReportPdfDocument = ({
  student,
  reportType,
  academicYearName,
  termName,
  month,
  overallAverage,
  monthlyRows,
  midtermData,
  finalData,
  teacherComment,
}: {
  student: Student | null;
  reportType: string;
  academicYearName: string;
  termName: string;
  month?: string;
  overallAverage: string;
  monthlyRows?: MonthlyScore[];
  midtermData?: MidtermReport | null;
  finalData?: FinalReport | null;
  teacherComment?: string;
}) => {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const titleMap: Record<string, string> = {
    Monthly: 'Monthly Academic Report',
    Midterm: 'Midterm Academic Report',
    Final: 'Final Academic Report',
  };
  const title = titleMap[reportType] || `${reportType} Report`;
  const subtitle =
    reportType === 'Monthly' && month ? `${month} ${academicYearName ? `• ${academicYearName}` : ''}` : `${termName} ${academicYearName ? `• ${academicYearName}` : ''}`;

  // Helper to chunk subjects to avoid page overflow — keep each subject block together
  const monthlyChunks = monthlyRows || [];

  return (
    <Document>
      <Page size="A4" style={pdfStyles.page} wrap>
        {/* Header band */}
        <View style={pdfStyles.headerBand} fixed>
          <Text style={pdfStyles.schoolName}>MBK INTERNATIONAL SCHOOL</Text>
          <Text style={pdfStyles.schoolSub}>Dr. Abdishakuur Secondary College</Text>
          <Text style={pdfStyles.reportTitle}>{title}</Text>
          <Text style={pdfStyles.reportSubtitle}>{subtitle}</Text>
        </View>

        {/* Meta grid */}
        <View style={pdfStyles.metaGrid}>
          <View style={pdfStyles.metaCard}>
            <Text style={pdfStyles.metaLabel}>Student</Text>
            <Text style={pdfStyles.metaValue}>{student?.name ?? '—'}</Text>
          </View>
          <View style={pdfStyles.metaCard}>
            <Text style={pdfStyles.metaLabel}>Class</Text>
            <Text style={pdfStyles.metaValue}>{student?.className ?? '—'}</Text>
          </View>
          <View style={pdfStyles.metaCard}>
            <Text style={pdfStyles.metaLabel}>Academic Year</Text>
            <Text style={pdfStyles.metaValue}>{academicYearName || '—'}</Text>
          </View>
          <View style={pdfStyles.metaCard}>
            <Text style={pdfStyles.metaLabel}>Term</Text>
            <Text style={pdfStyles.metaValue}>{termName || '—'}</Text>
          </View>
          {reportType === 'Monthly' && month && (
            <View style={pdfStyles.metaCard}>
              <Text style={pdfStyles.metaLabel}>Month</Text>
              <Text style={pdfStyles.metaValue}>{month}</Text>
            </View>
          )}
          <View style={pdfStyles.metaCard}>
            <Text style={pdfStyles.metaLabel}>Report Type</Text>
            <Text style={pdfStyles.metaValue}>{reportType}</Text>
          </View>
        </View>

        {/* Prominent average */}
        <View style={pdfStyles.averageCard}>
          <Text style={pdfStyles.averageLabel}>{reportType} Average</Text>
          <Text style={pdfStyles.averageValue}>{overallAverage}</Text>
          <Text style={pdfStyles.averageSub}>
            {reportType === 'Monthly' ? 'CA 40% + Quiz 60% • Generated ' + today : 'Generated ' + today}
          </Text>
        </View>

        {/* Monthly */}
        {reportType === 'Monthly' && (
          <>
            <Text style={pdfStyles.sectionTitle}>Subject Results</Text>
            {monthlyChunks.length === 0 ? (
              <Text style={pdfStyles.emptyText}>No CA or Quiz data available for {month}</Text>
            ) : (
              <>
                {/* Summary table */}
                <View style={pdfStyles.tableHeader}>
                  <Text style={[pdfStyles.th, { width: '36%' }]}>Subject</Text>
                  <Text style={[pdfStyles.th, { width: '14%', textAlign: 'center' }]}>CA Avg</Text>
                  <Text style={[pdfStyles.th, { width: '14%', textAlign: 'center' }]}>Quiz Avg</Text>
                  <Text style={[pdfStyles.th, { width: '18%', textAlign: 'center' }]}>Monthly</Text>
                  <Text style={[pdfStyles.th, { width: '10%', textAlign: 'center' }]}>Grade</Text>
                  <Text style={[pdfStyles.th, { width: '8%', textAlign: 'center' }]}>#</Text>
                </View>
                {monthlyChunks.map((row, idx) => (
                  <View key={`${row.subject}-${idx}`} style={[pdfStyles.tableRow, idx % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                    <Text style={[pdfStyles.tdBold, { width: '36%' }]}>{row.subject}</Text>
                    <Text style={[pdfStyles.td, { width: '14%', textAlign: 'center' }]}>{row.ca_avg != null ? `${row.ca_avg}%` : '—'}</Text>
                    <Text style={[pdfStyles.td, { width: '14%', textAlign: 'center' }]}>{row.quiz_avg != null ? `${row.quiz_avg}%` : '—'}</Text>
                    <Text style={[pdfStyles.tdBold, { width: '18%', textAlign: 'center', color: row.average != null ? '#1e3a8a' : '#94a3b8' }]}>
                      {row.average != null ? `${row.average}%` : 'Not recorded'}
                    </Text>
                    <Text style={[{ width: '10%', textAlign: 'center' }, gradeBadgeStyle(row.grade)]}>{row.grade ?? '—'}</Text>
                    <Text style={[pdfStyles.td, { width: '8%', textAlign: 'center' }]}>{row.assessment_count}</Text>
                  </View>
                ))}

                {/* Detailed breakdown — each subject cluster kept together with wrap={false} where possible */}
                <Text style={pdfStyles.sectionTitle}>Detailed Assessment Breakdown</Text>
                <Text style={{ fontSize: 7, color: '#64748b', marginBottom: 6 }}>
                  Scores shown as score/total (percentage). CA includes Attendance, Classwork/CPW, Homework; Quiz is separate 60% component.
                </Text>
                {monthlyChunks.map((row, sIdx) => (
                  <View key={`detail-${row.subject}-${sIdx}`} style={pdfStyles.detailSection} wrap={false}>
                    <View style={pdfStyles.detailHeader}>
                      <Text style={pdfStyles.detailSubject}>{row.subject}</Text>
                      <Text style={pdfStyles.detailAvg}>
                        {row.average != null ? `${row.average}%` : 'Not recorded'} {row.grade ? `• ${row.grade}` : ''} {row.remark ? `• ${row.remark}` : ''}
                      </Text>
                    </View>
                    {/* CA details */}
                    {row.ca_details.length > 0 && (
                      <View>
                        <View style={{ backgroundColor: '#f8fafc', paddingHorizontal: 8, paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0' }}>
                          <Text style={{ fontSize: 7, color: '#64748b', fontWeight: 'bold', textTransform: 'uppercase' }}>Coursework (CA) — {row.ca_avg != null ? `${row.ca_avg}% avg` : 'Not recorded'} • {row.ca_count} items</Text>
                        </View>
                        {row.ca_details.map((d, i) => (
                          <View key={`ca-${i}`} style={pdfStyles.detailRow}>
                            <Text style={pdfStyles.detailLabel}>{d.type}</Text>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Text style={pdfStyles.detailPercent}>{d.percentage}%</Text>
                              <Text style={pdfStyles.detailScore}>{d.score}/{d.total}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}
                    {/* Quiz details */}
                    {row.quiz_details.length > 0 && (
                      <View>
                        <View style={{ backgroundColor: '#eff6ff', paddingHorizontal: 8, paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: '#dbeafe' }}>
                          <Text style={{ fontSize: 7, color: '#1e40af', fontWeight: 'bold', textTransform: 'uppercase' }}>Quiz — {row.quiz_avg != null ? `${row.quiz_avg}% avg` : 'Not recorded'} • {row.quiz_count} items</Text>
                        </View>
                        {row.quiz_details.map((d, i) => (
                          <View key={`quiz-${i}`} style={[pdfStyles.detailRow, { backgroundColor: '#f8fafc' }]}>
                            <Text style={pdfStyles.detailLabel}>Quiz · {d.type}</Text>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Text style={pdfStyles.detailPercent}>{d.percentage}%</Text>
                              <Text style={pdfStyles.detailScore}>{d.score}/{d.total}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}
                    {row.ca_details.length === 0 && row.quiz_details.length === 0 && row.details.length > 0 && (
                      <View>
                        {row.details.map((d, i) => (
                          <View key={`det-${i}`} style={pdfStyles.detailRow}>
                            <Text style={pdfStyles.detailLabel}>{d.type}</Text>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                              <Text style={pdfStyles.detailPercent}>{d.percentage}%</Text>
                              <Text style={pdfStyles.detailScore}>{d.score}/{d.total}</Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#f8fafc', paddingHorizontal: 8, paddingVertical: 4, borderTopWidth: 0.5, borderTopColor: '#e2e8f0' }}>
                      <Text style={{ fontSize: 7, color: '#64748b' }}>CA {row.ca_weight}% • Quiz {row.quiz_weight}%</Text>
                      <Text style={{ fontSize: 7, color: '#1e3a8a', fontWeight: 'bold' }}>Weighted: {row.ca_weighted ?? '—'} + {row.quiz_weighted ?? '—'} = {row.average ?? '—'}</Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </>
        )}

        {/* Midterm */}
        {reportType === 'Midterm' && midtermData && (
          <>
            <Text style={pdfStyles.sectionTitle}>Midterm Results</Text>
            <View style={pdfStyles.tableHeader}>
              <Text style={[pdfStyles.th, { width: '28%' }]}>Subject</Text>
              <Text style={[pdfStyles.th, { width: '14%', textAlign: 'center' }]}>Score</Text>
              <Text style={[pdfStyles.th, { width: '10%', textAlign: 'center' }]}>Total</Text>
              <Text style={[pdfStyles.th, { width: '12%', textAlign: 'center' }]}>%</Text>
              <Text style={[pdfStyles.th, { width: '10%', textAlign: 'center' }]}>Grade</Text>
              <Text style={[pdfStyles.th, { width: '26%' }]}>Remark</Text>
            </View>
            {midtermData.scores.length === 0 ? (
              <Text style={pdfStyles.emptyText}>No midterm results available</Text>
            ) : (
              midtermData.scores.map((s, idx) => (
                <View key={s.subject} style={[pdfStyles.tableRow, idx % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                  <Text style={[pdfStyles.tdBold, { width: '28%' }]}>{s.subject}</Text>
                  <Text style={[pdfStyles.td, { width: '14%', textAlign: 'center' }]}>{s.score}</Text>
                  <Text style={[pdfStyles.td, { width: '10%', textAlign: 'center' }]}>{s.total}</Text>
                  <Text style={[pdfStyles.tdBold, { width: '12%', textAlign: 'center', color: '#1e3a8a' }]}>{s.percentage}%</Text>
                  <Text style={[{ width: '10%', textAlign: 'center' }, gradeBadgeStyle(s.grade)]}>{s.grade}</Text>
                  <Text style={[pdfStyles.td, { width: '26%' }]}>{s.remark} • Rank {s.subject_rank}</Text>
                </View>
              ))
            )}
            {midtermData.scores.length > 0 && (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, padding: 8, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4 }}>
                <Text style={{ fontSize: 8, color: '#475569' }}>Overall rank: {midtermData.overall_rank} of {midtermData.total_students}</Text>
                <Text style={{ fontSize: 8, color: '#1e3a8a', fontWeight: 'bold' }}>Midterm Average: {overallAverage}</Text>
              </View>
            )}
          </>
        )}

        {/* Final */}
        {reportType === 'Final' && finalData && (
          <>
            <Text style={pdfStyles.sectionTitle}>Final Results</Text>
            <View style={pdfStyles.tableHeader}>
              <Text style={[pdfStyles.th, { width: '24%' }]}>Subject</Text>
              <Text style={[pdfStyles.th, { width: '12%', textAlign: 'center' }]}>CA Avg</Text>
              <Text style={[pdfStyles.th, { width: '12%', textAlign: 'center' }]}>Midterm</Text>
              <Text style={[pdfStyles.th, { width: '12%', textAlign: 'center' }]}>Final</Text>
              <Text style={[pdfStyles.th, { width: '14%', textAlign: 'center' }]}>Total</Text>
              <Text style={[pdfStyles.th, { width: '26%' }]}>Grade</Text>
            </View>
            {!finalData.results || finalData.results.length === 0 ? (
              <Text style={pdfStyles.emptyText}>Final report not available yet</Text>
            ) : (
              finalData.results.map((r: any, idx: number) => (
                <View key={r.subject} style={[pdfStyles.tableRow, idx % 2 === 1 ? pdfStyles.tableRowAlt : {}]}>
                  <Text style={[pdfStyles.tdBold, { width: '24%' }]}>{r.subject}</Text>
                  <Text style={[pdfStyles.td, { width: '12%', textAlign: 'center' }]}>{r.ca_avg}</Text>
                  <Text style={[pdfStyles.td, { width: '12%', textAlign: 'center' }]}>{r.midterm_score}</Text>
                  <Text style={[pdfStyles.td, { width: '12%', textAlign: 'center' }]}>{r.final_score}</Text>
                  <Text style={[pdfStyles.tdBold, { width: '14%', textAlign: 'center', color: '#1e3a8a' }]}>{r.total}</Text>
                  <Text style={[pdfStyles.td, { width: '26%' }]}>{r.grade || ''}</Text>
                </View>
              ))
            )}
            {finalData.results && finalData.results.length > 0 && (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, padding: 8, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4 }}>
                <Text style={{ fontSize: 8, color: '#475569' }}>Overall rank: {finalData.overall_rank} of {finalData.total_students}</Text>
                <Text style={{ fontSize: 8, color: '#1e3a8a', fontWeight: 'bold' }}>Final Average: {overallAverage}</Text>
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Text style={{ fontSize: 7, color: '#64748b' }}>
                Weights: CA {finalData.weights?.ca ?? 60}% • Midterm {finalData.weights?.midterm ?? 20}% • Final {finalData.weights?.final ?? 20}%
              </Text>
            </View>
          </>
        )}

        {/* Teacher comment */}
        {teacherComment && (
          <View style={pdfStyles.commentBox} wrap={false}>
            <Text style={pdfStyles.commentLabel}>Teacher&apos;s Comment</Text>
            <Text style={pdfStyles.commentText}>{teacherComment}</Text>
          </View>
        )}

        {/* Legend / note */}
        <View style={{ marginTop: 12, padding: 8, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4 }}>
          <Text style={{ fontSize: 7, color: '#64748b', textAlign: 'center' }}>
            Grade scale: A ≥90 Excellent • B ≥80 Very Good • C ≥70 Good • D ≥60 Satisfactory • F &lt;60 Needs Improvement
          </Text>
          <Text style={{ fontSize: 7, color: '#94a3b8', textAlign: 'center', marginTop: 4 }}>
            Monthly Score = (CA Average × 40%) + (Quiz Average × 60%). Missing component is shown as Not recorded, not as 0.
          </Text>
        </View>

        {/* Footer */}
        <View style={pdfStyles.footer} fixed>
          <Text style={pdfStyles.footerText}>MBK International School • Dr. Abdishakuur Secondary College • Generated {today}</Text>
          <Text style={pdfStyles.pageNumber} render={({ pageNumber, totalPages }: any) => `${pageNumber} / ${totalPages}`} fixed />
        </View>
      </Page>
    </Document>
  );
};

// ============================================================================
// Main component
// ============================================================================

export function ExamReport({ initialStudentId }: { initialStudentId?: string } = {}) {
  const { session } = useRole();
  const { addToast } = useToast();

  // Core data
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState(initialStudentId || '');

  const [teacherComment, setTeacherComment] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);
  const [reportComments, setReportComments] = useState<Record<string, ReportComment | undefined>>({});

  const [reportType, setReportType] = useState<'Monthly' | 'Midterm' | 'Final'>('Monthly');
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);
  const [academicYears, setAcademicYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [selectedYearId, setSelectedYearId] = useState<string>('');
  const [selectedTermId, setSelectedTermId] = useState<string>('');

  const [parentPhones, setParentPhones] = useState<string[]>([]);
  const [selectedParentPhone, setSelectedParentPhone] = useState<string>('');
  const [parentName, setParentName] = useState<string>('');

  const [monthlyData, setMonthlyData] = useState<MonthlyScore[]>([]);
  const [midtermData, setMidtermData] = useState<MidtermReport | null>(null);
  const [finalData, setFinalData] = useState<FinalReport | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('All');
  const isSingleView = Boolean(initialStudentId);

  // UI states
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(() => new Set());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string>('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // PDF states
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [showPdfPreview, setShowPdfPreview] = useState(false);

  // WhatsApp states
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [waGenerating, setWaGenerating] = useState(false);
  const [waReady, setWaReady] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);
  const [waMessage, setWaMessage] = useState('');
  const [waPdfReady, setWaPdfReady] = useState(false);

  // More menu
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Derived
  const student = useMemo(() => students.find(s => s.id === selectedStudent) || null, [students, selectedStudent]);
  const selectedYear = useMemo(() => academicYears.find(y => y.id === selectedYearId) || null, [academicYears, selectedYearId]);
  const selectedTerm = useMemo(() => terms.find(t => t.id === selectedTermId) || null, [terms, selectedTermId]);

  const monthlyFiltered = useMemo(() => monthlyData.filter(d => d.month === selectedMonth), [monthlyData, selectedMonth]);
  const overallMonthly = useMemo(() => overallMonthlyAverage(monthlyFiltered), [monthlyFiltered]);

  const overallMidterm = useMemo(() => {
    if (!midtermData?.scores || midtermData.scores.length === 0) return 0;
    return Math.round(midtermData.scores.reduce((s, sc) => s + sc.percentage, 0) / midtermData.scores.length);
  }, [midtermData]);

  const overallFinal = useMemo(() => {
    if (!finalData?.results || finalData.results.length === 0) return 0;
    return Math.round(finalData.results.reduce((s, r: any) => s + (r.total ?? 0), 0) / finalData.results.length);
  }, [finalData]);

  const overallDisplay = useMemo(() => {
    if (reportType === 'Monthly') return formatReportPercent(overallMonthly);
    if (reportType === 'Midterm') return midtermData?.scores.length ? `${overallMidterm}%` : 'Not recorded';
    return finalData?.results?.length ? `${overallFinal}%` : 'Not recorded';
  }, [reportType, overallMonthly, overallMidterm, overallFinal, midtermData, finalData]);

  const summaryStats = useMemo(() => {
    if (reportType === 'Monthly') {
      const subjects = monthlyFiltered.length;
      const assessments = monthlyFiltered.reduce((sum, r) => sum + r.assessment_count, 0);
      const attendanceVals: number[] = [];
      monthlyFiltered.forEach(r => {
        r.details.forEach(d => {
          if (d.type.toLowerCase().includes('attendance') || d.type.toLowerCase() === 'att') attendanceVals.push(d.percentage);
        });
      });
      const attendance = attendanceVals.length ? Math.round(attendanceVals.reduce((a, b) => a + b, 0) / attendanceVals.length) : null;
      return { subjects, assessments, attendance, average: overallMonthly };
    }
    if (reportType === 'Midterm') {
      const subjects = midtermData?.scores.length || 0;
      return { subjects, assessments: subjects, attendance: null as number | null, average: midtermData?.scores.length ? overallMidterm : null };
    }
    const subjects = finalData?.results.length || 0;
    return { subjects, assessments: subjects, attendance: null as number | null, average: finalData?.results.length ? overallFinal : null };
  }, [reportType, monthlyFiltered, midtermData, finalData, overallMonthly, overallMidterm, overallFinal]);

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (selectedYear) parts.push(selectedYear.name);
    if (selectedTerm) parts.push(selectedTerm.name);
    parts.push(selectedClass === 'All' ? 'All classes' : selectedClass);
    parts.push(reportType);
    if (reportType === 'Monthly') parts.push(selectedMonth);
    if (student) parts.push(`${student.name} • ${student.className}`);
    return parts.join(' · ');
  }, [selectedYear, selectedTerm, selectedClass, reportType, selectedMonth, student]);

  // Toggle subject expansion
  const toggleSubject = useCallback((subject: string) => {
    setExpandedSubjects(prev => {
      const n = new Set(prev);
      if (n.has(subject)) n.delete(subject);
      else n.add(subject);
      return n;
    });
  }, []);

  // Persist collapsed filters after selection
  useEffect(() => {
    if (student && selectedYearId && selectedTermId) {
      // Auto-collapse on mobile after data loads? Keep open on desktop; on narrow screens collapse for compactness.
      // We'll keep filtersOpen true initially; user can collapse. Use media query hint: if window.innerWidth < 768, collapse after selection
      const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
      if (isMobile && filtersOpen && monthlyData.length > 0) {
        // don't auto-collapse aggressively; leave control to user — but we provide summary collapsed hint
      }
    }
  }, [student, selectedYearId, selectedTermId, monthlyData.length, filtersOpen]);

  // Load academic years and terms
  useEffect(() => {
    const load = async () => {
      try {
        const [years, allTerms] = await Promise.all([getAcademicYears(), getTerms()]);
        setAcademicYears(years);
        setTerms(allTerms as Term[]);
        const currentTerm = await getCurrentTerm();
        if (currentTerm) {
          setSelectedTermId(currentTerm.id);
          setSelectedYearId(currentTerm.academicYearId);
        } else if (years.length > 0) {
          setSelectedYearId(years[0].id);
          const yearTerms = allTerms.filter(t => t.academicYearId === years[0].id);
          if (yearTerms.length > 0) setSelectedTermId(yearTerms[0].id);
        }
      } catch (err) {
        console.error('Failed to load academic years/terms', err);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!selectedYearId) return;
    const yearTerms = terms.filter(t => t.academicYearId === selectedYearId);
    if (yearTerms.length > 0 && !yearTerms.find(t => t.id === selectedTermId)) {
      setSelectedTermId(yearTerms[0].id);
    }
  }, [selectedYearId, terms, selectedTermId]);

  useEffect(() => {
    if (!session) return;
    const init = async () => {
      setLoading(true);
      try {
        if (isSingleView && initialStudentId) {
          const s = await getStudentById(initialStudentId);
          if (s) {
            setStudents([s]);
            setSelectedStudent(s.id);
            setClasses([s.className]);
            setSelectedClass(s.className);
          }
          return;
        }
        if (session.role === 'teacher' || session.role === 'supervisor') {
          const user = await getUserById(session.userId);
          const assigned = user?.assignedClasses || [];
          if (assigned.length > 0) {
            setClasses(assigned);
            setSelectedClass(assigned.length > 1 ? 'All' : assigned[0]);
          } else {
            const unique = await getClasses();
            setClasses(unique);
            setSelectedClass(unique[0] || 'All');
          }
        } else if (session.role === 'admin') {
          const unique = await getClasses();
          setClasses(unique);
          setSelectedClass('All');
        }
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [session, initialStudentId, isSingleView]);

  useEffect(() => {
    if (!session) return;
    if (!selectedClass) return;
    const loadByClass = async () => {
      setLoading(true);
      try {
        if (session.role === 'parent') {
          const list = await getStudentsByParent(session.userId);
          const filtered = selectedClass === 'All' ? list : list.filter(s => s.className === selectedClass);
          setStudents(filtered);
          if (filtered.length > 0) setSelectedStudent(filtered[0].id);
          return;
        }
        if (selectedClass === 'All') {
          if (session.role === 'teacher' || session.role === 'supervisor') {
            const user = await getUserById(session.userId);
            const classesList = user?.assignedClasses || [];
            const list = classesList.length > 0 ? await getStudentsByClasses(classesList) : await getStudents();
            setStudents(list);
            if (initialStudentId && list.find(s => s.id === initialStudentId)) {
              setSelectedStudent(initialStudentId);
            } else if (list.length > 0) {
              setSelectedStudent(list[0].id);
            }
          } else {
            const list = await getStudents();
            setStudents(list);
            if (list.length > 0) setSelectedStudent(list[0].id);
          }
        } else {
          const list = await getStudentsByClass(selectedClass);
          setStudents(list);
          if (list.length > 0) setSelectedStudent(list[0].id);
        }
      } finally {
        setLoading(false);
      }
    };
    loadByClass();
  }, [selectedClass, session, initialStudentId, isSingleView]);

  useEffect(() => {
    if (!selectedStudent || !selectedTermId) return;
    const loadReport = async () => {
      setLoading(true);
      // reset save/pdfs on student change
      setSaveState('idle');
      setSavedAt(null);
      setPdfBlob(null);
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
        setPdfUrl(null);
      }
      setExpandedSubjects(new Set());
      try {
        setCommentLoading(true);
        try {
          const c = await getReportComment(selectedStudent, selectedTermId);
          setTeacherComment(c?.teacherComment || '');
        } catch {
          setTeacherComment('');
        } finally {
          setCommentLoading(false);
        }
        if (reportType === 'Monthly') {
          const rep = await getMonthlyReport(selectedStudent, selectedTermId);
          setMonthlyData(rep || []);
        } else if (reportType === 'Midterm') {
          const rep = await getMidtermReport(selectedStudent, selectedTermId);
          setMidtermData(rep || null);
        } else if (reportType === 'Final') {
          const rep = await getFinalReport(selectedStudent, selectedTermId);
          setFinalData(rep || null);
        }
        try {
          const comments = await getReportCommentsForStudentTerm(selectedStudent, selectedTermId);
          const map: Record<string, ReportComment | undefined> = {};
          for (const c of comments) {
            if (c.examId) map[c.examId] = c as any;
          }
          setReportComments(map);
        } catch {
          setReportComments({});
        }
      } finally {
        setLoading(false);
      }
    };
    loadReport();
  }, [selectedStudent, reportType, selectedTermId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const loadParent = async () => {
      if (!student?.parentId) {
        setParentPhones([]);
        setSelectedParentPhone('');
        setParentName('');
        return;
      }
      const parent = await getUserById(student.parentId);
      if (!parent) {
        setParentPhones([]);
        setSelectedParentPhone('');
        setParentName('');
        return;
      }
      setParentName(parent.name || '');
      const phones = [parent.phone1, parent.phone2].filter(phone => !!phone && phone.trim()) as string[];
      setParentPhones(phones);
      setSelectedParentPhone(phones[0] || '');
    };
    loadParent();
  }, [student]);

  // Cleanup PDF url on unmount
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // Generate PDF blob helper
  const generatePdfBlob = useCallback(async (): Promise<Blob> => {
    if (!student) throw new Error('No student selected');
    const yearName = selectedYear?.name || '';
    const termName = selectedTerm?.name || '';
    const avg = overallDisplay;
    const doc = (
      <ReportPdfDocument
        student={student}
        reportType={reportType}
        academicYearName={yearName}
        termName={termName}
        month={selectedMonth}
        overallAverage={avg}
        monthlyRows={monthlyFiltered}
        midtermData={midtermData}
        finalData={finalData}
        teacherComment={teacherComment}
      />
    );
    const blob = await pdf(doc).toBlob();
    return blob;
  }, [student, selectedYear, selectedTerm, overallDisplay, reportType, selectedMonth, monthlyFiltered, midtermData, finalData, teacherComment]);

  // Save handler — persists snapshot to localStorage with success/error states
  const handleSave = async () => {
    if (!student || !selectedTermId) {
      addToast({ type: 'error', title: 'Save failed', description: 'No student or term selected' });
      return;
    }
    // Prevent duplicate saves if already saved and data hasn't changed (within 2 minutes)
    if (saveState === 'saved' && savedAt) {
      const last = new Date(savedAt).getTime();
      if (Date.now() - last < 2 * 60 * 1000) {
        addToast({ type: 'info', title: 'Already saved', description: 'This report was just saved. No need to save again.' });
        return;
      }
    }
    setSaveState('saving');
    setSaveError('');
    try {
      // Simulate persisting report state — store snapshot in localStorage
      // In a real app this could be a DB snapshot; localStorage satisfies "persist report state" for demo
      await new Promise(res => setTimeout(res, 700));
      const snapshot = {
        studentId: student.id,
        studentName: student.name,
        className: student.className,
        academicYearId: selectedYearId,
        academicYearName: selectedYear?.name || '',
        termId: selectedTermId,
        termName: selectedTerm?.name || '',
        reportType,
        month: selectedMonth,
        average: overallDisplay,
        monthlyFiltered,
        midtermData,
        finalData,
        teacherComment,
        parentName,
        savedAt: new Date().toISOString(),
      };
      const key = `exam-report-saved-${student.id}-${selectedTermId}-${reportType}-${reportType === 'Monthly' ? selectedMonth : 'all'}`;
      try {
        localStorage.setItem(key, JSON.stringify(snapshot));
      } catch (e) {
        console.warn('localStorage save failed', e);
        // Fallback — still consider saved in memory
      }
      // Also persist teacher comment if teacher role and comment present
      if (session?.role === 'teacher' && teacherComment.trim()) {
        try {
          await upsertReportComment({
            studentId: student.id,
            termId: selectedTermId,
            examId: null as any,
            teacherComment: teacherComment.trim(),
            teacherId: session.userId,
          });
        } catch (cErr) {
          console.warn('Teacher comment save failed', cErr);
          // still succeed overall save, but warn
          addToast({ type: 'warning', title: 'Report saved, but comment not persisted', description: String(cErr) });
        }
      }
      const now = new Date().toISOString();
      setSavedAt(now);
      setSaveState('saved');
      addToast({
        type: 'success',
        title: 'Report Saved',
        description: `${reportType === 'Monthly' ? selectedMonth + ' monthly' : reportType} report for ${student.name} saved successfully.`,
      });
      // Reset to idle after 3s to allow re-save, but keep savedAt
      setTimeout(() => setSaveState('idle'), 3500);
    } catch (err: any) {
      setSaveState('error');
      setSaveError(err?.message || 'Unable to save report');
      addToast({ type: 'error', title: 'Unable to save report', description: err?.message || 'Please try again.' });
      setTimeout(() => setSaveState('idle'), 4000);
    }
  };

  // Download PDF handler — generates and triggers download
  const handleDownloadPdf = async () => {
    if (!student) {
      addToast({ type: 'error', title: 'Download failed', description: 'No student selected' });
      return;
    }
    setPdfGenerating(true);
    setPdfError(null);
    try {
      addToast({ type: 'loading', title: 'Generating PDF…', description: 'Preparing professional report' });
      const blob = await generatePdfBlob();
      setPdfBlob(blob);
      const url = URL.createObjectURL(blob);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(url);
      // Trigger download
      const a = document.createElement('a');
      a.href = url;
      const safeName = (student.name || 'report').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      const fileMonth = reportType === 'Monthly' ? `_${selectedMonth}` : '';
      a.download = `${safeName}_${reportType}${fileMonth}_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      addToast({ type: 'success', title: '✓ PDF Ready', description: 'Download started' });
    } catch (err: any) {
      setPdfError(err?.message || 'PDF generation failed');
      addToast({ type: 'error', title: '✕ PDF generation failed', description: err?.message || 'Please try again.' });
    } finally {
      setPdfGenerating(false);
    }
  };

  // Export / Preview handler — generates and opens preview modal
  const handleExportPreview = async () => {
    if (!student) {
      addToast({ type: 'error', title: 'Preview failed', description: 'No student selected' });
      return;
    }
    setPdfGenerating(true);
    setPdfError(null);
    try {
      const blob = await generatePdfBlob();
      setPdfBlob(blob);
      const url = URL.createObjectURL(blob);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(url);
      setShowPdfPreview(true);
    } catch (err: any) {
      setPdfError(err?.message || 'PDF generation failed');
      addToast({ type: 'error', title: '✕ PDF generation failed', description: err?.message || 'Please try again.' });
    } finally {
      setPdfGenerating(false);
    }
  };

  const handlePrint = async () => {
    if (pdfUrl) {
      window.open(pdfUrl, '_blank');
      return;
    }
    // Generate then print
    setPdfGenerating(true);
    try {
      const blob = await generatePdfBlob();
      const url = URL.createObjectURL(blob);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(url);
      setPdfBlob(blob);
      window.open(url, '_blank');
    } catch (err: any) {
      addToast({ type: 'error', title: 'Print failed', description: err?.message || 'Please try again.' });
    } finally {
      setPdfGenerating(false);
    }
  };

  const handleShare = async () => {
    if (!student) return;
    try {
      if (!pdfBlob) {
        setPdfGenerating(true);
        const blob = await generatePdfBlob();
        setPdfBlob(blob);
        const url = URL.createObjectURL(blob);
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        setPdfUrl(url);
        if ((navigator as any).share && (navigator as any).canShare) {
          const file = new File([blob], `report-${student.name}.pdf`, { type: 'application/pdf' });
          const canShare = (navigator as any).canShare({ files: [file] });
          if (canShare) {
            await (navigator as any).share({ title: `${reportType} Report — ${student.name}`, text: `Academic report for ${student.name}`, files: [file] });
            addToast({ type: 'success', title: 'Shared successfully' });
            return;
          }
        }
        // Fallback: download
        const a = document.createElement('a');
        a.href = url;
        a.download = `report-${student.name.replace(/\s+/g, '_')}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        addToast({ type: 'success', title: 'Report ready to share', description: 'PDF downloaded — share it from your files' });
      } else {
        if ((navigator as any).share && pdfBlob) {
          const file = new File([pdfBlob], `report-${student.name}.pdf`, { type: 'application/pdf' });
          try {
            if ((navigator as any).canShare({ files: [file] })) {
              await (navigator as any).share({ title: `${reportType} Report — ${student.name}`, text: `Academic report for ${student.name}`, files: [file] });
              return;
            }
          } catch (e) {
            console.warn('share failed', e);
          }
        }
        // fallback download
        const a = document.createElement('a');
        a.href = pdfUrl!;
        a.download = `report-${student.name.replace(/\s+/g, '_')}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err: any) {
      addToast({ type: 'error', title: 'Share failed', description: err?.message || 'Please try again.' });
    } finally {
      setPdfGenerating(false);
    }
  };

  // WhatsApp handlers
  const openWhatsAppModal = () => {
    const yearName = selectedYear?.name || '';
    const termName = selectedTerm?.name || '';
    const msg = buildReportWhatsAppMessage({
      studentName: student?.name || '',
      className: student?.className || '',
      academicYear: yearName,
      termName: termName,
      reportType,
      month: reportType === 'Monthly' ? selectedMonth : undefined,
      average: overallDisplay,
    });
    setWaMessage(msg);
    setWaReady(false);
    setWaPdfReady(false);
    setWaError(null);
    setWaGenerating(false);
    setShowWhatsAppModal(true);
  };

  const handleGenerateWhatsApp = async () => {
    if (!selectedParentPhone) {
      setWaError('No parent phone number available');
      return;
    }
    if (!isValidPhone(selectedParentPhone)) {
      setWaError('Invalid phone number — please check parent contact');
      return;
    }
    if (!student) {
      setWaError('No student selected');
      return;
    }
    setWaGenerating(true);
    setWaError(null);
    try {
      await new Promise(res => setTimeout(res, 300)); // brief UX delay
      const blob = await generatePdfBlob();
      setPdfBlob(blob);
      const url = URL.createObjectURL(blob);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(url);
      setWaPdfReady(true);
      setWaReady(true);
    } catch (err: any) {
      setWaError(err?.message || 'Failed to prepare WhatsApp message');
    } finally {
      setWaGenerating(false);
    }
  };

  const handleOpenWhatsApp = () => {
    if (!selectedParentPhone) {
      addToast({ type: 'error', title: 'WhatsApp failed', description: 'No parent phone number' });
      return;
    }
    const link = buildWhatsAppLink(selectedParentPhone, waMessage);
    window.open(link, '_blank');
    addToast({ type: 'success', title: 'WhatsApp opened', description: 'Message prepared — attach PDF if needed' });
  };

  const handleSharePdfForWhatsApp = async () => {
    if (!pdfBlob || !pdfUrl) {
      addToast({ type: 'error', title: 'No PDF', description: 'Generate the report first' });
      return;
    }
    // Try native share with file
    if ((navigator as any).share) {
      try {
        const file = new File([pdfBlob], `report-${student?.name || 'student'}.pdf`, { type: 'application/pdf' });
        if ((navigator as any).canShare && (navigator as any).canShare({ files: [file] })) {
          await (navigator as any).share({ title: `${reportType} Report — ${student?.name}`, text: waMessage, files: [file] });
          return;
        }
      } catch (e) {
        console.warn('share failed', e);
      }
    }
    // Fallback: download
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `report-${(student?.name || 'report').replace(/\s+/g, '_')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    addToast({ type: 'success', title: 'PDF downloaded', description: 'Now attach it in WhatsApp' });
  };

  const saveTeacherComment = async () => {
    if (!selectedStudent) {
      addToast({ type: 'error', title: 'Save failed', description: 'No student selected' });
      return;
    }
    if (!selectedTermId) {
      addToast({ type: 'error', title: 'Save failed', description: 'No term selected' });
      return;
    }
    setCommentLoading(true);
    try {
      const payload = {
        studentId: selectedStudent,
        termId: selectedTermId,
        examId: null as any,
        teacherComment: teacherComment || '',
        teacherId: session?.userId || undefined,
      } as any;
      const res = await upsertReportComment(payload);
      if (res) {
        addToast({ type: 'success', title: 'Saved', description: 'Teacher comment saved' });
      } else {
        addToast({ type: 'error', title: 'Save failed', description: 'Could not save comment' });
      }
    } catch (err: any) {
      addToast({ type: 'error', title: 'Save failed', description: err?.message || String(err) });
    } finally {
      setCommentLoading(false);
    }
  };

  const normalizedPhone = selectedParentPhone ? formatInternationalPhone(selectedParentPhone) : '';
  const digitsForCheck = selectedParentPhone ? normalizeSomaliPhoneToWa(selectedParentPhone) : '';
  const hasValidPhone = !!selectedParentPhone && isValidPhone(selectedParentPhone);
  const noPhoneAvailable = parentPhones.length === 0;

  // Summary cards helper
  const attendanceDisplay = summaryStats.attendance != null ? `${summaryStats.attendance}%` : '—';
  const subjectsDisplay = String(summaryStats.subjects);
  const assessmentsDisplay = String(summaryStats.assessments);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Exam Reports</h1>
        <p className="text-sm text-slate-600">View Monthly, Midterm or Final reports for your students</p>
      </div>

      {/* Filters — collapsible */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <button
          onClick={() => setFiltersOpen(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-slate-50 transition-colors"
          aria-expanded={filtersOpen}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
              <FileBarChart className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">Report Filters</p>
              {!filtersOpen && (
                <p className="text-xs text-slate-500 truncate mt-0.5">{filterSummary || 'Select filters to view report'}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!filtersOpen && student && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Ready
              </span>
            )}
            {filtersOpen ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
          </div>
        </button>

        {/* Compact summary when collapsed */}
        {!filtersOpen && student && (
          <div className="px-4 pb-3">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5">
              <p className="text-xs font-medium text-slate-700 leading-relaxed">{filterSummary}</p>
            </div>
          </div>
        )}

        {filtersOpen && (
          <div className="px-4 pb-4 pt-1 border-t border-slate-100">
            {/* Collapsed summary inside open? Show as subtle */}
            {student && (
              <div className="mb-3 rounded-lg bg-indigo-50 border border-indigo-100 px-3 py-2">
                <p className="text-xs text-indigo-800 font-medium truncate">{filterSummary}</p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {!isSingleView && (
                <>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Academic Year</label>
                    <select
                      value={selectedYearId}
                      onChange={e => setSelectedYearId(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none"
                    >
                      {academicYears.map(y => (
                        <option key={y.id} value={y.id}>
                          {y.name}
                          {y.isCurrent ? ' (Current)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Term</label>
                    <select
                      value={selectedTermId}
                      onChange={e => setSelectedTermId(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none"
                    >
                      {terms
                        .filter(t => t.academicYearId === selectedYearId)
                        .map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {t.isCurrent ? ' (Current)' : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Class</label>
                    <select
                      value={selectedClass}
                      onChange={e => setSelectedClass(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-sm focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none"
                    >
                      <option value="All">All classes</option>
                      {classes.map(c => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Student</label>
                    <select
                      title={students.find(s => s.id === selectedStudent)?.name || ''}
                      value={selectedStudent}
                      onChange={e => setSelectedStudent(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-sm truncate focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none"
                    >
                      <option value="">-- Select student --</option>
                      {students.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.className}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              {isSingleView && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Student</label>
                  <div className="h-10 flex items-center px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-medium text-slate-800">
                    {students[0]?.name} · {students[0]?.className}
                  </div>
                </div>
              )}

              <div className="sm:col-span-2 lg:col-span-1">
                <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Report Type</label>
                <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-slate-100">
                  {(['Monthly', 'Midterm', 'Final'] as const).map(rt => (
                    <button
                      key={rt}
                      onClick={() => setReportType(rt)}
                      className={cn(
                        'h-8 rounded-lg text-xs font-semibold transition-all',
                        reportType === rt ? 'bg-white text-indigo-700 shadow-sm border border-slate-200' : 'text-slate-600 hover:text-slate-900',
                      )}
                    >
                      {rt}
                    </button>
                  ))}
                </div>
              </div>

              {reportType === 'Monthly' && (
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5 block">Month</label>
                  <select
                    value={selectedMonth}
                    onChange={e => setSelectedMonth(e.target.value)}
                    className="w-full h-10 px-3 rounded-xl border border-slate-200 text-sm bg-white focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none"
                  >
                    {MONTHS.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Filter footer */}
            <div className="mt-4 flex items-center justify-between">
              <p className="text-xs text-slate-500">
                {loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Preparing report…
                  </span>
                ) : student ? (
                  <span className="text-emerald-700 font-medium">✓ Report ready</span>
                ) : (
                  'Select a student to view report'
                )}
              </p>
              <button
                onClick={() => setFiltersOpen(false)}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-50"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Report content */}
      {!student ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center">
          <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Users className="w-7 h-7 text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900">{loading ? 'Loading…' : 'No students available'}</h3>
          <p className="text-sm text-slate-500 mt-1">Adjust filters to find students.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Polished report header — mobile compact, desktop richer */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            {/* Top gradient bar */}
            <div className="bg-gradient-to-br from-indigo-700 via-indigo-600 to-violet-600 px-4 sm:px-6 py-5">
              {/* Mobile header layout — stacked, no horizontal scroll */}
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold tracking-widest uppercase text-indigo-200">MBK International School</p>
                    <p className="text-xs text-indigo-100 -mt-0.5">Dr. Abdishakuur Secondary College</p>
                    <h2 className="text-lg sm:text-xl font-bold text-white mt-3 leading-tight">
                      {reportType} Academic Report
                    </h2>
                    {reportType === 'Monthly' ? (
                      <p className="text-sm text-white/80 mt-1">
                        {selectedMonth} • {selectedTerm?.name || 'Term'} • {selectedYear?.name || ''}
                      </p>
                    ) : (
                      <p className="text-sm text-white/80 mt-1">
                        {selectedTerm?.name || 'Term'} • {selectedYear?.name || ''} • {reportType}
                      </p>
                    )}
                    <div className="mt-3 space-y-1">
                      <p className="text-sm font-semibold text-white leading-tight">{student.name}</p>
                      <p className="text-xs text-white/75">{student.className}</p>
                    </div>
                  </div>

                  {/* Prominent percentage — stacked vertically on mobile, strong visual */}
                  <div className="shrink-0 text-center bg-white/10 backdrop-blur rounded-2xl border border-white/15 px-4 py-3 min-w-[92px]">
                    <p className="text-2xl sm:text-3xl font-extrabold text-white leading-none tracking-tight">{overallDisplay}</p>
                    <p className="text-[10px] font-semibold tracking-widest uppercase text-white/70 mt-1.5 leading-none">
                      {reportType === 'Monthly' ? 'Monthly Avg' : reportType === 'Midterm' ? 'Midterm Avg' : 'Final Avg'}
                    </p>
                    {summaryStats.subjects > 0 && (
                      <p className="text-[11px] text-white/60 mt-1">
                        {summaryStats.subjects} subjects • {noPhoneAvailable ? '' : hasValidPhone ? '✓ Parent linked' : 'Parent phone missing'}
                      </p>
                    )}
                  </div>
                </div>

                {/* Action bar — mobile-first, no 4 large side-by-side buttons */}
                <div className="flex flex-col gap-2.5">
                  {/* Primary row: Save + Download */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saveState === 'saving' || !student}
                      className={cn(
                        'h-11 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all',
                        saveState === 'saved'
                          ? 'bg-emerald-500 text-white'
                          : saveState === 'error'
                            ? 'bg-red-500 text-white'
                            : 'bg-white text-indigo-700 hover:bg-indigo-50 shadow-sm',
                      )}
                    >
                      {saveState === 'saving' ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Saving…
                        </>
                      ) : saveState === 'saved' ? (
                        <>
                          <Check className="w-4 h-4" />
                          Saved ✓
                        </>
                      ) : saveState === 'error' ? (
                        <>
                          <AlertCircle className="w-4 h-4" />
                          Retry
                        </>
                      ) : (
                        <>
                          <Save className="w-4 h-4" />
                          Save
                        </>
                      )}
                    </button>

                    <button
                      onClick={handleDownloadPdf}
                      disabled={pdfGenerating || !student}
                      className="h-11 rounded-xl bg-white/15 backdrop-blur border border-white/20 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-white/20 transition-colors disabled:opacity-60"
                    >
                      {pdfGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      {pdfGenerating ? 'Generating…' : 'Download PDF'}
                    </button>
                  </div>

                  {/* Secondary row: Share / WhatsApp / More */}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={openWhatsAppModal}
                      disabled={noPhoneAvailable}
                      className={cn(
                        'h-10 rounded-xl font-medium text-sm flex items-center justify-center gap-2 border transition-colors',
                        hasValidPhone
                          ? 'bg-emerald-500 text-white border-emerald-400 hover:bg-emerald-600'
                          : noPhoneAvailable
                            ? 'bg-white/10 text-white/50 border-white/10 cursor-not-allowed'
                            : 'bg-amber-500 text-white border-amber-400 hover:bg-amber-600',
                      )}
                      title={noPhoneAvailable ? 'No parent phone available' : normalizedPhone}
                    >
                      <MessageCircle className="w-4 h-4" />
                      {hasValidPhone ? 'Send WhatsApp' : noPhoneAvailable ? 'No Phone' : 'Fix Phone'}
                    </button>

                    <div className="relative">
                      <button
                        onClick={() => setShowMoreMenu(v => !v)}
                        className="w-full h-10 rounded-xl bg-white text-slate-700 font-medium text-sm flex items-center justify-center gap-2 border border-slate-200 hover:bg-slate-50"
                      >
                        <MoreVertical className="w-4 h-4" />
                        More
                        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', showMoreMenu && 'rotate-180')} />
                      </button>
                      {showMoreMenu && (
                        <div className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden z-30">
                          <button
                            onClick={() => {
                              setShowMoreMenu(false);
                              handleExportPreview();
                            }}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 flex items-center gap-3"
                          >
                            <Eye className="w-4 h-4 text-slate-500" />
                            Preview / Export PDF
                          </button>
                          <button
                            onClick={() => {
                              setShowMoreMenu(false);
                              handlePrint();
                            }}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 flex items-center gap-3"
                          >
                            <Printer className="w-4 h-4 text-slate-500" />
                            Print
                          </button>
                          <button
                            onClick={() => {
                              setShowMoreMenu(false);
                              handleShare();
                            }}
                            className="w-full text-left px-4 py-3 text-sm hover:bg-slate-50 flex items-center gap-3"
                          >
                            <Share2 className="w-4 h-4 text-slate-500" />
                            Share (System)
                          </button>
                          <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100">
                            <p className="text-[11px] text-slate-500">
                              Parent: {noPhoneAvailable ? 'No phone' : normalizedPhone || digitsForCheck}
                            </p>
                            {selectedParentPhone && parentPhones.length > 1 && (
                              <select
                                value={selectedParentPhone}
                                onChange={e => setSelectedParentPhone(e.target.value)}
                                className="mt-2 w-full h-8 rounded-lg border border-slate-200 bg-white text-xs px-2"
                              >
                                {parentPhones.map(p => (
                                  <option key={p} value={p}>
                                    {formatInternationalPhone(p)} ({p})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Status line */}
                  {(saveState === 'saved' || pdfError || saveError || waError) && (
                    <div className="rounded-xl bg-white/10 border border-white/15 px-3 py-2">
                      {saveState === 'saved' && savedAt && (
                        <p className="text-xs text-white/90 flex items-center gap-1.5">
                          <Check className="w-3.5 h-3.5 text-emerald-300" />
                          Report Saved — {reportType === 'Monthly' ? `${selectedMonth} monthly` : reportType} report saved at {new Date(savedAt).toLocaleTimeString()} ✓
                        </p>
                      )}
                      {(pdfError || saveError) && (
                        <p className="text-xs text-red-100 flex items-center gap-1.5">
                          <AlertCircle className="w-3.5 h-3.5" />
                          {pdfError || saveError} —{' '}
                          <button onClick={() => (pdfError ? handleDownloadPdf() : handleSave())} className="underline font-semibold">
                            Retry
                          </button>
                        </p>
                      )}
                    </div>
                  )}
                  {noPhoneAvailable && (
                    <p className="text-xs text-amber-200 bg-amber-500/15 border border-amber-300/20 rounded-xl px-3 py-2">No parent phone number available — ask admin to add parent contact to enable WhatsApp.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Report summary — shown first per spec */}
            <div className="px-4 sm:px-6 py-4 bg-white">
              <div className="flex items-center gap-2 mb-3">
                <Award className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-slate-900">Report Summary</h3>
                {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 ml-2" />}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 p-3 bg-gradient-to-br from-indigo-50 to-white">
                  <p className="text-[11px] font-semibold tracking-wide uppercase text-slate-500">{reportType} Average</p>
                  <p className="text-xl font-extrabold text-indigo-700 mt-1">{overallDisplay}</p>
                  <p className="text-xs text-slate-500 mt-1">{reportType === 'Monthly' ? 'CA 40% + Quiz 60%' : reportType}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-3 bg-white">
                  <p className="text-[11px] font-semibold tracking-wide uppercase text-slate-500 flex items-center gap-1.5">
                    <BookOpen className="w-3.5 h-3.5" />
                    Subjects
                  </p>
                  <p className="text-xl font-bold text-slate-900 mt-1">{subjectsDisplay}</p>
                  <p className="text-xs text-slate-500 mt-1">Total enrolled</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-3 bg-white">
                  <p className="text-[11px] font-semibold tracking-wide uppercase text-slate-500 flex items-center gap-1.5">
                    <CalendarIcon className="w-3.5 h-3.5" />
                    Attendance
                  </p>
                  <p className="text-xl font-bold text-slate-900 mt-1">{attendanceDisplay}</p>
                  <p className="text-xs text-slate-500 mt-1">{summaryStats.attendance != null ? 'Avg across subjects' : 'No data'}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-3 bg-white">
                  <p className="text-[11px] font-semibold tracking-wide uppercase text-slate-500 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    Assessments
                  </p>
                  <p className="text-xl font-bold text-slate-900 mt-1">{assessmentsDisplay}</p>
                  <p className="text-xs text-slate-500 mt-1">Recorded entries</p>
                </div>
              </div>

              {/* Subject performance chips */}
              {reportType === 'Monthly' && monthlyFiltered.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-semibold text-slate-700 mb-2">Subject Performance</p>
                  <div className="flex flex-wrap gap-1.5">
                    {monthlyFiltered.map(r => (
                      <span
                        key={r.subject}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border',
                          r.average == null
                            ? 'bg-slate-50 text-slate-500 border-slate-200'
                            : r.average >= 80
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : r.average >= 60
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : 'bg-red-50 text-red-700 border-red-200',
                        )}
                      >
                        {r.subject} <span className="font-bold">{formatReportPercent(r.average)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {reportType === 'Midterm' && midtermData?.scores.length ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold text-slate-700 mb-2">Subject Performance</p>
                  <div className="flex flex-wrap gap-1.5">
                    {midtermData.scores.map(s => (
                      <span
                        key={s.subject}
                        className={cn(
                          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border',
                          s.percentage >= 80
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : s.percentage >= 60
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-red-50 text-red-700 border-red-200',
                        )}
                      >
                        {s.subject} <span className="font-bold">{s.percentage}%</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {reportType === 'Final' && finalData?.results.length ? (
                <div className="mt-4">
                  <p className="text-xs font-semibold text-slate-700 mb-2">Subject Performance</p>
                  <div className="flex flex-wrap gap-1.5">
                    {finalData.results.map((r: any) => (
                      <span
                        key={r.subject}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border bg-slate-50 text-slate-700 border-slate-200"
                      >
                        {r.subject} <span className="font-bold">{r.total}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* Detailed subjects — mobile cards / desktop table */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-4 sm:px-6 py-3 flex items-center justify-between border-b border-slate-100 bg-slate-50">
              <h3 className="text-sm font-bold text-slate-900">Subject Details</h3>
              <span className="text-xs text-slate-500 hidden sm:inline">Expandable —tap to view assessments</span>
              <span className="text-xs text-slate-500 sm:hidden">Tap to expand</span>
            </div>

            {/* Monthly via MonthlyScoresTable (mobile cards + desktop table) */}
            {reportType === 'Monthly' && <MonthlyScoresTable rows={monthlyFiltered} month={selectedMonth} />}

            {/* Midterm cards/table */}
            {reportType === 'Midterm' && (
              <>
                {midtermData && midtermData.scores.length > 0 ? (
                  <>
                    {/* Mobile cards */}
                    <div className="md:hidden divide-y divide-slate-100">
                      {midtermData.scores.map(s => {
                        const isExpanded = expandedSubjects.has(s.subject);
                        return (
                          <div key={s.subject} className="bg-white">
                            <div className="px-4 py-3 flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="font-bold text-sm text-slate-900 uppercase tracking-wide truncate">{s.subject}</p>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  Rank {s.subject_rank} • Avg {s.class_average}% • Top {s.highest_in_class}%
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className={cn('text-lg font-bold leading-none', s.percentage >= 80 ? 'text-emerald-600' : s.percentage >= 60 ? 'text-amber-600' : 'text-red-600')}>
                                  {s.percentage}%
                                </p>
                                <p className="text-[11px] font-semibold text-slate-500 mt-1">
                                  {s.grade} • {s.score}/{s.total}
                                </p>
                              </div>
                            </div>
                            <div className="px-4 pb-3">
                              <button
                                onClick={() => toggleSubject(s.subject)}
                                aria-expanded={isExpanded}
                                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700"
                              >
                                {isExpanded ? 'Hide Details' : 'View Details'}
                                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', isExpanded && 'rotate-180')} />
                              </button>
                              {isExpanded && (
                                <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
                                  <div className="grid grid-cols-3 gap-px bg-slate-200">
                                    <div className="bg-slate-50 px-3 py-2 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">Score</p>
                                      <p className="text-sm font-bold text-slate-900">
                                        {s.score}/{s.total}
                                      </p>
                                    </div>
                                    <div className="bg-slate-50 px-3 py-2 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">Grade</p>
                                      <p className="text-sm font-bold text-slate-900">{s.grade}</p>
                                    </div>
                                    <div className="bg-slate-50 px-3 py-2 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">Remark</p>
                                      <p className="text-xs font-medium text-slate-700">{s.remark}</p>
                                    </div>
                                  </div>
                                  <div className="px-3 py-2.5 text-xs text-slate-600 space-y-1.5 bg-white">
                                    <div className="flex justify-between">
                                      <span>Class average</span>
                                      <span className="font-semibold">{s.class_average}%</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Highest in class</span>
                                      <span className="font-semibold">{s.highest_in_class}%</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Your rank</span>
                                      <span className="font-semibold">{s.subject_rank}</span>
                                    </div>
                                    {s.examId && reportComments[s.examId] && (
                                      <div className="mt-2 text-xs text-slate-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">Comment: {reportComments[s.examId]?.teacherComment}</div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Desktop table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Subject</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Score</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Total</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">%</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Grade</th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Remark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {midtermData.scores.map(s => (
                            <tr key={s.subject} className="border-b last:border-b-0">
                              <td className="px-4 py-3 font-semibold text-slate-800">{s.subject}</td>
                              <td className="px-4 py-3 text-center">{s.score}</td>
                              <td className="px-4 py-3 text-center">{s.total}</td>
                              <td className="px-4 py-3 text-center font-bold text-indigo-700">{s.percentage}%</td>
                              <td className="px-4 py-3 text-center">
                                <span className="px-2 py-1 rounded-full text-xs font-bold bg-slate-100 border">{s.grade}</span>
                              </td>
                              <td className="px-4 py-3 text-sm text-slate-600">
                                {s.remark}
                                {s.examId && reportComments[s.examId] && (
                                  <div className="mt-2 text-xs text-slate-700 bg-slate-50 p-2 rounded">Comment: {reportComments[s.examId]?.teacherComment}</div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs">
                        <span className="text-slate-600">
                          Overall rank: {midtermData.overall_rank} of {midtermData.total_students}
                        </span>
                        <span className="font-bold text-indigo-700">Midterm Average: {overallMidterm}%</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-12 text-slate-400">
                    <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p className="font-medium">No midterm results available</p>
                  </div>
                )}
              </>
            )}

            {/* Final cards/table */}
            {reportType === 'Final' && (
              <>
                {finalData?.results && finalData.results.length > 0 ? (
                  <>
                    <div className="md:hidden divide-y divide-slate-100">
                      {finalData.results.map((r: any) => {
                        const isExpanded = expandedSubjects.has(r.subject);
                        return (
                          <div key={r.subject} className="bg-white">
                            <div className="px-4 py-3 flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="font-bold text-sm text-slate-900 uppercase tracking-wide truncate">{r.subject}</p>
                                <p className="text-xs text-slate-500 mt-0.5">
                                  CA {r.ca_avg} • MT {r.midterm_score} • Final {r.final_score}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-lg font-bold leading-none text-indigo-700">{r.total}</p>
                                <p className="text-[11px] font-semibold text-slate-500 mt-1">{r.grade || '—'}</p>
                              </div>
                            </div>
                            <div className="px-4 pb-3">
                              <button
                                onClick={() => toggleSubject(r.subject)}
                                aria-expanded={isExpanded}
                                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700"
                              >
                                {isExpanded ? 'Hide Details' : 'View Details'}
                                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', isExpanded && 'rotate-180')} />
                              </button>
                              {isExpanded && (
                                <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                                  <div className="grid grid-cols-3 gap-px bg-slate-200">
                                    <div className="bg-white px-3 py-2.5 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">CA Weighted</p>
                                      <p className="text-sm font-bold text-slate-900">{r.ca_weighted}</p>
                                      <p className="text-xs text-slate-500">{r.ca_avg}</p>
                                    </div>
                                    <div className="bg-white px-3 py-2.5 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">Midterm W</p>
                                      <p className="text-sm font-bold text-slate-900">{r.midterm_weighted}</p>
                                      <p className="text-xs text-slate-500">{r.midterm_score}</p>
                                    </div>
                                    <div className="bg-white px-3 py-2.5 text-center">
                                      <p className="text-[10px] font-semibold text-slate-500 uppercase">Final W</p>
                                      <p className="text-sm font-bold text-slate-900">{r.final_weighted}</p>
                                      <p className="text-xs text-slate-500">{r.final_score}</p>
                                    </div>
                                  </div>
                                  {teacherComment && (
                                    <div className="m-3 text-xs text-slate-700 bg-white border rounded-lg p-2.5">Comment: {teacherComment}</div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Subject</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">CA Avg</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Midterm</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Final</th>
                            <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Total</th>
                            <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Grade</th>
                          </tr>
                        </thead>
                        <tbody>
                          {finalData.results.map((r: any) => (
                            <tr key={r.subject} className="border-b last:border-b-0">
                              <td className="px-4 py-3 font-semibold text-slate-800">{r.subject}</td>
                              <td className="px-4 py-3 text-center">{r.ca_avg}</td>
                              <td className="px-4 py-3 text-center">{r.midterm_score}</td>
                              <td className="px-4 py-3 text-center">{r.final_score}</td>
                              <td className="px-4 py-3 text-center font-bold text-indigo-700">{r.total}</td>
                              <td className="px-4 py-3">
                                {r.grade || ''}
                                {teacherComment && <div className="mt-2 text-xs text-slate-700 bg-slate-50 p-2 rounded">Comment: {teacherComment}</div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-12 text-slate-400">
                    <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p className="font-medium">Final report not available yet</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Teacher comment editor */}
          {session?.role === 'teacher' && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 sm:px-6 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Teacher&apos;s Comment</h3>
                  <p className="text-xs text-slate-500">Visible to parents in the report & PDF</p>
                </div>
                <span className="text-xs text-slate-400">{teacherComment.length}/500</span>
              </div>
              <div className="p-4 sm:p-6">
                <textarea
                  value={teacherComment}
                  onChange={e => setTeacherComment(e.target.value)}
                  maxLength={500}
                  placeholder="Write an encouraging comment for this student's overall performance..."
                  className="w-full min-h-[110px] rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-indigo-100 focus:border-indigo-300 outline-none resize-y"
                />
                <div className="mt-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">This comment will appear on the PDF and parent view.</p>
                  <button
                    disabled={commentLoading}
                    onClick={saveTeacherComment}
                    className="h-10 px-5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60 flex items-center justify-center gap-2 shrink-0"
                  >
                    {commentLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    {commentLoading ? 'Saving...' : 'Save Comment'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {session?.role === 'parent' && teacherComment && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 sm:px-6 py-3 border-b border-slate-100 bg-indigo-50">
                <h3 className="text-sm font-bold text-slate-900">Teacher&apos;s Comment</h3>
                <p className="text-xs text-slate-600">From your child&apos;s teacher</p>
              </div>
              <div className="p-4 sm:p-6">
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-800 whitespace-pre-line leading-relaxed">{teacherComment}</div>
              </div>
            </div>
          )}

          {/* Branding footer inside report */}
          <div className="bg-slate-900 rounded-2xl p-4 sm:p-5 text-center">
            <p className="text-sm font-bold text-white">MBK International School</p>
            <p className="text-xs text-white/70">Dr. Abdishakuur Secondary College</p>
            <p className="text-[11px] text-white/50 mt-2">Generated on {new Date().toLocaleDateString()} • Academic Year {selectedYear?.name || ''} • {selectedTerm?.name || ''}</p>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {showPdfPreview && pdfUrl && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/60 backdrop-blur-sm p-2 sm:p-6" onClick={() => setShowPdfPreview(false)}>
          <div className="flex-1 flex flex-col bg-white rounded-2xl overflow-hidden shadow-2xl max-w-5xl w-full mx-auto" onClick={e => e.stopPropagation()}>
            <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                  <FileText className="w-4 h-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900">PDF Preview</p>
                  <p className="text-xs text-slate-500 hidden sm:block">Review before downloading or sharing</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (!pdfBlob || !student) return;
                    const a = document.createElement('a');
                    a.href = pdfUrl;
                    a.download = `${student.name.replace(/\s+/g, '_')}_${reportType}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}
                  className="h-9 px-4 rounded-xl bg-indigo-600 text-white text-sm font-semibold flex items-center gap-2 hover:bg-indigo-700"
                >
                  <Download className="w-4 h-4" />
                  Download
                </button>
                <button
                  onClick={handleShare}
                  className="h-9 px-4 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-medium flex items-center gap-2 hover:bg-slate-50 hidden sm:flex"
                >
                  <Share2 className="w-4 h-4" />
                  Share
                </button>
                <button onClick={() => setShowPdfPreview(false)} className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center">
                  <X className="w-4 h-4 text-slate-600" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-slate-100 p-2 sm:p-4 overflow-auto">
              <iframe src={pdfUrl} title="PDF Preview" className="w-full h-full min-h-[60vh] rounded-xl bg-white shadow" />
            </div>
            <div className="p-3 border-t border-slate-200 bg-white flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => {
                  setShowPdfPreview(false);
                  handleDownloadPdf();
                }}
                className="flex-1 h-11 rounded-xl bg-indigo-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-indigo-700"
              >
                <Download className="w-4 h-4" />
                Download PDF
              </button>
              <button
                onClick={openWhatsAppModal}
                disabled={noPhoneAvailable}
                className="flex-1 h-11 rounded-xl bg-emerald-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <MessageCircle className="w-4 h-4" />
                Send via WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}

      {/* WhatsApp Modal */}
      {showWhatsAppModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-6" onClick={() => setShowWhatsAppModal(false)}>
          <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-center justify-between rounded-t-3xl sm:rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500 flex items-center justify-center">
                  <MessageCircle className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Send Report to Parent</h3>
                  <p className="text-xs text-slate-500">Via WhatsApp</p>
                </div>
              </div>
              <button onClick={() => setShowWhatsAppModal(false)} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center">
                <X className="w-4 h-4 text-slate-600" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Parent info */}
              <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4">
                <p className="text-[11px] font-semibold tracking-wide uppercase text-slate-500 mb-2">Parent Contact</p>
                {noPhoneAvailable ? (
                  <div className="flex items-center gap-3 text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-3">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold">No parent phone number available</p>
                      <p className="text-xs text-amber-700/80 mt-0.5">Ask admin to add parent contact for {student?.name}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{parentName || 'Parent'}</p>
                        <p className="text-sm font-mono text-slate-700 mt-0.5">{normalizedPhone}</p>
                        <p className="text-xs text-slate-500 mt-1">{digitsForCheck} {hasValidPhone ? '✓ Valid' : '✕ Invalid'}</p>
                      </div>
                      <span className={cn('px-2.5 py-1 rounded-full text-xs font-bold border', hasValidPhone ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200')}>
                        {hasValidPhone ? 'Ready to send' : 'Fix number'}
                      </span>
                    </div>
                    {parentPhones.length > 1 && (
                      <div className="mt-3">
                        <label className="text-xs font-medium text-slate-600 mb-1.5 block">Choose number</label>
                        <select value={selectedParentPhone} onChange={e => setSelectedParentPhone(e.target.value)} className="w-full h-10 rounded-xl border border-slate-200 bg-white text-sm px-3">
                          {parentPhones.map(p => (
                            <option key={p} value={p}>
                              {formatInternationalPhone(p)} • {p}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Report info */}
              <div className="rounded-2xl bg-indigo-50 border border-indigo-100 p-4">
                <p className="text-[11px] font-semibold tracking-wide uppercase text-indigo-700 mb-1">Report</p>
                <p className="text-sm font-bold text-slate-900">
                  {reportType === 'Monthly' ? `${selectedMonth} Monthly` : reportType} Report — {student?.name}
                </p>
                <p className="text-xs text-slate-600 mt-1">
                  {student?.className} • {selectedYear?.name} • {selectedTerm?.name} • {overallDisplay}
                </p>
              </div>

              {/* Message editor */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">WhatsApp Message</label>
                <textarea
                  value={waMessage}
                  onChange={e => setWaMessage(e.target.value)}
                  rows={7}
                  className="w-full rounded-xl border border-slate-200 p-3 text-sm focus:ring-2 focus:ring-emerald-100 focus:border-emerald-300 outline-none resize-y"
                  placeholder="Edit message before sending..."
                />
                <p className="text-[11px] text-slate-500 mt-1.5">Message is generated dynamically — student, class, month and average are filled automatically.</p>
              </div>

              {/* Generate state */}
              {!waReady ? (
                <button
                  onClick={handleGenerateWhatsApp}
                  disabled={waGenerating || !hasValidPhone}
                  className="w-full h-12 rounded-xl bg-emerald-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {waGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  {waGenerating ? 'Preparing WhatsApp…' : 'Generate Report'}
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 flex items-center gap-2 text-sm font-medium text-emerald-800">
                    <Check className="w-4 h-4" />
                    PDF ready ✓ • Message prepared ✓
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={handleSharePdfForWhatsApp} className="h-11 rounded-xl bg-white border border-slate-200 text-slate-700 font-semibold text-sm flex items-center justify-center gap-2 hover:bg-slate-50">
                      <Share2 className="w-4 h-4" />
                      Share PDF
                    </button>
                    <button onClick={handleOpenWhatsApp} className="h-11 rounded-xl bg-emerald-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-emerald-700">
                      <MessageCircle className="w-4 h-4" />
                      Open WhatsApp
                    </button>
                  </div>

                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                    <p className="text-xs font-semibold text-amber-800">How it works on Android</p>
                    <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                      WhatsApp cannot auto-attach PDFs from the browser. Use <span className="font-semibold">Share PDF</span> to get the file, then tap <span className="font-semibold">Open WhatsApp</span> — your message will open with the parent&apos;s number. Attach the downloaded PDF manually in the chat.
                    </p>
                  </div>

                  {waPdfReady && pdfUrl && (
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-700">PDF Preview</span>
                        <button onClick={() => window.open(pdfUrl, '_blank')} className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
                          Open full
                        </button>
                      </div>
                      <div className="h-56 bg-slate-100">
                        <iframe src={pdfUrl} title="WhatsApp PDF" className="w-full h-full bg-white" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {waError && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 flex items-start gap-2 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-medium">{waError}</p>
                    <button onClick={handleGenerateWhatsApp} className="mt-2 text-xs font-semibold underline">
                      Retry
                    </button>
                  </div>
                </div>
              )}

              <p className="text-xs text-slate-400 text-center">Phone normalized: {digitsForCheck || '—'} → {normalizedPhone || '—'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Click-away for more menu */}
      {showMoreMenu && <div className="fixed inset-0 z-10" onClick={() => setShowMoreMenu(false)} />}

      {/* Global generating indicator */}
      {pdfGenerating && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center gap-3 z-40">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm font-medium">Generating PDF…</span>
        </div>
      )}
    </div>
  );
}

