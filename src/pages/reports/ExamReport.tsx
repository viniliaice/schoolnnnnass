import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { useToast } from '../../context/ToastContext';
import {
  getStudents,
  getUserById,
  getStudentById,
  getStudentsByClasses,
  getStudentsByClass,
  getStudentsByParent,
  getClasses,
  getCurrentTerm,
  getMonthlyReport,
  getMidtermReport,
  getFinalReport,
  getReportComment,
  upsertReportComment,
  getReportCommentsForStudentTerm,
} from '../../lib/database';
import type { ReportComment } from '../../types';
import { Student, MONTHS, MonthlyScore } from '../../types';
import { PDFDownloadLink, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { MidtermReport, FinalReport } from '../../types';
import { Calendar, FileBarChart, FileText, Award } from 'lucide-react';
import { cn } from '../../utils/cn';

const pdfStyles = StyleSheet.create({
  page: { padding: 24, fontFamily: 'Helvetica', fontSize: 11, color: '#0f172a', backgroundColor: '#f8fafc' },
  header: { marginBottom: 12, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' },
  title: { fontSize: 18, fontWeight: 'bold', color: '#1e40af' },
  subtitle: { fontSize: 12, marginTop: 4, color: '#475569' },
  section: { marginTop: 12 },
  row: { display: 'flex', flexDirection: 'row', marginTop: 4 },
  cellLabel: { width: '30%', fontWeight: 'bold' },
  cellValue: { width: '70%' },
});

const ReportPdfDocument = ({
  student,
  reportType,
  parentName,
  parentPhone,
  summary,
  details,
}: {
  student: Student | null;
  reportType: string;
  parentName?: string;
  parentPhone?: string;
  summary: string;
  details: { label: string; value: string }[];
}) => (
  <Document>
    <Page size="A4" style={pdfStyles.page}>
      <View style={pdfStyles.header}>
        <Text style={pdfStyles.title}>{reportType} Student Report</Text>
        <Text style={pdfStyles.subtitle}>{student?.name ?? 'Student'} • {student?.className ?? ''}</Text>
      </View>

      <View style={pdfStyles.section}>
        <Text style={{ fontSize: 12, marginBottom: 8 }}>Parent contact</Text>
        <View style={pdfStyles.row}><Text style={pdfStyles.cellLabel}>Name:</Text><Text style={pdfStyles.cellValue}>{parentName || 'N/A'}</Text></View>
        <View style={pdfStyles.row}><Text style={pdfStyles.cellLabel}>Phone:</Text><Text style={pdfStyles.cellValue}>{parentPhone || 'N/A'}</Text></View>
      </View>

      <View style={pdfStyles.section}>
        <Text style={{ fontSize: 12, marginBottom: 8 }}>Summary</Text>
        <Text>{summary}</Text>
      </View>

      <View style={pdfStyles.section}>
        <Text style={{ fontSize: 12, marginBottom: 8 }}>Details</Text>
        {details.map((item, idx) => (
          <View key={idx} style={pdfStyles.row}>
            <Text style={pdfStyles.cellLabel}>{item.label}:</Text>
            <Text style={pdfStyles.cellValue}>{item.value}</Text>
          </View>
        ))}
      </View>
    </Page>
  </Document>
);

export function ExamReport({ initialStudentId }: { initialStudentId?: string } = {}) {
  const { session } = useRole();
  const { addToast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedStudent, setSelectedStudent] = useState(initialStudentId || '');
  const [teacherComment, setTeacherComment] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);
  const [reportComments, setReportComments] = useState<Record<string, ReportComment | undefined>>({});

  const [reportType, setReportType] = useState<'Monthly' | 'Midterm' | 'Final'>('Monthly');
  const [selectedMonth, setSelectedMonth] = useState(MONTHS[new Date().getMonth()]);

  const [parentPhones, setParentPhones] = useState<string[]>([]);
  const [selectedParentPhone, setSelectedParentPhone] = useState<string>('');
  const [parentName, setParentName] = useState<string>('');

  const [monthlyData, setMonthlyData] = useState<MonthlyScore[]>([]);
  const [midtermData, setMidtermData] = useState<MidtermReport | null>(null);
  const [finalData, setFinalData] = useState<FinalReport | null>(null);
  const [classes, setClasses] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState('All');
  const isSingleView = Boolean(initialStudentId);

  // Load available classes and set default selected class
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

  // Load students when selected class changes
  useEffect(() => {
    if (!session) return;
    if (!selectedClass) return;
    const loadByClass = async () => {
      setLoading(true);
      try {
        // Parent: only load their children
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
    if (!selectedStudent) return;

    const loadReport = async () => {
      setLoading(true);
      try {
        const term = await getCurrentTerm();
        if (!term) return;

        setCommentLoading(true);
        try {
          const c = await getReportComment(selectedStudent, term.id);
          setTeacherComment(c?.teacherComment || '');
        } catch (err) {
          // ignore
        } finally {
          setCommentLoading(false);
        }

        if (reportType === 'Monthly') {
          const rep = await getMonthlyReport(selectedStudent, term.id);
          setMonthlyData(rep || []);
        } else if (reportType === 'Midterm') {
          const rep = await getMidtermReport(selectedStudent, term.id);
          setMidtermData(rep || null);
        } else if (reportType === 'Final') {
          const rep = await getFinalReport(selectedStudent, term.id);
          setFinalData(rep || null);
        }

        try {
          const comments = await getReportCommentsForStudentTerm(selectedStudent, term.id);
          const map: Record<string, ReportComment | undefined> = {};
          for (const c of comments) {
            if (c.examId) map[c.examId] = c as any;
          }
          setReportComments(map);
        } catch (err) {
          // ignore
        }
      } finally {
        setLoading(false);
      }
    };

    loadReport();
  }, [selectedStudent, reportType]);

  const student = students.find(s => s.id === selectedStudent);

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
      const phones = [parent.phone1, parent.phone2].filter(phone => !!phone && phone.trim());
      setParentPhones(phones as string[]);
      setSelectedParentPhone(phones[0] || '');
    };
    loadParent();
  }, [student]);

  // Monthly UI
  const monthlyFiltered = monthlyData.filter(d => d.month === selectedMonth);
  const overallMonthly = monthlyFiltered.length
    ? Math.round(monthlyFiltered.reduce((s, d) => s + d.average, 0) / monthlyFiltered.length)
    : 0;

  const overallMidterm = Array.isArray(midtermData?.scores) && midtermData.scores.length > 0
    ? Math.round(midtermData.scores.reduce((s, sc) => s + sc.percentage, 0) / midtermData.scores.length)
    : 0;

  const overallFinal = Array.isArray(finalData?.results) && finalData.results.length > 0
    ? Math.round(finalData.results.reduce((s, r) => s + r.total, 0) / finalData.results.length)
    : 0;

  // Export report content as printable window (user can choose Save as PDF)
  const exportReportAsPdf = () => {
    const el = document.getElementById('report-content');
    if (!el) {
      addToast({ type: 'error', title: 'Export failed', description: 'Report content not available' });
      return;
    }
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      addToast({ type: 'error', title: 'Export failed', description: 'Unable to open print window' });
      return;
    }
    const title = `Report - ${student?.name || 'student'}`;
    const extraMeta = `<div><strong>Parent:</strong> ${parentName || 'N/A'}<br/><strong>Selected phone:</strong> ${selectedParentPhone || 'N/A'}</div>`;
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
      body{font-family:Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial; padding:20px; background:#f8fafc; color:#0f172a;}
      .report-container{max-width:960px;margin:auto;background:#ffffff;padding:24px;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 4px 20px rgba(15,23,42,.08);}
      .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
      .header h1{font-size:28px;margin:0;color:#1e3a8a;}
      .stats{font-size:14px;color:#475569;margin-top:4px;}
      .meta{margin-bottom:16px;color:#334155;}
      table{width:100%;border-collapse:collapse;background:#ffffff;}
      th,td{padding:10px;border:1px solid #e2e8f0;text-align:left;}
      th{background:#e0e7ff;color:#1e3a8a;font-weight:700;}
      .footer{margin-top:20px;font-size:12px;color:#64748b;}
    </style></head><body><div class="report-container"><div class="header"><h1>${title}</h1><div class="stats">${reportType} | ${selectedMonth}</div></div><div class="meta">${extraMeta}</div>${el.innerHTML}<div class="footer">Generated through Scholo report</div></div></body></html>`);
    printWindow.document.close();
    printWindow.focus();
    // Give a small delay for images/styles to load
    setTimeout(() => {
      printWindow.print();
      // Do not auto-close so user can cancel/inspect; close after a short timeout
      setTimeout(() => printWindow.close(), 1000);
    }, 300);
  };

  // Save report content as an HTML file to the user's computer
  const saveReportToFile = () => {
    const el = document.getElementById('report-content');
    if (!el) {
      addToast({ type: 'error', title: 'Save failed', description: 'Report content not available' });
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Report - ${student?.name || 'student'}</title></head><body>${el.innerHTML}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = `report-${(student?.name || 'report').replace(/\s+/g, '_')}.html`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    addToast({ type: 'success', title: 'Saved', description: `Report saved as ${name}` });
  };

  // Share via WhatsApp using parent's phone number(s)
  const shareToWhatsApp = async () => {
    if (!student) {
      addToast({ type: 'error', title: 'Share failed', description: 'No student selected' });
      return;
    }
    if (!student.parentId) {
      addToast({ type: 'error', title: 'Share failed', description: 'Student has no parent linked' });
      return;
    }
    try {
      const parent = await getUserById(student.parentId);
      if (!parent) {
        addToast({ type: 'error', title: 'Share failed', description: 'Parent not found' });
        return;
      }
      const phone = selectedParentPhone || parent.phone1 || parent.phone2;
      if (!phone) {
        addToast({ type: 'error', title: 'Share failed', description: 'Parent has no phone number selected' });
        return;
      }
      const overall = reportType === 'Monthly' ? `${overallMonthly}%` : reportType === 'Midterm' ? `${overallMidterm}%` : `${overallFinal}%`;
      const text = `Exam report for ${student.name} (${student.className}) - ${reportType} overall: ${overall}. parent: ${parentName || ''}, phone: ${phone}.`;
      const wa = `https://wa.me/${phone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`;
      window.open(wa, '_blank');
    } catch (err) {
      addToast({ type: 'error', title: 'Share failed', description: String(err) });
    }
  };

  // Save teacher comment to DB
  const saveTeacherComment = async () => {
    if (!selectedStudent) {
      addToast({ type: 'error', title: 'Save failed', description: 'No student selected' });
      return;
    }
    setCommentLoading(true);
    try {
      const term = await getCurrentTerm();
      if (!term) throw new Error('No current term');
      const payload = {
        studentId: selectedStudent,
        termId: term.id,
        teacherComment: teacherComment || '',
        teacherId: session?.userId || undefined,
      } as any;
      const res = await upsertReportComment(payload);
      if (res) {
        addToast({ type: 'success', title: 'Saved', description: 'Teacher comment saved' });
      } else {
        addToast({ type: 'error', title: 'Save failed', description: 'Could not save comment' });
      }
    } catch (err) {
      addToast({ type: 'error', title: 'Save failed', description: String(err) });
    } finally {
      setCommentLoading(false);
    }
  };

  // Build report section (avoid deep inline ternaries to keep JSX clear)
  const reportSection = !student ? (
    <div className="text-center py-12 text-slate-400">{loading ? 'Loading...' : 'No students available'}</div>
  ) : (
    <div>
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">{reportType} Report {reportType === 'Monthly' ? `— ${selectedMonth}` : ''}</h2>
              <p className="text-sm text-white/80">{student?.name} · {student?.className}</p>
            </div>
            <div className="text-right flex flex-col sm:flex-row sm:items-center gap-3">
              <div>
                <p className="text-3xl font-bold text-white">{reportType === 'Monthly' ? `${overallMonthly}%` : reportType === 'Midterm' ? `${overallMidterm}%` : `${overallFinal}%`}</p>
                <p className="text-xs text-white/70">{reportType === 'Monthly' ? 'Monthly Avg' : reportType === 'Midterm' ? 'Midterm Avg' : 'Final Avg'}</p>
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <button onClick={() => exportReportAsPdf()} className="px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-xs font-medium">Export PDF</button>
                <button onClick={() => saveReportToFile()} className="px-3 py-1.5 rounded-lg bg-white text-slate-700 text-xs font-medium">Save</button>
                <PDFDownloadLink
                  document={<ReportPdfDocument
                    student={student}
                    reportType={reportType}
                    parentName={parentName}
                    parentPhone={selectedParentPhone}
                    summary={`${reportType} report for ${student?.name || ''}`}
                    details={
                      reportType === 'Monthly' ? monthlyFiltered.map(m => ({label: m.subject, value: `${m.average}%`})) :
                      reportType === 'Midterm' ? midtermData?.scores.map(s => ({label: s.subject, value: `${s.percentage}%`})) || [] :
                      (Array.isArray(finalData?.results) ? finalData.results.map(r => ({ label: r.subject, value: `${r.total}` })) : [])
                    }
                  />}
                  fileName={`${student?.name?.replace(/\s+/g,'_') || 'report'}_${reportType}.pdf`}
                >
                  {({ loading }) => (
                    <button
                      className="px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-medium"
                      disabled={loading}
                    >
                      {loading ? 'Generating PDF...' : 'Download PDF'}
                    </button>
                  )}
                </PDFDownloadLink>
                <button onClick={() => shareToWhatsApp()} className="px-3 py-1.5 rounded-lg bg-white text-green-700 text-xs font-medium">Send WhatsApp</button>
              </div>

              <div className="flex items-center gap-2 mt-3 text-sm text-white">
                <label htmlFor="parent-phone" className="font-medium">Parent number to send:</label>
                <select
                  id="parent-phone"
                  value={selectedParentPhone}
                  onChange={e => setSelectedParentPhone(e.target.value)}
                  className="rounded-lg px-2 py-1 text-slate-800 text-xs"
                >
                  {parentPhones.length === 0 ? (
                    <option value="">No parent phones</option>
                  ) : (
                    parentPhones.map((phone, idx) => (
                      <option key={`${phone}-${idx}`} value={phone}>{phone}</option>
                    ))
                  )}
                </select>
              </div>
            </div>
          </div>
        </div>

        <div id="report-content">
          {/* Details */}
          {reportType === 'Monthly' && (
            monthlyFiltered.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Subject</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Avg</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 uppercase">Assessments</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyFiltered.map(m => (
                      <tr key={m.subject} className="border-b last:border-b-0">
                        <td className="px-4 py-3">{m.subject}</td>
                        <td className="px-4 py-3 text-center font-semibold">{m.average}%</td>
                        <td className="px-4 py-3 text-center">{m.assessment_count}</td>
                        <td className="px-4 py-3">
                          <div className="text-xs text-slate-600">
                            {m.details.map((d, i) => (
                              <div key={i} className="mb-1">
                                <span className="font-semibold">{d.type}</span>: {d.score}/{d.total} ({d.percentage}%) — <span className="text-slate-500">{d.date}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">
                <Calendar className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="font-medium">No CA data available for {selectedMonth}</p>
              </div>
            )
          )}
          {reportType === 'Midterm' && (
            midtermData && midtermData.scores.length > 0 ? (
              <div className="overflow-x-auto">
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
                        <td className="px-4 py-3">{s.subject}</td>
                        <td className="px-4 py-3 text-center">{s.score}</td>
                        <td className="px-4 py-3 text-center">{s.total}</td>
                        <td className="px-4 py-3 text-center">{s.percentage}%</td>
                        <td className="px-4 py-3 text-center">{s.grade}</td>
                        <td className="px-4 py-3">{s.remark}
                          {s.examId && reportComments[s.examId] && (
                            <div className="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">Comment: {reportComments[s.examId]?.teacherComment}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">No midterm results available</div>
            )
          )}
          {reportType === 'Final' && (
            finalData?.results && finalData.results.length > 0 ? (
              <div className="overflow-x-auto">
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
                    {finalData?.results.map(r => (
                      <tr key={r.subject} className="border-b last:border-b-0">
                        <td className="px-4 py-3">{r.subject}</td>
                        <td className="px-4 py-3 text-center">{r.ca_avg}</td>
                        <td className="px-4 py-3 text-center">{r.midterm_score}</td>
                        <td className="px-4 py-3 text-center">{r.final_score}</td>
                        <td className="px-4 py-3 text-center">{r.total}</td>
                        <td className="px-4 py-3">{(r as any).grade || ''}
                          {/* final RPC might not include examId per row; show general teacherComment if present */}
                          {teacherComment && (
                            <div className="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">Comment: {teacherComment}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 text-slate-400">Final report not available yet</div>
            )
          )}
        </div>
      </div>

      {/* Teacher comment editor for teachers */}
      {session?.role === 'teacher' && (
        <div className="p-4 border-t border-slate-100 bg-white">
          <label className="text-sm font-semibold text-slate-600 mb-2 block">Teacher's Comment</label>
          <textarea value={teacherComment} onChange={e => setTeacherComment(e.target.value)} className="w-full rounded-lg border p-3 min-h-[100px]" />
          <div className="mt-2 flex justify-end">
            <button
              disabled={commentLoading}
              onClick={() => saveTeacherComment()}
              className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm"
            >
              {commentLoading ? 'Saving...' : 'Save Comment'}
            </button>
          </div>
        </div>
      )}

      {/* Parent (and other viewers) see teacher comment */}
      {session?.role === 'parent' && teacherComment && (
        <div className="p-4 border-t border-slate-100 bg-white">
          <label className="text-sm font-semibold text-slate-600 mb-2 block">Teacher's Comment</label>
          <div className="w-full rounded-lg border p-3 min-h-[80px] text-slate-800 whitespace-pre-line">{teacherComment}</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exam Reports</h1>
        <p className="text-slate-500 mt-1">View Monthly, Midterm or Final reports for your students</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-end">
        {!isSingleView ? (
          <>
            <div className="w-56">
              <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Class</label>
              <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)}
                className="w-full px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm">
                <option value="All">All classes</option>
                {classes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className="flex-1 min-w-0">
              <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Student</label>
              <select title={students.find(s => s.id === selectedStudent)?.name || ''} value={selectedStudent} onChange={e => setSelectedStudent(e.target.value)}
                className="w-full px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm truncate">
                <option value="">-- Select student --</option>
                {students.map(s => (
                  <option key={s.id} value={s.id}>{s.name} · {s.className}</option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div className="flex-1 min-w-0">
            <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Student</label>
            <div className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm">{students[0]?.name} · {students[0]?.className}</div>
          </div>
        )}

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Report Type</label>
          <div className="flex gap-2">
            {(['Monthly', 'Midterm', 'Final'] as const).map(rt => (
              <button key={rt} onClick={() => setReportType(rt)}
                className={cn('px-4 py-2 rounded-xl text-sm font-medium transition-all',
                  reportType === rt ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 border border-slate-200')}
              >{rt}</button>
            ))}
          </div>
        </div>

        {reportType === 'Monthly' && (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Month</label>
            <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
              className="px-4 py-2 rounded-xl border border-slate-200 text-sm bg-white">
              {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      {reportSection}
    </div>
  );
}

