import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getStudentsByParent, getCurrentTerm, getFinalReport } from '../../lib/database';
import { Student, getGrade } from '../../types';
import type { FinalReport } from '../../types';
import { Award, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '../../utils/cn';

export function FinalReport() {
  const { session } = useRole();
  const [children, setChildren] = useState<Student[]>([]);
  const [reportData, setReportData] = useState<FinalReport | null>(null);
  const [selectedChild, setSelectedChild] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const kids = await getStudentsByParent(session.userId);
      setChildren(kids);
      if (kids.length > 0) setSelectedChild(kids[0].id);
    };

    loadData();
  }, [session]);

  useEffect(() => {
    if (!selectedChild) return;

    const loadReport = async () => {
      setLoading(true);
      setError(null);
      setReportData(null);
      try {
        const term = await getCurrentTerm();
        if (!term) {
          setError('Current academic term is unavailable.');
          return;
        }
        const report = await getFinalReport(selectedChild, term.id);
        setReportData(report || null);
      } catch (err) {
        console.error('Failed to load final report', err);
        setError('Unable to load final report. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    loadReport();
  }, [selectedChild]);

  const child = children.find(c => c.id === selectedChild);
  const results = reportData?.results ?? [];
  const weights = reportData?.weights ?? { ca: 0, midterm: 0, final: 0 };

  const overallFinal = results.length
    ? Math.round(results.reduce((s, r) => s + r.total, 0) / results.length)
    : 0;

  const passedCount = results.filter(r => r.total >= 60).length;
  const allPassed = results.length ? passedCount === results.length : false;
  const rank = reportData ? `${reportData.overall_rank} / ${reportData.total_students}` : '—';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Final Year Reports</h1>
        <p className="text-slate-500 mt-1">Combined result: CA (30%) + Midterm (30%) + Final Exam (40%)</p>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase mb-1.5 block">Select Child</label>
        <div className="flex gap-2 flex-wrap">
          {children.map(c => (
            <button key={c.id} onClick={() => setSelectedChild(c.id)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                selectedChild === c.id ? 'bg-amber-100 text-amber-700 ring-2 ring-offset-1 ring-amber-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{c.name}</button>
          ))}
        </div>
      </div>

      {child && (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-500 to-orange-600 p-5">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Final Year Report Card</h2>
                <p className="text-sm text-white/80">{child.name} · {child.className}</p>
              </div>
              <div className="flex gap-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{overallFinal}%</p>
                  <p className="text-xs text-white/70">Final Average</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-white">{rank}</p>
                  <p className="text-xs text-white/70">Position</p>
                </div>
                <div className="text-center">
                  {allPassed ? (
                    <div className="flex flex-col items-center">
                      <CheckCircle className="w-8 h-8 text-white" />
                      <p className="text-xs text-white/70 mt-1">PASSED</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <XCircle className="w-8 h-8 text-white/80" />
                      <p className="text-xs text-white/70 mt-1">{passedCount}/{results.length}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Formula reminder */}
          {results.length ? (
            <div className="bg-amber-50 border-b border-amber-100 px-5 py-3">
              <p className="text-xs text-amber-700 font-medium">
                📊 Final Score = (CA × {weights.ca}%) + (Midterm × {weights.midterm}%) + (Final Exam × {weights.final}%) &nbsp;|&nbsp; Pass mark: 60%
              </p>
            </div>
          ) : null}

          {loading ? (
            <div className="text-center py-12 text-slate-500">Loading final report…</div>
          ) : error ? (
            <div className="text-center py-12 text-rose-600">{error}</div>
          ) : results.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Subject</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">CA ({weights.ca}%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Midterm ({weights.midterm}%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Final ({weights.final}%)</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Final Score</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Grade</th>
                    <th className="text-center px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map(result => (
                    <tr key={result.subject} className="hover:bg-slate-50">
                      <td className="px-5 py-4 font-semibold text-slate-800 text-sm">{result.subject}</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{result.ca_avg}%</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{result.midterm_score}%</td>
                      <td className="px-5 py-4 text-center text-sm text-slate-600">{result.final_score}%</td>
                      <td className="px-5 py-4 text-center">
                        <span className={cn("text-lg font-bold",
                          result.total >= 80 ? 'text-emerald-600' : result.total >= 60 ? 'text-amber-600' : 'text-red-600'
                        )}>{result.total}%</span>
                      </td>
                      <td className="px-5 py-4 text-center">
                        <span className={cn("px-3 py-1 rounded-full text-xs font-bold",
                          getGrade(result.total) === 'A' ? 'bg-emerald-100 text-emerald-700' :
                          getGrade(result.total) === 'B' ? 'bg-blue-100 text-blue-700' :
                          getGrade(result.total) === 'C' ? 'bg-amber-100 text-amber-700' :
                          getGrade(result.total) === 'D' ? 'bg-orange-100 text-orange-700' :
                          'bg-red-100 text-red-700'
                        )}>{getGrade(result.total)}</span>
                      </td>
                      <td className="px-5 py-4 text-center">
                        {result.total >= 60 ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-semibold">
                            <CheckCircle className="w-4 h-4" /> Pass
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600 text-xs font-semibold">
                            <XCircle className="w-4 h-4" /> Fail
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-bold border-t-2 border-slate-200">
                    <td className="px-5 py-3 text-sm text-slate-800">OVERALL</td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {results.length ? Math.round(results.reduce((s, r) => s + r.ca_avg, 0) / results.length) : 0}%
                    </td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {results.length ? Math.round(results.reduce((s, r) => s + r.midterm_score, 0) / results.length) : 0}%
                    </td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">
                      {results.length ? Math.round(results.reduce((s, r) => s + r.final_score, 0) / results.length) : 0}%
                    </td>
                    <td className="px-5 py-3 text-center text-lg text-indigo-700 font-bold">{overallFinal}%</td>
                    <td className="px-5 py-3 text-center">
                      <span className="px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-700">
                        {getGrade(overallFinal)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-center">
                      {allPassed ? (
                        <span className="text-emerald-600 text-xs font-bold">ALL PASSED</span>
                      ) : (
                        <span className="text-amber-600 text-xs font-bold">{passedCount}/{results.length}</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <Award className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">Final report not available yet</p>
              <p className="text-xs mt-1">No complete exam data has been submitted yet for this student.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
