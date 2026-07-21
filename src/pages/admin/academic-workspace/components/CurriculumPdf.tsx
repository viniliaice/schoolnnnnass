import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { AcademicYear, ClassSubject, Subject, Term, User } from '../../../../types';
import { CLASSES } from '../../../../types';
import { calculateTeacherWorkload, DEFAULT_WEEKLY_LESSONS, TEACHER_WEEKLY_LIMIT } from '../utils/workload';

const styles = StyleSheet.create({
  page: { padding: 28, fontFamily: 'Helvetica', fontSize: 10, color: '#0f172a' },
  header: { marginBottom: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1e40af' },
  subtitle: { fontSize: 11, marginTop: 4, color: '#475569' },
  section: { marginTop: 14 },
  sectionTitle: { fontSize: 13, fontWeight: 'bold', color: '#1e293b', marginBottom: 6 },
  row: { flexDirection: 'row', marginTop: 2 },
  label: { width: '40%', fontWeight: 'bold' },
  value: { width: '60%' },
  table: { marginTop: 6, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 4 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f1f5f9', paddingVertical: 4, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', fontWeight: 'bold', fontSize: 9 },
  tableRow: { flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 6, borderBottomWidth: 0.5, borderBottomColor: '#f1f5f9' },
  cellClass: { width: '30%' },
  cellSubject: { width: '35%' },
  cellTeacher: { width: '25%' },
  cellLessons: { width: '10%', textAlign: 'right' },
  workloadRow: { flexDirection: 'row', paddingVertical: 2, paddingHorizontal: 6 },
  workloadName: { width: '50%' },
  workloadValue: { width: '50%', textAlign: 'right' },
  footer: { marginTop: 24, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e2e8f0', fontSize: 8, color: '#94a3b8', textAlign: 'center' },
  badge: { fontSize: 8, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4 },
  note: { fontSize: 9, color: '#64748b', marginTop: 2 },
  warnText: { fontSize: 9, color: '#dc2626', marginTop: 2 },
});

function getSubjectName(row: any, subjectsById: Map<string, Subject>) {
  return row.subjects?.name || subjectsById.get(row.subjectId)?.name || row.subjectId;
}

function getTeacherName(row: any, teachersById: Map<string, User>) {
  return row.users?.name || teachersById.get(row.teacherId)?.name || 'Unassigned';
}

type MappingRow = ClassSubject & { subjects?: { name: string }; users?: { name: string } };

export function CurriculumPdfDocument({
  subjects,
  mappings,
  teachers,
  currentTerm,
  currentYear,
}: {
  subjects: Subject[];
  mappings: MappingRow[];
  teachers: User[];
  currentTerm: Term | null;
  currentYear: AcademicYear | undefined;
}) {
  const subjectsById = new Map(subjects.map(s => [s.id, s]));
  const teachersById = new Map(teachers.map(t => [t.id, t]));
  const workloadByTeacher = calculateTeacherWorkload(mappings, Object.fromEntries(subjects.map(s => [s.id, { weeklyLessons: s.weeklyLessons }])));
  const configuredClasses = CLASSES.filter(cn => mappings.some(r => r.className === cn)).length;
  const missingTeachers = mappings.filter(r => !r.teacherId).length;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Curriculum Plan</Text>
          <Text style={styles.subtitle}>
            Academic Year: {currentYear?.name || 'N/A'} &middot; Term: {currentTerm?.name || 'N/A'}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.row}><Text style={styles.label}>Classes configured:</Text><Text style={styles.value}>{configuredClasses} / {CLASSES.length}</Text></View>
          <View style={styles.row}><Text style={styles.label}>Subjects:</Text><Text style={styles.value}>{subjects.length}</Text></View>
          <View style={styles.row}><Text style={styles.label}>Total assignments:</Text><Text style={styles.value}>{mappings.length}</Text></View>
          <View style={styles.row}><Text style={styles.label}>Missing teachers:</Text><Text style={styles.value}>{missingTeachers}</Text></View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Class Curriculum</Text>
          {CLASSES.filter(cn => mappings.some(r => r.className === cn)).map(className => {
            const classMappings = mappings.filter(r => r.className === className);
            return (
              <View key={className} style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#2563eb', marginBottom: 3 }}>{className}</Text>
                <View style={styles.table}>
                  <View style={styles.tableHeader}>
                    <Text style={styles.cellSubject}>Subject</Text>
                    <Text style={styles.cellTeacher}>Teacher</Text>
                    <Text style={styles.cellLessons}>L/W</Text>
                  </View>
                  {classMappings.map(row => (
                    <View key={row.id} style={styles.tableRow}>
                      <Text style={styles.cellSubject}>{getSubjectName(row, subjectsById)}</Text>
                      <Text style={styles.cellTeacher}>{getTeacherName(row, teachersById)}</Text>
                      <Text style={styles.cellLessons}>{subjectsById.get(row.subjectId)?.weeklyLessons || DEFAULT_WEEKLY_LESSONS}</Text>
                    </View>
                  ))}
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Teacher Workload</Text>
          {Array.from(workloadByTeacher.entries()).map(([teacherId, workload]) => {
            const teacher = teachersById.get(teacherId);
            return (
              <View key={teacherId} style={styles.workloadRow}>
                <Text style={styles.workloadName}>{teacher?.name || teacherId}</Text>
                <Text style={[styles.workloadValue, { color: workload > TEACHER_WEEKLY_LIMIT ? '#dc2626' : '#16a34a' }]}>
                  {workload} / {TEACHER_WEEKLY_LIMIT} lessons
                </Text>
              </View>
            );
          })}
        </View>

        <View style={styles.footer}>
          <Text>Generated on {new Date().toLocaleDateString()} &middot; School Management System</Text>
        </View>
      </Page>
    </Document>
  );
}
