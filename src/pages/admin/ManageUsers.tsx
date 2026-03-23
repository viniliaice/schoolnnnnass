import { useState, useEffect } from 'react';
import { getUsers, createUser, deleteUser, updateUser, getStudentsByParent, getStudents } from '../../lib/database';
import { User, Role, CLASSES, Student } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import {
  Plus, Trash2, Edit, Eye, Phone, MapPin, CreditCard, Users as UsersIcon,
  GraduationCap, Search
} from 'lucide-react';
import { cn } from '../../utils/cn';

export function ManageUsers() {
  const { addToast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<User | null>(null);
  const [showEdit, setShowEdit] = useState<User | null>(null);
  const [createRole, setCreateRole] = useState<Role>('teacher');

  // Form state
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPhone1, setFormPhone1] = useState('');
  const [formPhone2, setFormPhone2] = useState('');
  const [formXafada, setFormXafada] = useState('');
  const [formUdow, setFormUdow] = useState('');
  const [formPayment, setFormPayment] = useState('');
  const [formClasses, setFormClasses] = useState<string[]>([]);
  const [formPassword, setFormPassword] = useState('');

  const refresh = async () => {
    const [usersData, studentsData] = await Promise.all([
      getUsers(),
      getStudents()
    ]);
    setUsers(usersData);
    setStudents(studentsData);
  };

  useEffect(() => {
    refresh();
  }, []);

  const getChildren = (parentId: string) => students.filter(s => s.parentId === parentId);

  const filtered = users
    .filter(u => roleFilter === 'all' || u.role === roleFilter)
    .filter(u => u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()));

  const resetForm = () => {
    setFormName(''); setFormEmail(''); setFormPhone1(''); setFormPhone2('');
    setFormXafada(''); setFormUdow(''); setFormPayment(''); setFormClasses([]); setFormPassword('');
  };

  const handleCreate = async () => {
    if (!formName.trim() || !formEmail.trim() || !formPassword.trim()) {
      addToast({ type: 'error', title: 'Name, email, and password are required' });
      return;
    }
    const data: Omit<User, 'id' | 'createdAt'> = {
      name: formName, email: formEmail, role: createRole, password: formPassword,
    };
    if (createRole === 'parent') {
      data.phone1 = formPhone1; data.phone2 = formPhone2;
      data.xafada = formXafada; data.udow = formUdow;
      data.paymentnumber = formPayment;
    }
    if (createRole === 'teacher') {
      data.assignedClasses = formClasses;
    }
    try {
      await createUser(data);
      addToast({ type: 'success', title: `${createRole} created successfully` });
      resetForm(); setShowCreate(false); await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to create user' });
    }
  };

  const handleEdit = async () => {
    if (!showEdit) return;
    const data: Partial<User> = { name: formName, email: formEmail };
    if (formPassword.trim()) data.password = formPassword;
    if (showEdit.role === 'parent') {
      data.phone1 = formPhone1; data.phone2 = formPhone2;
      data.xafada = formXafada; data.udow = formUdow;
      data.paymentnumber = formPayment;
    }
    if (showEdit.role === 'teacher') {
      data.assignedClasses = formClasses;
    }
    try {
      await updateUser(showEdit.id, data);
      addToast({ type: 'success', title: 'User updated successfully' });
      resetForm(); setShowEdit(null); await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to update user' });
    }
  };

  const handleDelete = async (user: User) => {
    if (user.role === 'admin') {
      addToast({ type: 'error', title: 'Cannot delete admin' });
      return;
    }
    try {
      await deleteUser(user.id);
      addToast({ type: 'success', title: `${user.name} deleted` });
      await refresh();
    } catch (error) {
      addToast({ type: 'error', title: 'Failed to delete user' });
    }
  };

  const openEdit = (user: User) => {
    setFormName(user.name); setFormEmail(user.email);
    setFormPhone1(user.phone1 || ''); setFormPhone2(user.phone2 || '');
    setFormXafada(user.xafada || ''); setFormUdow(user.udow || '');
    setFormPayment(user.paymentnumber || '');
    setFormClasses(user.assignedClasses || []);
    setFormPassword('');
    setShowEdit(user);
  };

  const toggleClass = (cls: string) => {
    setFormClasses(prev => prev.includes(cls) ? prev.filter(c => c !== cls) : [...prev, cls]);
  };

  const roleTabs: { label: string; value: Role | 'all'; color: string }[] = [
    { label: 'All', value: 'all', color: 'bg-slate-100 text-slate-700' },
    { label: 'Teachers', value: 'teacher', color: 'bg-teal-100 text-teal-700' },
    { label: 'Parents', value: 'parent', color: 'bg-violet-100 text-violet-700' },
    { label: 'Admins', value: 'admin', color: 'bg-indigo-100 text-indigo-700' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Manage Users</h1>
          <p className="text-slate-500 mt-1">Create, edit and manage all users</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all"
        >
          <Plus className="w-4 h-4" /> Add User
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2 flex-wrap">
          {roleTabs.map(tab => (
            <button
              key={tab.value}
              onClick={() => setRoleFilter(tab.value)}
              className={cn(
                "px-4 py-2 rounded-xl text-sm font-medium transition-all",
                roleFilter === tab.value ? tab.color + ' ring-2 ring-offset-1 ring-slate-300' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text" placeholder="Search users..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
          />
        </div>
      </div>

      {/* User Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(user => {
          const children = user.role === 'parent' ? getChildren(user.id) : [];
          return (
            <div key={user.id} className="bg-white rounded-2xl border border-slate-200 p-5 hover:shadow-lg transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={cn("w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm text-white",
                    user.role === 'admin' ? 'bg-indigo-500' : user.role === 'teacher' ? 'bg-teal-500' : 'bg-violet-500'
                  )}>
                    {user.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm">{user.name}</h3>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </div>
                </div>
                <span className={cn("px-2.5 py-1 rounded-full text-xs font-semibold",
                  user.role === 'admin' ? 'bg-indigo-100 text-indigo-700' :
                  user.role === 'teacher' ? 'bg-teal-100 text-teal-700' :
                  'bg-violet-100 text-violet-700'
                )}>
                  {user.role}
                </span>
              </div>

              {/* Parent quick info */}
              {user.role === 'parent' && (
                <div className="space-y-1.5 mb-3 text-xs text-slate-600">
                  {user.phone1 && (
                    <div className="flex items-center gap-2">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <span>{user.phone1}{user.phone2 ? ` · ${user.phone2}` : ''}</span>
                    </div>
                  )}
                  {user.xafada && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400" />
                      <span>{user.xafada}{user.udow ? ` (near ${user.udow})` : ''}</span>
                    </div>
                  )}
                  {children.length > 0 && (
                    <div className="flex items-center gap-2">
                      <GraduationCap className="w-3.5 h-3.5 text-slate-400" />
                      <span>{children.map(c => c.name).join(', ')}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Teacher quick info */}
              {user.role === 'teacher' && user.assignedClasses && user.assignedClasses.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {user.assignedClasses.map(cls => (
                    <span key={cls} className="bg-teal-50 text-teal-700 px-2 py-0.5 rounded-md text-xs font-medium">{cls}</span>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-slate-100">
                {user.role === 'parent' && (
                  <button onClick={() => setShowDetail(user)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-600 bg-violet-50 rounded-lg hover:bg-violet-100 transition-colors">
                    <Eye className="w-3.5 h-3.5" /> View
                  </button>
                )}
                <button onClick={() => openEdit(user)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
                  <Edit className="w-3.5 h-3.5" /> Edit
                </button>
                {user.role !== 'admin' && (
                  <button onClick={() => handleDelete(user)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <UsersIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No users found</p>
        </div>
      )}

      {/* Create User Dialog */}
      <Dialog open={showCreate} onClose={() => setShowCreate(false)} title="Add New User" description="Create a teacher, parent, or admin account">
        <div className="space-y-4">
          <div className="flex gap-2">
            {(['teacher', 'parent', 'admin'] as Role[]).map(r => (
              <button key={r} onClick={() => setCreateRole(r)}
                className={cn("px-4 py-2 rounded-xl text-sm font-medium transition-all",
                  createRole === r ? (r === 'teacher' ? 'bg-teal-100 text-teal-700' : r === 'parent' ? 'bg-violet-100 text-violet-700' : 'bg-indigo-100 text-indigo-700') : 'bg-slate-100 text-slate-500'
                )}
              >
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
          <input placeholder="Full Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <input placeholder="Email" value={formEmail} onChange={e => setFormEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <input placeholder="Password" type="password" value={formPassword} onChange={e => setFormPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" required />

          {createRole === 'parent' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Phone 1" value={formPhone1} onChange={e => setFormPhone1(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
                <input placeholder="Phone 2" value={formPhone2} onChange={e => setFormPhone2(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Xafada (Neighborhood)" value={formXafada} onChange={e => setFormXafada(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
                <input placeholder="Udow (Near to)" value={formUdow} onChange={e => setFormUdow(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
              </div>
              <input placeholder="Payment Number" value={formPayment} onChange={e => setFormPayment(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
            </>
          )}

          {createRole === 'teacher' && (
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Assigned Classes</label>
              <div className="flex flex-wrap gap-2">
                {CLASSES.map(cls => (
                  <button key={cls} onClick={() => toggleClass(cls)}
                    className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                      formClasses.includes(cls) ? 'bg-teal-100 text-teal-700 border-teal-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                    )}
                  >
                    {cls}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button onClick={handleCreate}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 transition-colors">
            Create {createRole.charAt(0).toUpperCase() + createRole.slice(1)}
          </button>
        </div>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={!!showEdit} onClose={() => { setShowEdit(null); resetForm(); }} title="Edit User" description={`Editing ${showEdit?.name || ''}`}>
        <div className="space-y-4">
          <input placeholder="Full Name" value={formName} onChange={e => setFormName(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <input placeholder="Email" value={formEmail} onChange={e => setFormEmail(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <input placeholder="Password (leave blank to keep current)" type="password" value={formPassword} onChange={e => setFormPassword(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />

          {showEdit?.role === 'parent' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Phone 1" value={formPhone1} onChange={e => setFormPhone1(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
                <input placeholder="Phone 2" value={formPhone2} onChange={e => setFormPhone2(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Xafada (Neighborhood)" value={formXafada} onChange={e => setFormXafada(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
                <input placeholder="Udow (Near to)" value={formUdow} onChange={e => setFormUdow(e.target.value)}
                  className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
              </div>
              <input placeholder="Payment Number" value={formPayment} onChange={e => setFormPayment(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
            </>
          )}

          {showEdit?.role === 'teacher' && (
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-2 block">Assigned Classes</label>
              <div className="flex flex-wrap gap-2">
                {CLASSES.map(cls => (
                  <button key={cls} onClick={() => toggleClass(cls)}
                    className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                      formClasses.includes(cls) ? 'bg-teal-100 text-teal-700 border-teal-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                    )}
                  >
                    {cls}
                  </button>
                ))}
              </div>
            </div>
          )}

          <button onClick={handleEdit}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-xl font-medium text-sm hover:bg-indigo-700 transition-colors">
            Save Changes
          </button>
        </div>
      </Dialog>

      {/* Parent Detail Dialog */}
      <Dialog open={!!showDetail} onClose={() => setShowDetail(null)} title="Parent Details" className="max-w-xl">
        {showDetail && (() => {
          const children = getChildren(showDetail.id);
          return (
            <div className="space-y-5">
              {/* Profile Header */}
              <div className="flex items-center gap-4 p-4 bg-violet-50 rounded-2xl">
                <div className="w-16 h-16 rounded-full bg-violet-500 flex items-center justify-center text-white font-bold text-xl">
                  {showDetail.name.split(' ').map(n => n[0]).join('').substring(0, 2)}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900">{showDetail.name}</h3>
                  <p className="text-sm text-slate-500">{showDetail.email}</p>
                </div>
              </div>

              {/* Contact Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                    <Phone className="w-4 h-4" /> Phone 1
                  </div>
                  <p className="font-bold text-slate-900 text-lg">{showDetail.phone1 || '—'}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                    <Phone className="w-4 h-4" /> Phone 2
                  </div>
                  <p className="font-bold text-slate-900 text-lg">{showDetail.phone2 || '—'}</p>
                </div>
              </div>

              {/* Location */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                    <MapPin className="w-4 h-4" /> Xafada (Neighborhood)
                  </div>
                  <p className="font-bold text-slate-900">{showDetail.xafada || '—'}</p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                    <MapPin className="w-4 h-4" /> Udow (Near to)
                  </div>
                  <p className="font-bold text-slate-900">{showDetail.udow || '—'}</p>
                </div>
              </div>

              {/* Payment */}
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2 text-sm text-slate-500 mb-1">
                  <CreditCard className="w-4 h-4" /> Payment Number
                </div>
                <p className="font-bold text-slate-900">{showDetail.paymentnumber || '—'}</p>
              </div>

              {/* Children */}
              <div>
                <h4 className="font-bold text-slate-800 mb-3 flex items-center gap-2">
                  <GraduationCap className="w-5 h-5 text-violet-500" /> Children ({children.length})
                </h4>
                {children.length > 0 ? (
                  <div className="space-y-2">
                    {children.map(child => (
                      <div key={child.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-violet-100 flex items-center justify-center text-violet-700 font-bold text-xs">
                            {child.name.split(' ').map(n => n[0]).join('')}
                          </div>
                          <div>
                            <p className="font-semibold text-slate-800 text-sm">{child.name}</p>
                            <p className="text-xs text-slate-500">{child.className}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic">No children assigned</p>
                )}
              </div>

              <button onClick={() => setShowDetail(null)}
                className="w-full py-2.5 bg-slate-100 text-slate-700 rounded-xl font-medium text-sm hover:bg-slate-200 transition-colors">
                Close
              </button>
            </div>
          );
        })()}
      </Dialog>
    </div>
  );
}
