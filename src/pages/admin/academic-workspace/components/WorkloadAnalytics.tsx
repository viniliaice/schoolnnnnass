import { useMemo } from 'react';
import type { ClassSubject, Subject, User } from '../../../../types';
import { CLASSES } from '../../../../types';
import { calculateTeacherWorkload, DEFAULT_WEEKLY_LESSONS, TEACHER_WEEKLY_LIMIT } from '../utils/workload';
import { cn } from '../../../../utils/cn';

type MappingRow = ClassSubject & { subjects?: { name: string }; users?: { name: string } };

export function WorkloadAnalytics({
  subjects,
  mappings,
  teachers,
}: {
  subjects: Subject[];
  mappings: MappingRow[];
  teachers: User[];
}) {
  const teachersById = useMemo(() => new Map(teachers.map(t => [t.id, t])), [teachers]);
  const subjectsById = useMemo(() => new Map(subjects.map(s => [s.id, s])), [subjects]);

  const workloadByTeacher = useMemo(
    () => calculateTeacherWorkload(mappings, Object.fromEntries(subjects.map(s => [s.id, { weeklyLessons: s.weeklyLessons }]))),
    [mappings, subjects],
  );

  const sortedTeachers = useMemo(
    () => Array.from(workloadByTeacher.entries()).sort((a, b) => b[1] - a[1]),
    [workloadByTeacher],
  );

  const classCoverage = useMemo(() => {
    return CLASSES.map(className => {
      const classMappings = mappings.filter(r => r.className === className);
      const totalSubjects = subjects.length;
      const assigned = new Set(classMappings.map(r => r.subjectId)).size;
      const withTeacher = classMappings.filter(r => r.teacherId).length;
      return { className, assigned, total: totalSubjects, withTeacher, totalMappings: classMappings.length };
    });
  }, [mappings, subjects]);

  const maxWorkload = Math.max(...workloadByTeacher.values(), TEACHER_WEEKLY_LIMIT);

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-bold text-slate-900">Teacher Workload</h3>
        {sortedTeachers.length === 0 ? (
          <p className="text-sm text-slate-400">No teachers assigned yet.</p>
        ) : (
          <div className="space-y-2">
            {sortedTeachers.map(([teacherId, workload]) => {
              const teacher = teachersById.get(teacherId);
              const pct = Math.round((workload / maxWorkload) * 100);
              const overLimit = workload > TEACHER_WEEKLY_LIMIT;
              return (
                <div key={teacherId}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-700">{teacher?.name || teacherId}</span>
                    <span className={overLimit ? 'font-semibold text-red-600' : 'text-slate-500'}>
                      {workload} / {TEACHER_WEEKLY_LIMIT} {overLimit ? '(over limit)' : ''}
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                    <div className={cn('h-full rounded-full transition-all', overLimit ? 'bg-red-400' : 'bg-emerald-400')} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-bold text-slate-900">Class Coverage</h3>
        <div className="overflow-auto rounded-2xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-slate-600">Class</th>
                <th className="px-3 py-2 text-center font-semibold text-slate-600">Subjects</th>
                <th className="px-3 py-2 text-center font-semibold text-slate-600">With Teacher</th>
                <th className="px-3 py-2 text-center font-semibold text-slate-600">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {classCoverage.filter(c => c.totalMappings > 0).map(c => {
                const coveragePct = c.totalMappings > 0 ? Math.round((c.withTeacher / c.totalMappings) * 100) : 0;
                return (
                  <tr key={c.className} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-900">{c.className}</td>
                    <td className="px-3 py-2 text-center text-slate-600">{c.assigned}/{c.total}</td>
                    <td className="px-3 py-2 text-center text-slate-600">{c.withTeacher}/{c.totalMappings}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                          <div className={cn('h-full rounded-full', coveragePct >= 80 ? 'bg-emerald-400' : coveragePct >= 50 ? 'bg-amber-400' : 'bg-red-400')} style={{ width: `${coveragePct}%` }} />
                        </div>
                        <span className="text-xs text-slate-500">{coveragePct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-bold text-slate-900">Subject Distribution Heatmap</h3>
        <div className="overflow-auto rounded-2xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="sticky left-0 z-10 bg-slate-50 px-2 py-1 text-left text-[11px] font-semibold text-slate-600">Subject</th>
                {CLASSES.filter(cn => mappings.some(r => r.className === cn)).map(cn => (
                  <th key={cn} className="px-2 py-1 text-center text-[11px] font-semibold text-slate-600">{cn}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subjects.map(subject => (
                <tr key={subject.id} className="border-t border-slate-100">
                  <td className="sticky left-0 z-10 bg-white px-2 py-1 text-[11px] font-medium text-slate-900">{subject.shortName || subject.name}</td>
                  {CLASSES.filter(c => mappings.some(r => r.className === c)).map(c => {
                    const row = mappings.find(r => r.className === c && r.subjectId === subject.id);
                    const hasTeacher = row?.teacherId;
                    return (
                      <td key={c} className={cn('px-2 py-1 text-center text-[11px]', row ? (hasTeacher ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700') : 'bg-slate-50 text-slate-300')}>
                        {row ? (hasTeacher ? '✓' : '○') : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
