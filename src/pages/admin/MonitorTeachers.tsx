import { useEffect, useMemo, useState } from 'react';
import { useAvailableMonths, useTeacherExamProgress, useTeacherExamProgressVerification } from '../../lib/hooks';
import { MONTHS, TeacherExamProgress } from '../../types';
import HeatMap from '../../components/HeatMap/HeatMap';

const getCardTintClasses = (percent: number) => {
  if (percent <= 30) return 'bg-rose-50/90 border-rose-200 text-rose-900';
  if (percent <= 70) return 'bg-amber-50/90 border-amber-200 text-amber-900';
  return 'bg-emerald-50/90 border-emerald-200 text-emerald-900';
};

const getRequiredEntryInfo = (detail: TeacherExamProgress) => {
  const quizDone = detail.quizEntered > 0;
  const caDone = detail.caEntered > 0;
  const homeworkDone = detail.homeworkEntered > 0;
  const classworkDone = detail.classworkEntered > 0;
  const attendanceDone = detail.attendanceEntered > 0;

  const requiredItems = caDone
    ? ['CA','Quiz']
    : ['Quiz', 'Homework', 'Classwork', 'Attendance'];

  const completedRequiredItems = caDone
    ? ['CA']
    : [
        quizDone ? 'Quiz' : null,
        homeworkDone ? 'Homework' : null,
        classworkDone ? 'Classwork' : null,
        attendanceDone ? 'Attendance' : null,
      ].filter(Boolean) as string[];

  const allCompletedItems = [
    quizDone ? 'Quiz' : null,
    caDone ? 'CA' : null,
    homeworkDone ? 'Homework' : null,
    classworkDone ? 'Classwork' : null,
    attendanceDone ? 'Attendance' : null,
  ].filter(Boolean) as string[];

  const requiredCount = detail.requiredEntries ?? requiredItems.length;
  const completedCount = detail.completedEntries ?? completedRequiredItems.length;
  const displayPercent = typeof detail.completionPercent === 'number'
    ? Math.round(detail.completionPercent)
    : requiredCount > 0
      ? Math.round((completedCount / requiredCount) * 100)
      : 0;
  const isComplete =
    detail.completionStatus === 'complete' ||
    displayPercent === 100 ||
    (caDone && requiredCount === 1 && completedCount === 1);

  return {
    requiredItems,
    completedRequiredItems,
    completedItems: allCompletedItems,
    requiredCount,
    completedCount,
    displayPercent,
    isComplete,
    quizDone,
    caDone,
    homeworkDone,
    classworkDone,
    attendanceDone,
  };
};

const getStatusBadgeClasses = (status: 'complete' | 'incomplete') =>
  status === 'complete' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800';

export function MonitorTeachers({ classNames, initialMonth, initialClass }: { classNames?: string[]; initialMonth?: string; initialClass?: string } = {}) {
  const [selectedMonth, setSelectedMonth] = useState<string>(initialMonth || '');
  const [selectedClass, setSelectedClass] = useState<string>(initialClass || '');
  const [activeTab, setActiveTab] = useState<'table' | 'heat'>('table');
  const [selectedDetail, setSelectedDetail] = useState<TeacherExamProgress | null>(null);

  const progressQuery = useTeacherExamProgress({ classNames });
  const monthsQuery = useAvailableMonths();
  const verificationQuery = useTeacherExamProgressVerification(
    {
      teacherId: selectedDetail?.teacherId ?? '',
      className: selectedDetail?.className ?? '',
      subjectId: selectedDetail?.subjectId ?? '',
      subjectName: selectedDetail?.subjectName ?? '',
      month: selectedDetail?.month ?? '',
    },
    {
      enabled: Boolean(selectedDetail),
      staleTime: 5 * 60 * 1000,
    }
  );

  const rows = (progressQuery.data ?? []) as TeacherExamProgress[];
  const monthOptions = useMemo<string[]>(() => {
    const inferredMonths = rows.map((r) => r.month);
    const sourceMonths = (monthsQuery.data as string[] | undefined) ?? inferredMonths;
    return Array.from(new Set(sourceMonths)).sort((a, b) => MONTHS.indexOf(a) - MONTHS.indexOf(b));
  }, [rows, monthsQuery.data]);

  const classes = useMemo<string[]>(() => Array.from(new Set(rows.map((r) => r.className))).sort(), [rows]);
  const loading = progressQuery.isLoading || monthsQuery.isLoading;

  useEffect(() => {
    if (!selectedMonth && monthOptions.length > 0) {
      setSelectedMonth(monthOptions[0]);
    }
  }, [monthOptions, selectedMonth]);

  const displayRows = rows.filter(r => (!selectedMonth || r.month === selectedMonth) && (!selectedClass || r.className === selectedClass));

  const kpis = useMemo(() => {
    const totalRecords = displayRows.length;
    const complete = displayRows.filter(r => r.completionStatus === 'complete').length;
    const incomplete = totalRecords - complete;
    const totalTeachers = new Set(displayRows.map(r => r.teacherId)).size;
    return { totalRecords, complete, incomplete, totalTeachers };
  }, [displayRows]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Monitor Teacher Entries</h1>
        <p className="text-slate-500 mt-1">Monitor teacher monthly exam entry completion across classes.</p>
      </div>

      <div className="flex flex-wrap gap-2 bg-white rounded-lg p-1 shadow-sm">
        <button onClick={() => setActiveTab('table')} className={`px-3 py-2 rounded ${activeTab === 'table' ? 'bg-slate-100' : ''}`}>Progress Table</button>
        <button onClick={() => setActiveTab('heat')} className={`px-3 py-2 rounded ${activeTab === 'heat' ? 'bg-slate-100' : ''}`}>Heat Map</button>
      </div>

      <div className="flex gap-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">Month</label>
          <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} className="rounded px-3 py-2 border">
            <option value="">All</option>
            {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600">Class</label>
          <select value={selectedClass} onChange={e => setSelectedClass(e.target.value)} className="rounded px-3 py-2 border">
            <option value="">All</option>
            {classes.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-4 text-sm text-slate-600">Showing {displayRows.length} records • Teachers: {kpis.totalTeachers}</div>
        {activeTab === 'table' ? (
          <>
            <div className="space-y-3 md:hidden">
              {displayRows.map((row, idx) => {
                const info = getRequiredEntryInfo(row);
                return (
                  <article
                    key={`${row.teacherId}-${row.subjectId}-${row.className}-${row.month}`}
                    className={`overflow-hidden rounded-3xl border p-4 shadow-sm ${getCardTintClasses(row.completionPercent)}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-600">{row.className}</p>
                        <p className="text-base font-semibold text-slate-900">{row.teacherName}</p>
                        <p className="text-sm text-slate-600">{row.subjectName || row.subjectId}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-3xl font-semibold tracking-tight">{info.displayPercent}%</p>
                        <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getStatusBadgeClasses(info.isComplete ? 'complete' : 'incomplete')}`}>
                          {info.isComplete ? '✅ Complete' : '⚠️ Incomplete'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                        <span className="rounded-2xl bg-white/90 px-3 py-2">{row.month}</span>
                        <span className="rounded-2xl bg-white/90 px-3 py-2">{info.completedCount}/{info.requiredCount} entered</span>
                        <span className="rounded-2xl bg-white/90 px-3 py-2">Class size {row.totalStudents || '—'}</span>
                        {info.completedItems.length > 0 && (
                          <span className="rounded-2xl bg-slate-100 px-3 py-2 text-slate-600">{info.completedItems.join(', ')}</span>
                        )}
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.25em] text-slate-500">
                          <span>Progress</span>
                          <span>{row.completionPercent}%</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={`h-full rounded-full ${info.isComplete ? 'bg-emerald-500' : 'bg-amber-500'}`}
                            style={{ width: `${info.displayPercent}%` }}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedDetail(row)}
                          className="flex-1 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-100"
                        >
                          View details
                        </button>
                        <button className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm">🔔</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-600">
                    <th className="px-3 py-3">#</th>
                    <th className="px-3 py-3">Teacher</th>
                    <th className="px-3 py-3">Class</th>
                    <th className="px-3 py-3">Subject</th>
                    <th className="px-3 py-3">Month</th>
                    <th className="px-3 py-3">Progress</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Missing Entries</th>
                    <th className="px-3 py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, idx) => {
                    const info = getRequiredEntryInfo(row);
                    return (
                      <tr key={`${row.teacherId}-${row.subjectId}-${row.className}-${row.month}`} className="border-b border-slate-100 last:border-none">
                        <td className="px-3 py-3 text-slate-700">{idx + 1}</td>
                        <td className="px-3 py-3 text-slate-900 font-medium">{row.teacherName}</td>
                        <td className="px-3 py-3 text-slate-700">{row.className}</td>
                        <td className="px-3 py-3 text-slate-700">{row.subjectName || row.subjectId}</td>
                        <td className="px-3 py-3 text-slate-700">{row.month}</td>
                        <td className="px-3 py-3">
                          <div className="mb-2 text-xs text-slate-500">{info.completedCount}/{info.requiredCount} entered</div>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                            <div
                              className={`h-full rounded-full ${info.isComplete ? 'bg-emerald-500' : 'bg-amber-500'}`}
                              style={{ width: `${info.displayPercent}%` }}
                            />
                          </div>
                          <div className="text-xs mt-1">{info.displayPercent}%</div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${info.isComplete ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                            {info.isComplete ? '✅ Complete' : '⚠️ Incomplete'}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          {row.missingExamTypes && row.missingExamTypes.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {row.missingExamTypes.map(type => (
                                <span key={type} className="rounded-full bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700">CA: {type}</span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-500">✓ All submitted</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedDetail(row)}
                            className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {selectedDetail && (
              <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/30 p-4">
                <div className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-3xl bg-white shadow-2xl">
                  <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.28em] text-slate-500">Entry details</p>
                      <p className="mt-1 text-lg font-semibold text-slate-900">{selectedDetail.className} • {selectedDetail.teacherName}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedDetail(null)}
                      className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-slate-200"
                    >
                      Close
                    </button>
                  </div>
                  <div className="space-y-4 px-5 py-5 text-sm text-slate-700">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <DetailCard label="Subject" value={selectedDetail.subjectName || selectedDetail.subjectId} />
                      <DetailCard label="Month" value={selectedDetail.month} />
                    </div>
                    <div className="rounded-3xl bg-slate-50 p-4">
                      <div className="flex items-center justify-between text-xs uppercase tracking-[0.28em] text-slate-500">
                        <span>Completion</span>
                        <span>{selectedDetail.completionPercent}%</span>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className={`h-full rounded-full ${selectedDetail.completionPercent === 100 ? 'bg-emerald-500' : 'bg-amber-500'}`}
                          style={{ width: `${selectedDetail.completionPercent}%` }}
                        />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <DetailCard label="CA entered" value={selectedDetail.caEntered} />
                      <DetailCard label="Homework entered" value={selectedDetail.homeworkEntered} />
                      <DetailCard label="Classwork entered" value={selectedDetail.classworkEntered} />
                      <DetailCard label="Attendance entered" value={selectedDetail.attendanceEntered} />
                      <DetailCard label="Quiz entered" value={selectedDetail.quizEntered} />
                      <DetailCard label="Class size" value={selectedDetail.totalStudents} />
                    </div>
                    {(() => {
                      const entryInfo = getRequiredEntryInfo(selectedDetail);
                      return (
                        <>
                          <div className="rounded-3xl bg-slate-100 p-4 text-sm text-slate-600">
                            <p className="font-semibold text-slate-900">Required entries</p>
                            <p className="mt-2">{entryInfo.completedCount} of {entryInfo.requiredCount} items entered</p>
                            <p className="mt-2 text-xs text-slate-500">Required: {entryInfo.requiredItems.join(' + ')}</p>
                            <p className="mt-1 text-xs text-slate-500">Completed: {entryInfo.completedItems.length > 0 ? entryInfo.completedItems.join(', ') : 'None'}</p>
                          </div>
                          <div className="rounded-3xl bg-slate-100 p-4 text-sm text-slate-600">
                            <div className="flex items-center justify-between">
                              <p className="font-semibold text-slate-900">Database verification</p>
                              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${verificationQuery.isSuccess ? 'bg-emerald-100 text-emerald-800' : verificationQuery.isFetching ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>
                                {verificationQuery.isFetching ? 'Verifying…' : verificationQuery.isSuccess ? 'Verified' : 'Pending'}
                              </span>
                            </div>
                            {verificationQuery.error && (
                              <p className="mt-2 text-rose-600">Unable to verify counts against the database.</p>
                            )}
                            {verificationQuery.data ? (
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div>
                                  <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Student count</p>
                                  <p className="mt-1 text-lg font-semibold text-slate-900">{verificationQuery.data.totalStudents}</p>
                                </div>
                                <div>
                                  <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Exam rows</p>
                                  <p className="mt-1 text-lg font-semibold text-slate-900">{verificationQuery.data.totalExamRows}</p>
                                </div>
                                {(['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance'] as const).map(type => (
                                  <div key={type}>
                                    <p className="text-xs uppercase tracking-[0.25em] text-slate-500">{type} students</p>
                                    <p className="mt-1 text-lg font-semibold text-slate-900">{verificationQuery.data?.studentCountsByExamType[type] ?? 0}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-2 text-xs text-slate-500">Select a record to verify raw exam counts from the database.</p>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div>
            <h3 className="text-lg font-semibold mb-3">Heat Map (Teacher × Subject)</h3>
            <HeatMap
              month={selectedMonth}
              classNames={selectedClass ? [selectedClass] : classes}
            />
          </div>
        )}
      </div>
    </div>
  );
}

  function DetailCard({ label, value }: { label: string; value: number | string }) {
    return (
      <div className="rounded-3xl bg-slate-50 p-4">
        <p className="text-[11px] uppercase tracking-[0.28em] text-slate-500">{label}</p>
        <p className="mt-2 text-lg font-semibold text-slate-900">{value}</p>
      </div>
    );
  }
