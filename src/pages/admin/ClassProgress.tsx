import { useMemo, useState } from 'react';
import { useClassMonths, useClassNames, useClassStudentSubjectProgress, useTeacherExamProgress } from '../../lib/hooks';
import { MONTHS, TeacherExamProgress } from '../../types';

const getCardTintClasses = (percent: number) => {
  if (percent <= 30) return 'bg-rose-50/90 border-rose-200 text-rose-900';
  if (percent <= 70) return 'bg-amber-50/90 border-amber-200 text-amber-900';
  return 'bg-emerald-50/90 border-emerald-200 text-emerald-900';
};

const getRequiredEntryInfo = (row: TeacherExamProgress) => {
  const quizDone = row.quizEntered > 0;
  const caDone = row.caEntered > 0;
  const homeworkDone = row.homeworkEntered > 0;
  const classworkDone = row.classworkEntered > 0;
  const attendanceDone = row.attendanceEntered > 0;

  const requiredItems = caDone ? ['CA','Quiz'] : ['Quiz', 'Homework', 'Classwork', 'Attendance'];
  const completedItems = [
    quizDone ? 'Quiz' : null,
    caDone ? 'CA' : null,
    homeworkDone ? 'Homework' : null,
    classworkDone ? 'Classwork' : null,
    attendanceDone ? 'Attendance' : null,
  ].filter(Boolean) as string[];

  const completedCount = row.completedEntries ?? completedItems.length;
  const requiredCount = row.requiredEntries ?? requiredItems.length;
  const displayPercent = typeof row.completionPercent === 'number' ? Math.round(row.completionPercent) : requiredCount > 0 ? Math.round((completedCount / requiredCount) * 100) : 0;
  const isComplete = row.completionStatus === 'complete' || displayPercent === 100;

  return { requiredItems, completedItems, completedCount, requiredCount, displayPercent, isComplete };
};

export function ClassProgress() {
  const [selectedClass, setSelectedClass] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');

  const classQuery = useClassNames();
  const monthQuery = useClassMonths(selectedClass, {
    enabled: Boolean(selectedClass),
  });
  const progressQuery = useTeacherExamProgress(
    { className: selectedClass, month: selectedMonth },
    {
      enabled: Boolean(selectedClass && selectedMonth),
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
      retry: false,
    }
  );
  const studentProgressQuery = useClassStudentSubjectProgress(selectedClass, selectedMonth, {
    enabled: Boolean(selectedClass && selectedMonth),
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const classOptions = classQuery.data ?? [];
  const monthOptions = monthQuery.data ?? [];
  const rows = progressQuery.data ?? [];
  const studentRows = studentProgressQuery.data ?? [];

  const kpis = useMemo(() => ({
    totalRecords: rows.length,
    complete: rows.filter(r => r.completionStatus === 'complete').length,
    incomplete: rows.filter(r => r.completionStatus !== 'complete').length,
    totalTeachers: new Set(rows.map(r => r.teacherId)).size,
  }), [rows]);

  const handleClassChange = (value: string) => {
    setSelectedClass(value);
    setSelectedMonth('');
  };

  const showPrompt = !selectedClass || !selectedMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Class Progress by Month</h1>
        <p className="text-slate-500 mt-1">Choose a class, then select a month to load that class's exam entry progress.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
          <label className="block text-sm font-semibold text-slate-700 mb-2">Class</label>
          <select
            value={selectedClass}
            onChange={e => handleClassChange(e.target.value)}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900"
          >
            <option value="">Select class</option>
            {classOptions.map((className) => (
              <option key={className} value={className}>{className}</option>
            ))}
          </select>
          {classQuery.isFetching && <p className="mt-2 text-xs text-slate-500">Loading classes…</p>}
          {classQuery.isError && <p className="mt-2 text-xs text-rose-600">Unable to load classes.</p>}
        </div>

        <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
          <label className="block text-sm font-semibold text-slate-700 mb-2">Month</label>
          <select
            value={selectedMonth}
            onChange={e => setSelectedMonth(e.target.value)}
            disabled={!selectedClass || monthQuery.isFetching}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            <option value="">Select month</option>
            {monthOptions.map((month) => (
              <option key={month} value={month}>{month}</option>
            ))}
          </select>
          {selectedClass && monthQuery.isFetching && <p className="mt-2 text-xs text-slate-500">Loading months…</p>}
          {selectedClass && monthQuery.isError && <p className="mt-2 text-xs text-rose-600">Unable to load months.</p>}
        </div>

        <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
          <p className="text-sm text-slate-500">Result load state</p>
          <div className="mt-4 text-3xl font-semibold text-slate-900">{selectedMonth && selectedClass ? rows.length : '—'}</div>
          <p className="mt-2 text-sm text-slate-500">Records loaded</p>
        </div>
      </div>

      {showPrompt ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-slate-500">
          {selectedClass ? 'Choose a month to load the class report.' : 'Choose a class first.'}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
              <p className="text-sm text-slate-500">Teachers</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{kpis.totalTeachers}</p>
            </div>
            <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
              <p className="text-sm text-slate-500">Complete rows</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{kpis.complete}</p>
            </div>
            <div className="rounded-3xl bg-white border border-slate-200 p-4 shadow-sm">
              <p className="text-sm text-slate-500">Incomplete rows</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">{kpis.incomplete}</p>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Class entries</h2>
                <p className="text-sm text-slate-500">{selectedClass} · {selectedMonth}</p>
              </div>
              {progressQuery.isFetching && <div className="text-sm text-slate-500">Loading data…</div>}
            </div>

            {progressQuery.isError ? (
              <div className="py-16 text-center text-rose-600">Unable to load class progress. Try again.</div>
            ) : rows.length === 0 ? (
              <div className="py-16 text-center text-slate-500">No records found for this class and month.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-600">
                      <th className="px-3 py-3">#</th>
                      <th className="px-3 py-3">Teacher</th>
                      <th className="px-3 py-3">Subject</th>
                      <th className="px-3 py-3">Progress</th>
                      <th className="px-3 py-3">Status</th>
                      <th className="px-3 py-3">Class size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => {
                      const info = getRequiredEntryInfo(row);
                      return (
                        <tr key={`${row.teacherId}-${row.subjectId}-${row.month}`} className="border-b border-slate-100 last:border-none">
                          <td className="px-3 py-3 text-slate-700">{idx + 1}</td>
                          <td className="px-3 py-3 text-slate-900 font-medium">{row.teacherName}</td>
                          <td className="px-3 py-3 text-slate-700">{row.subjectName || row.subjectId}</td>
                          <td className="px-3 py-3">
                            <div className="mb-1 text-xs text-slate-500">{info.completedCount}/{info.requiredCount} entered</div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                              <div className={`h-full rounded-full ${info.isComplete ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${info.displayPercent}%` }} />
                            </div>
                            <div className="text-xs mt-1 text-slate-500">{info.displayPercent}%</div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${info.isComplete ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                              {info.isComplete ? 'Complete' : 'Incomplete'}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-slate-700">{row.totalStudents || 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Student subject entries</h2>
                <p className="text-sm text-slate-500">Each row shows a student, a subject, and the entered exam scores for that month.</p>
              </div>
              {studentProgressQuery.isFetching && <div className="text-sm text-slate-500">Loading student entries…</div>}
            </div>

            {studentProgressQuery.isError ? (
              <div className="py-16 text-center text-rose-600">Unable to load student entries. Try again.</div>
            ) : studentRows.length === 0 ? (
              <div className="py-16 text-center text-slate-500">No student entries found for this class and month.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-600">
                      <th className="px-3 py-3">Student / Subject</th>
                      <th className="px-3 py-3">Entered scores</th>
                      <th className="px-3 py-3">Exam rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentRows.map((row) => (
                      <tr key={`${row.studentId}-${row.subject}`} className="border-b border-slate-100 last:border-none">
                        <td className="px-3 py-3 text-slate-900">
                          <div className="font-medium">{row.studentName}</div>
                          <div className="text-xs text-slate-500">{row.subject}</div>
                        </td>
                        <td className="px-3 py-3 text-slate-700">
                  {/* Use optional chaining and fallback to empty array */}
{(row.examEntries?.length ?? 0) > 0 ? (
  row.examEntries?.map((entry, entryIdx) => (
    // Added entryIdx to key to ensure uniqueness
    <div key={`${entry.examType}-${entryIdx}`} className="mb-1">
      <span className="font-semibold text-slate-900">{entry.examType}:</span> {entry.score}/{entry.total}
    </div>
  ))
) : (
  <span className="text-slate-500">No entries recorded</span>
)}
                        </td>
                        <td className="px-3 py-3 text-slate-700">{row.totalExamRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
