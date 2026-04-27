import { useState, useEffect } from 'react';
import { useRole } from '../../context/RoleContext';
import { getUserById, getStudentsByClasses, getUsersByIds } from '../../lib/database';
import { Student, User } from '../../types';
import { GraduationCap, Search, MessageCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { buildParentCredentialWhatsAppLink } from '../../lib/whatsapp';
import { useToast } from '../../context/ToastContext';

export function TeacherStudents() {
  const { session } = useRole();
  const { addToast } = useToast();
  const [students, setStudents] = useState<Student[]>([]);
  const [parents, setParents] = useState<User[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [classFilter, setClassFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!session) return;

    const loadData = async () => {
      const teacher = await getUserById(session.userId);
      const cls = teacher?.assignedClasses || [];
      setClasses(cls);

      // Fetch students and a base parents list, then ensure any parentIds
      // referenced by students are included even if missing from the paged
      // users query (helps when some parent profiles exist only in auth
      // or the users table is out-of-sync).
        const studentsData = await getStudentsByClasses(cls);
      const parentIdsFromStudents = Array.from(
        new Set((studentsData || []).map((s: Student) => s.parentId).filter((x): x is string => !!x))
      );

      const parentsList = parentIdsFromStudents.length > 0 ? await getUsersByIds(parentIdsFromStudents) : [];
      setStudents(studentsData);
      setParents(parentsList);
    };

    loadData();
  }, [session]);
  const filtered = students
    .filter(s => classFilter === 'all' || s.className === classFilter)
    .filter(s => s.name.toLowerCase().includes(search.toLowerCase()));

  function handleSendWhatsApp(parent: User) {
    const phone = parent.phone1 || parent.phone2;
    if (!phone || !parent.email || !parent.password) {
      addToast({ type: 'error', title: 'Parent must have phone, email and password' });
      return;
    }
    const url = buildParentCredentialWhatsAppLink({ phone, email: parent.email, password: parent.password });
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">My Classes</h1>
        <p className="text-slate-500 mt-1">Students in your assigned classes</p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setClassFilter('all')}
            className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
              classFilter === 'all' ? 'bg-teal-100 text-teal-700 ring-2 ring-offset-1 ring-teal-200' : 'bg-white text-slate-500 border border-slate-200'
            )}>All ({students.length})</button>
          {classes.map(cls => (
            <button key={cls} onClick={() => setClassFilter(cls)}
              className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                classFilter === cls ? 'bg-teal-100 text-teal-700 ring-2 ring-offset-1 ring-teal-200' : 'bg-white text-slate-500 border border-slate-200'
              )}>{cls}</button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input type="text" placeholder="Search students..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Student</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Class</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-slate-500 uppercase">Parent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(s => {
                const parent = parents.find(p => p.id === s.parentId);
                return (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-xs">
                          {s.name.split(' ').map(n => n[0]).join('')}
                        </div>
                        <span className="font-semibold text-slate-800 text-sm">{s.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="bg-teal-50 text-teal-700 px-2.5 py-1 rounded-lg text-xs font-semibold">{s.className}</span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {parent ? (
                        <div className="space-y-1">
                          <p className="font-medium text-slate-800">{parent.name} - {parent.phone1 || parent.phone2 || 'No phone'}</p>
                          <button
                            onClick={() => handleSendWhatsApp(parent)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-teal-50 text-teal-700 text-xs font-semibold disabled:opacity-50"
                          >
                            <MessageCircle className="w-3.5 h-3.5" />
                            Send WhatsApp
                          </button>
                        </div>
                      ) : (
                        <span className="italic text-slate-400">Unassigned</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No students in your classes</p>
          </div>
        )}
      </div>
    </div>
  );
}
