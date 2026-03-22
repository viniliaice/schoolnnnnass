import { useState, useRef, useCallback } from 'react';
import {
  getUsersByRole, bulkCreateUsers, bulkCreateStudents, getStudents
} from '../../lib/database';
import { User, CLASSES } from '../../types';
import { useToast } from '../../context/ToastContext';
import { Dialog } from '../../components/ui/Dialog';
import {
  Upload, Users, GraduationCap, UserPlus, Trash2, Plus,
  FileSpreadsheet, AlertCircle, CheckCircle, Download, Copy,
  ChevronDown, ArrowRight, Info, FileDown, Search, X,
  ChevronLeft, ChevronRight, HelpCircle, Sparkles
} from 'lucide-react';
import { cn } from '../../utils/cn';

type Tab = 'parents' | 'teachers' | 'students';

// ─── Row interfaces ───
interface StudentRow {
  id: number;
  name: string;
  className: string;
  parentName: string; // match by name
  parentId: string;   // resolved ID
}

interface TeacherRow {
  id: number;
  name: string;
  email: string;
  assignedClasses: string[];
}

interface ParentRow {
  id: number;
  name: string;
  email: string;
  phone1: string;
  phone2: string;
  xafada: string;
  udow: string;
  paymentNumber: string;
}

function generateRowId() {
  return Date.now() + Math.random();
}

// ─── CSV Example Data ───
const PARENT_CSV_EXAMPLE = `Name,Email,Phone 1,Phone 2,Xafada,Udow,Payment Number
Fadumo Abdi,fadumo@email.com,0615551234,0615551235,Hodan,Bakaaraha,EVC-0615551234
Khadija Hassan,khadija@email.com,0617771234,0617771235,Warta Nabadda,Km4 Junction,EVC-0617771234
Amina Mohamed,amina@email.com,0619991234,0619991235,Dharkenley,Ex-Control,EVC-0619991234
Halimo Yusuf,halimo@email.com,0612221234,0612221235,Wadajir,Stadium,EVC-0612221234
Sahra Omar,sahra@email.com,0614441234,0614441235,Kaaraan,Suuqa Holaha,EVC-0614441234`;

const TEACHER_CSV_EXAMPLE = `Name,Email,Classes (semicolon-separated)
Mr. Abdirahman Ali,abdirahman@campus.edu,Grade 7-A;Grade 7-B;Grade 8-A
Ms. Nasra Ibrahim,nasra@campus.edu,Grade 9-A;Grade 9-B;Grade 10-A
Mr. Yusuf Hassan,yusuf@campus.edu,Grade 7-C;Grade 8-B;Grade 10-B
Ms. Hawa Mohamed,hawa@campus.edu,Grade 8-A;Grade 8-B;Grade 9-A`;

const STUDENT_CSV_EXAMPLE = `Name,Class,Parent Name
Abdikarim Fadumo,Grade 7-A,Fadumo Abdi
Hamza Fadumo,Grade 8-A,Fadumo Abdi
Yasmin Khadija,Grade 9-A,Khadija Hassan
Mohamed Khadija,Grade 7-B,Khadija Hassan
Fartun Amina,Grade 10-A,Amina Mohamed
Ilhan Halimo,Grade 9-B,Halimo Yusuf
Abdullahi Halimo,Grade 8-B,Halimo Yusuf
Ayan Sahra,Grade 7-C,Sahra Omar`;

// ─── Download CSV helper ───
function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════
export function BulkUpload() {
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>('parents');
  const [showGuide, setShowGuide] = useState(false);
  const [showCsvHelp, setShowCsvHelp] = useState(false);

  // ─── Student State ───
  const [studentRows, setStudentRows] = useState<StudentRow[]>(
    Array.from({ length: 3 }, () => ({
      id: generateRowId(), name: '', className: CLASSES[0], parentName: '', parentId: ''
    }))
  );
  const [studentCsvMode, setStudentCsvMode] = useState(false);
  const [studentCsv, setStudentCsv] = useState('');

  // ─── Teacher State ───
  const [teacherRows, setTeacherRows] = useState<TeacherRow[]>(
    Array.from({ length: 2 }, () => ({
      id: generateRowId(), name: '', email: '', assignedClasses: []
    }))
  );
  const [teacherCsvMode, setTeacherCsvMode] = useState(false);
  const [teacherCsv, setTeacherCsv] = useState('');
  const [showClassPicker, setShowClassPicker] = useState<number | null>(null);

  // ─── Parent State ───
  const [parentRows, setParentRows] = useState<ParentRow[]>(
    Array.from({ length: 2 }, () => ({
      id: generateRowId(), name: '', email: '', phone1: '', phone2: '', xafada: '', udow: '', paymentNumber: ''
    }))
  );
  const [parentCsvMode, setParentCsvMode] = useState(false);
  const [parentCsv, setParentCsv] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Derived Data ───
  const parents = getUsersByRole('parent');
  const teachers = getUsersByRole('teacher');
  const students = getStudents();

  // ─── Helper: Resolve parent by name ───
  const resolveParentId = useCallback((name: string): string => {
    if (!name.trim()) return '';
    const lower = name.trim().toLowerCase();
    const match = parents.find(p => p.name.toLowerCase() === lower);
    return match?.id || '';
  }, [parents]);

  // ═══════════════════════════════════
  // STUDENT HANDLERS
  // ═══════════════════════════════════
  const addStudentRows = (count: number) => {
    const newRows: StudentRow[] = Array.from({ length: count }, () => ({
      id: generateRowId(), name: '', className: CLASSES[0], parentName: '', parentId: ''
    }));
    setStudentRows(prev => [...prev, ...newRows]);
  };

  const removeStudentRow = (id: number) => {
    setStudentRows(prev => prev.filter(r => r.id !== id));
  };

  const updateStudentRow = (id: number, field: keyof StudentRow, value: string) => {
    setStudentRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const updated = { ...r, [field]: value };
      // Auto-resolve parentId when parentName changes
      if (field === 'parentName') {
        updated.parentId = resolveParentId(value);
      }
      // When parentId changes from dropdown, set parentName too
      if (field === 'parentId') {
        const parent = parents.find(p => p.id === value);
        updated.parentName = parent?.name || '';
      }
      return updated;
    }));
  };

  const parseStudentCsv = (text: string): StudentRow[] => {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const rows: StudentRow[] = [];
    for (const line of lines) {
      // skip header row
      if (line.toLowerCase().includes('name') && line.toLowerCase().includes('class')) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 1 && parts[0]) {
        const parentName = parts[2] || '';
        rows.push({
          id: generateRowId(),
          name: parts[0],
          className: parts[1] && CLASSES.includes(parts[1]) ? parts[1] : CLASSES[0],
          parentName,
          parentId: resolveParentId(parentName),
        });
      }
    }
    return rows;
  };

  const importStudentCsv = () => {
    const parsed = parseStudentCsv(studentCsv);
    if (parsed.length === 0) {
      addToast({ type: 'error', title: 'No valid rows found in CSV' });
      return;
    }
    const unmatched = parsed.filter(r => r.parentName && !r.parentId);
    setStudentRows(prev => [...prev.filter(r => r.name.trim()), ...parsed]);
    setStudentCsv('');
    setStudentCsvMode(false);
    if (unmatched.length > 0) {
      addToast({
        type: 'info',
        title: `${parsed.length} rows imported`,
        description: `⚠️ ${unmatched.length} parent name(s) couldn't be matched. Check the "Parent" column.`
      });
    } else {
      addToast({ type: 'success', title: `${parsed.length} student rows imported successfully` });
    }
  };

  const submitStudents = () => {
    const valid = studentRows.filter(r => r.name.trim());
    if (valid.length === 0) {
      addToast({ type: 'error', title: 'No students to add — enter at least one name' });
      return;
    }
    const noParent = valid.filter(r => !r.parentId);
    if (noParent.length > 0) {
      const names = noParent.slice(0, 3).map(r => r.name).join(', ');
      const more = noParent.length > 3 ? ` and ${noParent.length - 3} more` : '';
      addToast({
        type: 'info',
        title: `${noParent.length} student(s) have no parent assigned`,
        description: `${names}${more} — they will be created without a parent.`
      });
    }
    const data = valid.map(r => ({
      name: r.name.trim(),
      className: r.className,
      parentId: r.parentId || null,
    }));
    bulkCreateStudents(data);
    addToast({ type: 'success', title: `✅ ${data.length} students created successfully!` });
    setStudentRows(
      Array.from({ length: 3 }, () => ({
        id: generateRowId(), name: '', className: CLASSES[0], parentName: '', parentId: ''
      }))
    );
  };

  // ═══════════════════════════════════
  // TEACHER HANDLERS
  // ═══════════════════════════════════
  const addTeacherRow = () => {
    setTeacherRows(prev => [...prev, { id: generateRowId(), name: '', email: '', assignedClasses: [] }]);
  };

  const removeTeacherRow = (id: number) => {
    setTeacherRows(prev => prev.filter(r => r.id !== id));
  };

  const updateTeacherRow = (id: number, field: keyof TeacherRow, value: string | string[]) => {
    setTeacherRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const toggleTeacherClass = (rowId: number, cls: string) => {
    setTeacherRows(prev => prev.map(r => {
      if (r.id !== rowId) return r;
      const has = r.assignedClasses.includes(cls);
      return { ...r, assignedClasses: has ? r.assignedClasses.filter(c => c !== cls) : [...r.assignedClasses, cls] };
    }));
  };

  const parseTeacherCsv = (text: string): TeacherRow[] => {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const rows: TeacherRow[] = [];
    for (const line of lines) {
      if (line.toLowerCase().includes('name') && line.toLowerCase().includes('email')) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 1 && parts[0]) {
        const classes = parts[2] ? parts[2].split(';').map(c => c.trim()).filter(c => CLASSES.includes(c)) : [];
        rows.push({
          id: generateRowId(),
          name: parts[0],
          email: parts[1] || `${parts[0].toLowerCase().replace(/\s+/g, '.')}@campus.edu`,
          assignedClasses: classes,
        });
      }
    }
    return rows;
  };

  const importTeacherCsv = () => {
    const parsed = parseTeacherCsv(teacherCsv);
    if (parsed.length === 0) {
      addToast({ type: 'error', title: 'No valid rows found in CSV' });
      return;
    }
    setTeacherRows(prev => [...prev.filter(r => r.name.trim()), ...parsed]);
    setTeacherCsv('');
    setTeacherCsvMode(false);
    addToast({ type: 'success', title: `${parsed.length} teacher rows imported` });
  };

  const submitTeachers = () => {
    const valid = teacherRows.filter(r => r.name.trim());
    if (valid.length === 0) {
      addToast({ type: 'error', title: 'No teachers to add' });
      return;
    }
    const data: Omit<User, 'id' | 'createdAt'>[] = valid.map(r => ({
      name: r.name.trim(),
      email: r.email.trim() || `${r.name.trim().toLowerCase().replace(/\s+/g, '.')}@campus.edu`,
      role: 'teacher' as const,
      assignedClasses: r.assignedClasses,
    }));
    bulkCreateUsers(data);
    addToast({ type: 'success', title: `✅ ${data.length} teachers created successfully!` });
    setTeacherRows(
      Array.from({ length: 2 }, () => ({
        id: generateRowId(), name: '', email: '', assignedClasses: []
      }))
    );
  };

  // ═══════════════════════════════════
  // PARENT HANDLERS
  // ═══════════════════════════════════
  const addParentRows = (count: number) => {
    const newRows: ParentRow[] = Array.from({ length: count }, () => ({
      id: generateRowId(), name: '', email: '', phone1: '', phone2: '', xafada: '', udow: '', paymentNumber: ''
    }));
    setParentRows(prev => [...prev, ...newRows]);
  };

  const removeParentRow = (id: number) => {
    setParentRows(prev => prev.filter(r => r.id !== id));
  };

  const updateParentRow = (id: number, field: keyof ParentRow, value: string) => {
    setParentRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const parseParentCsv = (text: string): ParentRow[] => {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const rows: ParentRow[] = [];
    for (const line of lines) {
      if (line.toLowerCase().includes('name') && line.toLowerCase().includes('email') && line.toLowerCase().includes('phone')) continue;
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 1 && parts[0]) {
        rows.push({
          id: generateRowId(),
          name: parts[0],
          email: parts[1] || '',
          phone1: parts[2] || '',
          phone2: parts[3] || '',
          xafada: parts[4] || '',
          udow: parts[5] || '',
          paymentNumber: parts[6] || '',
        });
      }
    }
    return rows;
  };

  const importParentCsv = () => {
    const parsed = parseParentCsv(parentCsv);
    if (parsed.length === 0) {
      addToast({ type: 'error', title: 'No valid rows found in CSV' });
      return;
    }
    setParentRows(prev => [...prev.filter(r => r.name.trim()), ...parsed]);
    setParentCsv('');
    setParentCsvMode(false);
    addToast({ type: 'success', title: `${parsed.length} parent rows imported` });
  };

  const submitParents = () => {
    const valid = parentRows.filter(r => r.name.trim());
    if (valid.length === 0) {
      addToast({ type: 'error', title: 'No parents to add' });
      return;
    }
    const data: Omit<User, 'id' | 'createdAt'>[] = valid.map(r => ({
      name: r.name.trim(),
      email: r.email.trim() || `${r.name.trim().toLowerCase().replace(/\s+/g, '.')}@email.com`,
      role: 'parent' as const,
      phone1: r.phone1,
      phone2: r.phone2,
      xafada: r.xafada,
      udow: r.udow,
      paymentNumber: r.paymentNumber,
    }));
    bulkCreateUsers(data);
    addToast({ type: 'success', title: `✅ ${data.length} parents created successfully!` });
    setParentRows(
      Array.from({ length: 2 }, () => ({
        id: generateRowId(), name: '', email: '', phone1: '', phone2: '', xafada: '', udow: '', paymentNumber: ''
      }))
    );
  };

  // ═══════════════════════════════════
  // CSV File upload
  // ═══════════════════════════════════
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      if (activeTab === 'students') { setStudentCsv(text); setStudentCsvMode(true); }
      else if (activeTab === 'teachers') { setTeacherCsv(text); setTeacherCsvMode(true); }
      else { setParentCsv(text); setParentCsvMode(true); }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const copyCsvTemplate = (template: string) => {
    navigator.clipboard.writeText(template);
    addToast({ type: 'success', title: 'Template copied to clipboard!' });
  };

  // ═══════════════════════════════════
  // TAB CONFIG
  // ═══════════════════════════════════
  const tabSteps: { key: Tab; step: number; label: string; icon: typeof Users; description: string }[] = [
    { key: 'parents', step: 1, label: 'Parents', icon: UserPlus, description: 'Upload parents first so students can be assigned to them' },
    { key: 'teachers', step: 2, label: 'Teachers', icon: Users, description: 'Upload teachers and assign them to classes' },
    { key: 'students', step: 3, label: 'Students', icon: GraduationCap, description: 'Upload students last — assign class & parent' },
  ];

  const tabColors: Record<Tab, { bg: string; ring: string; btn: string; btnHover: string; light: string; text: string; border: string }> = {
    parents: { bg: 'bg-violet-100', ring: 'ring-violet-300', btn: 'bg-violet-600', btnHover: 'hover:bg-violet-700', light: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200' },
    teachers: { bg: 'bg-teal-100', ring: 'ring-teal-300', btn: 'bg-teal-600', btnHover: 'hover:bg-teal-700', light: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200' },
    students: { bg: 'bg-indigo-100', ring: 'ring-indigo-300', btn: 'bg-indigo-600', btnHover: 'hover:bg-indigo-700', light: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
  };

  const tc = tabColors[activeTab];
  const currentStep = tabSteps.find(t => t.key === activeTab)!;
  const currentStepIndex = tabSteps.indexOf(currentStep);

  return (
    <div className="space-y-6">
      {/* ═══ HEADER ═══ */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bulk Import</h1>
          <p className="text-slate-500 mt-1">Add multiple records at once — use forms or upload a CSV file</p>
        </div>
        <button
          onClick={() => setShowGuide(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-sm font-semibold text-amber-700 hover:bg-amber-100 transition-all"
        >
          <HelpCircle className="w-4 h-4" />
          Import Guide
        </button>
      </div>

      {/* ═══ IMPORT ORDER BANNER ═══ */}
      <div className="bg-gradient-to-r from-indigo-50 via-violet-50 to-teal-50 border border-indigo-100 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-5 h-5 text-indigo-600" />
          <h3 className="font-bold text-slate-800 text-sm">Recommended Import Order</h3>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-0">
          {tabSteps.map((step, idx) => (
            <div key={step.key} className="flex items-center gap-2 sm:gap-3">
              <button
                onClick={() => setActiveTab(step.key)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all",
                  activeTab === step.key
                    ? `${tabColors[step.key].bg} ${tabColors[step.key].text} ring-2 ring-offset-1 ${tabColors[step.key].ring} shadow-sm`
                    : 'bg-white/80 text-slate-500 hover:bg-white border border-slate-200'
                )}
              >
                <span className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                  activeTab === step.key ? `${tabColors[step.key].btn} text-white` : 'bg-slate-200 text-slate-500'
                )}>
                  {step.step}
                </span>
                <step.icon className="w-4 h-4" />
                {step.label}
                {/* Show existing count */}
                <span className={cn(
                  "px-1.5 py-0.5 rounded-md text-xs font-bold",
                  step.key === 'parents' ? 'bg-violet-200/50 text-violet-600' :
                  step.key === 'teachers' ? 'bg-teal-200/50 text-teal-600' : 'bg-indigo-200/50 text-indigo-600'
                )}>
                  {step.key === 'parents' ? parents.length :
                   step.key === 'teachers' ? teachers.length : students.length}
                </span>
              </button>
              {idx < tabSteps.length - 1 && (
                <ArrowRight className="w-4 h-4 text-slate-300 hidden sm:block" />
              )}
            </div>
          ))}
        </div>
        {activeTab === 'students' && parents.length === 0 && (
          <div className="mt-3 flex items-center gap-2 text-amber-700 bg-amber-100 border border-amber-200 rounded-lg px-3 py-2 text-xs font-medium">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            No parents found! Upload parents first so you can assign students to them.
          </div>
        )}
      </div>

      {/* ═══ TOOLBAR ═══ */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Download Example */}
        <button
          onClick={() => {
            if (activeTab === 'parents') downloadCsv(PARENT_CSV_EXAMPLE, 'parents_example.csv');
            else if (activeTab === 'teachers') downloadCsv(TEACHER_CSV_EXAMPLE, 'teachers_example.csv');
            else downloadCsv(STUDENT_CSV_EXAMPLE, 'students_example.csv');
          }}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-sm",
            tc.btn, "text-white", tc.btnHover
          )}
        >
          <FileDown className="w-4 h-4" />
          Download Example CSV
        </button>

        {/* Toggle CSV/Form */}
        <button
          onClick={() => {
            if (activeTab === 'students') setStudentCsvMode(!studentCsvMode);
            else if (activeTab === 'teachers') setTeacherCsvMode(!teacherCsvMode);
            else setParentCsvMode(!parentCsvMode);
          }}
          className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-all"
        >
          <FileSpreadsheet className="w-4 h-4" />
          {(activeTab === 'students' && studentCsvMode) ||
           (activeTab === 'teachers' && teacherCsvMode) ||
           (activeTab === 'parents' && parentCsvMode)
            ? 'Switch to Form' : 'Paste CSV'}
        </button>

        {/* Upload file */}
        <label className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-all cursor-pointer">
          <Upload className="w-4 h-4" /> Upload CSV File
          <input type="file" accept=".csv,.txt" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
        </label>

        {/* CSV Help */}
        <button
          onClick={() => setShowCsvHelp(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-all"
        >
          <Info className="w-4 h-4" /> CSV Format
        </button>

        {/* Step Nav */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => {
              if (currentStepIndex > 0) setActiveTab(tabSteps[currentStepIndex - 1].key);
            }}
            disabled={currentStepIndex === 0}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="text-xs font-medium text-slate-400 px-1">
            Step {currentStep.step}/3
          </span>
          <button
            onClick={() => {
              if (currentStepIndex < tabSteps.length - 1) setActiveTab(tabSteps[currentStepIndex + 1].key);
            }}
            disabled={currentStepIndex === tabSteps.length - 1}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════ */}
      {/* PARENTS TAB (STEP 1) */}
      {/* ═══════════════════════════════════ */}
      {activeTab === 'parents' && (
        <>
          <div className={cn("rounded-xl p-3 border flex items-center gap-3 text-sm", tc.light, tc.border, tc.text)}>
            <Info className="w-4 h-4 flex-shrink-0" />
            <span><strong>Step 1:</strong> Upload parents first. Each parent needs a name, contact details, and location info.</span>
          </div>

          {parentCsvMode ? (
            <CsvPasteArea
              title="Paste Parent CSV"
              description="Format: Name, Email, Phone1, Phone2, Xafada, Udow, PaymentNumber"
              example={PARENT_CSV_EXAMPLE}
              value={parentCsv}
              onChange={setParentCsv}
              onImport={importParentCsv}
              onCancel={() => { setParentCsvMode(false); setParentCsv(''); }}
              onCopyTemplate={() => copyCsvTemplate(PARENT_CSV_EXAMPLE)}
              onDownloadExample={() => downloadCsv(PARENT_CSV_EXAMPLE, 'parents_example.csv')}
              color="violet"
            />
          ) : (
            <div className="space-y-4">
              {/* Quick add bar */}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => addParentRows(1)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add Row
                </button>
                <button onClick={() => addParentRows(5)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add 5 Rows
                </button>
                <button onClick={() => addParentRows(10)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add 10 Rows
                </button>
                <div className="ml-auto text-sm text-slate-500">
                  <span className="font-bold text-violet-600">{parentRows.filter(r => r.name.trim()).length}</span> / {parentRows.length} filled
                </div>
              </div>

              {/* Parent cards */}
              <div className="space-y-3">
                {parentRows.map((row, idx) => (
                  <div key={row.id} className="bg-white rounded-2xl border border-slate-200 p-4 group hover:shadow-md transition-all">
                    <div className="flex items-start gap-3">
                      <span className="text-sm text-slate-400 font-mono mt-2.5 w-6 flex-shrink-0">{idx + 1}</span>
                      <div className="flex-1 space-y-3">
                        {/* Name & Email */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <input type="text" placeholder="Full name *" value={row.name}
                            onChange={e => updateParentRow(row.id, 'name', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                          <input type="email" placeholder="Email" value={row.email}
                            onChange={e => updateParentRow(row.id, 'email', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                        </div>
                        {/* Phones & Payment */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <input type="text" placeholder="📱 Phone 1" value={row.phone1}
                            onChange={e => updateParentRow(row.id, 'phone1', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                          <input type="text" placeholder="📱 Phone 2" value={row.phone2}
                            onChange={e => updateParentRow(row.id, 'phone2', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                          <input type="text" placeholder="💳 Payment Number" value={row.paymentNumber}
                            onChange={e => updateParentRow(row.id, 'paymentNumber', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                        </div>
                        {/* Location */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <input type="text" placeholder="📍 Xafada (Neighborhood)" value={row.xafada}
                            onChange={e => updateParentRow(row.id, 'xafada', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                          <input type="text" placeholder="📍 Udow (Near to)" value={row.udow}
                            onChange={e => updateParentRow(row.id, 'udow', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-violet-200 focus:border-violet-400 outline-none" />
                        </div>
                      </div>
                      <button onClick={() => removeParentRow(row.id)}
                        className="p-1.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded-lg hover:bg-red-50 mt-1.5">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button onClick={submitParents}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-3 bg-violet-600 text-white rounded-xl font-bold text-sm hover:bg-violet-700 shadow-lg shadow-violet-200 transition-all">
                  <CheckCircle className="w-5 h-5" />
                  Create {parentRows.filter(r => r.name.trim()).length} Parents
                </button>
                <button onClick={() => setActiveTab('teachers')}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold text-sm hover:bg-slate-50 transition-all">
                  Next: Teachers <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════ */}
      {/* TEACHERS TAB (STEP 2) */}
      {/* ═══════════════════════════════════ */}
      {activeTab === 'teachers' && (
        <>
          <div className={cn("rounded-xl p-3 border flex items-center gap-3 text-sm", tc.light, tc.border, tc.text)}>
            <Info className="w-4 h-4 flex-shrink-0" />
            <span><strong>Step 2:</strong> Upload teachers and assign them to the classes they teach.</span>
          </div>

          {teacherCsvMode ? (
            <CsvPasteArea
              title="Paste Teacher CSV"
              description="Format: Name, Email, Classes (separated by semicolons)"
              example={TEACHER_CSV_EXAMPLE}
              value={teacherCsv}
              onChange={setTeacherCsv}
              onImport={importTeacherCsv}
              onCancel={() => { setTeacherCsvMode(false); setTeacherCsv(''); }}
              onCopyTemplate={() => copyCsvTemplate(TEACHER_CSV_EXAMPLE)}
              onDownloadExample={() => downloadCsv(TEACHER_CSV_EXAMPLE, 'teachers_example.csv')}
              color="teal"
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button onClick={addTeacherRow} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add Row
                </button>
                <div className="ml-auto text-sm text-slate-500">
                  <span className="font-bold text-teal-600">{teacherRows.filter(r => r.name.trim()).length}</span> / {teacherRows.length} filled
                </div>
              </div>

              <div className="space-y-3">
                {teacherRows.map((row, idx) => (
                  <div key={row.id} className="bg-white rounded-2xl border border-slate-200 p-4 group hover:shadow-md transition-all">
                    <div className="flex items-start gap-3">
                      <span className="text-sm text-slate-400 font-mono mt-2.5 w-6 flex-shrink-0">{idx + 1}</span>
                      <div className="flex-1 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <input type="text" placeholder="Full name *" value={row.name}
                            onChange={e => updateTeacherRow(row.id, 'name', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
                          <input type="email" placeholder="Email (auto-generated if empty)" value={row.email}
                            onChange={e => updateTeacherRow(row.id, 'email', e.target.value)}
                            className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-teal-200 focus:border-teal-400 outline-none" />
                        </div>
                        {/* Class Picker */}
                        <div>
                          <button
                            onClick={() => setShowClassPicker(showClassPicker === row.id ? null : row.id)}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-all w-full sm:w-auto"
                          >
                            <GraduationCap className="w-4 h-4 text-teal-500" />
                            {row.assignedClasses.length > 0
                              ? <span className="font-medium">{row.assignedClasses.length} classes assigned</span>
                              : <span className="text-slate-400">Select classes...</span>
                            }
                            <ChevronDown className={cn("w-4 h-4 ml-auto transition-transform", showClassPicker === row.id && 'rotate-180')} />
                          </button>
                          {showClassPicker === row.id && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {CLASSES.map(cls => (
                                <button key={cls} onClick={() => toggleTeacherClass(row.id, cls)}
                                  className={cn("px-3 py-1.5 rounded-lg text-xs font-medium transition-all border",
                                    row.assignedClasses.includes(cls)
                                      ? 'bg-teal-100 text-teal-700 border-teal-300'
                                      : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                                  )}>
                                  {cls}
                                </button>
                              ))}
                            </div>
                          )}
                          {row.assignedClasses.length > 0 && showClassPicker !== row.id && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {row.assignedClasses.map(cls => (
                                <span key={cls} className="bg-teal-50 text-teal-700 px-2 py-0.5 rounded-md text-xs font-medium">{cls}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <button onClick={() => removeTeacherRow(row.id)}
                        className="p-1.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded-lg hover:bg-red-50 mt-1.5">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button onClick={submitTeachers}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-2 px-6 py-3 bg-teal-600 text-white rounded-xl font-bold text-sm hover:bg-teal-700 shadow-lg shadow-teal-200 transition-all">
                  <CheckCircle className="w-5 h-5" />
                  Create {teacherRows.filter(r => r.name.trim()).length} Teachers
                </button>
                <button onClick={() => setActiveTab('students')}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold text-sm hover:bg-slate-50 transition-all">
                  Next: Students <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════ */}
      {/* STUDENTS TAB (STEP 3) */}
      {/* ═══════════════════════════════════ */}
      {activeTab === 'students' && (
        <>
          <div className={cn("rounded-xl p-3 border flex items-center gap-3 text-sm", tc.light, tc.border, tc.text)}>
            <Info className="w-4 h-4 flex-shrink-0" />
            <span><strong>Step 3:</strong> Upload students and assign each to a class and parent. Use parent name in CSV — it will auto-match.</span>
          </div>

          {studentCsvMode ? (
            <CsvPasteArea
              title="Paste Student CSV"
              description="Format: Name, Class, Parent Name"
              example={STUDENT_CSV_EXAMPLE}
              value={studentCsv}
              onChange={setStudentCsv}
              onImport={importStudentCsv}
              onCancel={() => { setStudentCsvMode(false); setStudentCsv(''); }}
              onCopyTemplate={() => copyCsvTemplate(STUDENT_CSV_EXAMPLE)}
              onDownloadExample={() => downloadCsv(STUDENT_CSV_EXAMPLE, 'students_example.csv')}
              color="indigo"
              extraInfo={
                parents.length > 0 ? (
                  <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-3 text-xs">
                    <p className="font-semibold text-indigo-700 mb-1">Available Parent Names (for matching):</p>
                    <div className="flex flex-wrap gap-1">
                      {parents.map(p => (
                        <span key={p.id} className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-md font-medium">{p.name}</span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700 font-medium flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    No parents in the system yet. Upload parents first (Step 1), then come back here.
                  </div>
                )
              }
            />
          ) : (
            <div className="space-y-4">
              {/* Quick add bar */}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => addStudentRows(1)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add Row
                </button>
                <button onClick={() => addStudentRows(5)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add 5 Rows
                </button>
                <button onClick={() => addStudentRows(10)} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Plus className="w-4 h-4" /> Add 10 Rows
                </button>
                <div className="ml-auto text-sm text-slate-500">
                  <span className="font-bold text-indigo-600">{studentRows.filter(r => r.name.trim()).length}</span> / {studentRows.length} filled
                </div>
              </div>

              {/* Student table */}
              <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase w-12">#</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase min-w-[180px]">Student Name *</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase min-w-[140px]">Class</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase min-w-[200px]">
                          Assign Parent
                          <span className="ml-1 text-[10px] normal-case font-normal text-slate-400">(by name or dropdown)</span>
                        </th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase w-16">Status</th>
                        <th className="w-12"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {studentRows.map((row, idx) => {
                        const hasParentName = row.parentName.trim().length > 0;
                        const isMatched = !!row.parentId;
                        const isUnmatched = hasParentName && !isMatched;
                        return (
                          <tr key={row.id} className={cn(
                            "hover:bg-slate-50 transition-colors group",
                            isUnmatched && 'bg-amber-50/50'
                          )}>
                            <td className="px-4 py-2 text-sm text-slate-400 font-mono">{idx + 1}</td>
                            <td className="px-4 py-2">
                              <input
                                type="text"
                                placeholder="Full name"
                                value={row.name}
                                onChange={e => updateStudentRow(row.id, 'name', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    const next = document.querySelector(`[data-student-name="${idx + 1}"]`) as HTMLInputElement;
                                    if (next) next.focus();
                                    else addStudentRows(1);
                                  }
                                }}
                                data-student-name={idx}
                              />
                            </td>
                            <td className="px-4 py-2">
                              <select
                                value={row.className}
                                onChange={e => updateStudentRow(row.id, 'className', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white"
                              >
                                {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-2">
                              <div className="space-y-1">
                                {/* Text input for parent name (for CSV data / typing) */}
                                <div className="relative">
                                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                                  <input
                                    type="text"
                                    placeholder="Type parent name..."
                                    value={row.parentName}
                                    onChange={e => updateStudentRow(row.id, 'parentName', e.target.value)}
                                    className={cn(
                                      "w-full pl-8 pr-3 py-1.5 rounded-lg border text-sm outline-none",
                                      isUnmatched
                                        ? 'border-amber-300 bg-amber-50 focus:ring-2 focus:ring-amber-200'
                                        : isMatched
                                          ? 'border-green-300 bg-green-50 focus:ring-2 focus:ring-green-200'
                                          : 'border-slate-200 focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400'
                                    )}
                                  />
                                  {isMatched && (
                                    <button
                                      onClick={() => { updateStudentRow(row.id, 'parentName', ''); updateStudentRow(row.id, 'parentId', ''); }}
                                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  )}
                                </div>
                                {/* Dropdown fallback */}
                                <select
                                  value={row.parentId}
                                  onChange={e => updateStudentRow(row.id, 'parentId', e.target.value)}
                                  className="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-xs focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none bg-white text-slate-500"
                                >
                                  <option value="">— or select from list —</option>
                                  {parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                              </div>
                            </td>
                            <td className="px-4 py-2">
                              {isMatched ? (
                                <span className="flex items-center gap-1 text-green-600 text-xs font-semibold">
                                  <CheckCircle className="w-3.5 h-3.5" /> Matched
                                </span>
                              ) : isUnmatched ? (
                                <span className="flex items-center gap-1 text-amber-600 text-xs font-semibold" title={`"${row.parentName}" not found`}>
                                  <AlertCircle className="w-3.5 h-3.5" /> No match
                                </span>
                              ) : (
                                <span className="text-slate-400 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2">
                              <button
                                onClick={() => removeStudentRow(row.id)}
                                className="p-1.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded-lg hover:bg-red-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Summary */}
              {studentRows.filter(r => r.name.trim()).length > 0 && (
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                  <h4 className="text-sm font-semibold text-slate-700 mb-2">Summary</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div className="bg-white rounded-lg p-2.5 border">
                      <span className="text-slate-500">Total students</span>
                      <p className="text-lg font-bold text-slate-800">{studentRows.filter(r => r.name.trim()).length}</p>
                    </div>
                    <div className="bg-white rounded-lg p-2.5 border">
                      <span className="text-green-600">Parent matched</span>
                      <p className="text-lg font-bold text-green-600">{studentRows.filter(r => r.name.trim() && r.parentId).length}</p>
                    </div>
                    <div className="bg-white rounded-lg p-2.5 border">
                      <span className="text-amber-600">No match</span>
                      <p className="text-lg font-bold text-amber-600">{studentRows.filter(r => r.name.trim() && r.parentName.trim() && !r.parentId).length}</p>
                    </div>
                    <div className="bg-white rounded-lg p-2.5 border">
                      <span className="text-slate-500">No parent</span>
                      <p className="text-lg font-bold text-slate-400">{studentRows.filter(r => r.name.trim() && !r.parentName.trim() && !r.parentId).length}</p>
                    </div>
                  </div>
                </div>
              )}

              <button onClick={submitStudents}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all">
                <CheckCircle className="w-5 h-5" />
                Create {studentRows.filter(r => r.name.trim()).length} Students
              </button>
            </div>
          )}
        </>
      )}

      {/* ═══ CSV FORMAT HELP DIALOG ═══ */}
      <Dialog open={showCsvHelp} onClose={() => setShowCsvHelp(false)} title="CSV Format Guide" className="max-w-2xl">
        <div className="space-y-5">
          {/* Parents */}
          <div className="bg-violet-50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-bold text-violet-800 text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-violet-600 text-white flex items-center justify-center text-xs">1</span>
                Parents CSV
              </h4>
              <button onClick={() => downloadCsv(PARENT_CSV_EXAMPLE, 'parents_example.csv')}
                className="flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-800">
                <FileDown className="w-3.5 h-3.5" /> Download
              </button>
            </div>
            <code className="text-xs text-violet-700 block bg-violet-100 p-3 rounded-lg font-mono whitespace-pre-wrap">
              Name, Email, Phone1, Phone2, Xafada, Udow, PaymentNumber{'\n'}
              Fadumo Abdi, fadumo@email.com, 0615551234, 0615551235, Hodan, Bakaaraha, EVC-0615551234
            </code>
          </div>

          {/* Teachers */}
          <div className="bg-teal-50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-bold text-teal-800 text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-teal-600 text-white flex items-center justify-center text-xs">2</span>
                Teachers CSV
              </h4>
              <button onClick={() => downloadCsv(TEACHER_CSV_EXAMPLE, 'teachers_example.csv')}
                className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-800">
                <FileDown className="w-3.5 h-3.5" /> Download
              </button>
            </div>
            <code className="text-xs text-teal-700 block bg-teal-100 p-3 rounded-lg font-mono whitespace-pre-wrap">
              Name, Email, Classes (semicolon-separated){'\n'}
              Mr. Abdirahman Ali, abdi@campus.edu, Grade 7-A;Grade 7-B;Grade 8-A
            </code>
          </div>

          {/* Students */}
          <div className="bg-indigo-50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-bold text-indigo-800 text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs">3</span>
                Students CSV
              </h4>
              <button onClick={() => downloadCsv(STUDENT_CSV_EXAMPLE, 'students_example.csv')}
                className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800">
                <FileDown className="w-3.5 h-3.5" /> Download
              </button>
            </div>
            <code className="text-xs text-indigo-700 block bg-indigo-100 p-3 rounded-lg font-mono whitespace-pre-wrap">
              Name, Class, Parent Name{'\n'}
              Abdikarim Fadumo, Grade 7-A, Fadumo Abdi{'\n'}
              Hamza Fadumo, Grade 8-A, Fadumo Abdi
            </code>
            <p className="text-xs text-indigo-600 mt-2 flex items-center gap-1">
              <Info className="w-3.5 h-3.5" />
              The "Parent Name" must exactly match a parent already in the system
            </p>
          </div>

          {/* Tips */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <h4 className="font-bold text-amber-800 text-sm mb-2">📌 Important Tips</h4>
            <ul className="text-xs text-amber-700 space-y-1.5 list-disc list-inside">
              <li><strong>Upload parents first</strong> → then teachers → then students</li>
              <li>Student CSV uses <strong>Parent Name</strong> (not ID) — it auto-matches</li>
              <li>If parent name doesn't match, you'll see a warning — fix it in the form</li>
              <li>Class names must match exactly (e.g., "Grade 10-A")</li>
              <li>First row is treated as header if it contains "Name" and "Class"/"Email"</li>
              <li>Fields separated by commas — empty fields OK (leave blank)</li>
            </ul>
          </div>
        </div>
      </Dialog>

      {/* ═══ IMPORT GUIDE DIALOG ═══ */}
      <Dialog open={showGuide} onClose={() => setShowGuide(false)} title="📋 Import Guide — How to Upload Data" className="max-w-2xl">
        <div className="space-y-6">
          <div className="bg-gradient-to-r from-indigo-50 to-violet-50 rounded-xl p-4 border border-indigo-100">
            <h4 className="font-bold text-slate-800 mb-2">Why does order matter?</h4>
            <p className="text-sm text-slate-600">
              Students need to be linked to their parents. If you upload students first,
              there are no parents in the system to assign them to. So always follow this order:
            </p>
          </div>

          {/* Step 1 */}
          <div className="flex gap-4">
            <div className="flex flex-col items-center">
              <span className="w-8 h-8 rounded-full bg-violet-600 text-white flex items-center justify-center font-bold text-sm">1</span>
              <div className="w-0.5 flex-1 bg-violet-200 mt-1" />
            </div>
            <div className="pb-6">
              <h4 className="font-bold text-violet-700">Upload Parents First</h4>
              <p className="text-sm text-slate-600 mt-1">
                Add all parents with their names, phone numbers, location (xafada, udow), and payment info.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={() => { setShowGuide(false); downloadCsv(PARENT_CSV_EXAMPLE, 'parents_example.csv'); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-100 text-violet-700 rounded-lg text-xs font-medium hover:bg-violet-200">
                  <FileDown className="w-3.5 h-3.5" /> Download parents_example.csv
                </button>
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-4">
            <div className="flex flex-col items-center">
              <span className="w-8 h-8 rounded-full bg-teal-600 text-white flex items-center justify-center font-bold text-sm">2</span>
              <div className="w-0.5 flex-1 bg-teal-200 mt-1" />
            </div>
            <div className="pb-6">
              <h4 className="font-bold text-teal-700">Upload Teachers</h4>
              <p className="text-sm text-slate-600 mt-1">
                Add teachers with their name, email, and the classes they teach (separated by semicolons in CSV).
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={() => { setShowGuide(false); downloadCsv(TEACHER_CSV_EXAMPLE, 'teachers_example.csv'); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-100 text-teal-700 rounded-lg text-xs font-medium hover:bg-teal-200">
                  <FileDown className="w-3.5 h-3.5" /> Download teachers_example.csv
                </button>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-4">
            <div className="flex flex-col items-center">
              <span className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-sm">3</span>
            </div>
            <div>
              <h4 className="font-bold text-indigo-700">Upload Students Last</h4>
              <p className="text-sm text-slate-600 mt-1">
                Add students with their name, class, and <strong>parent name</strong>.
                The system will automatically match the parent name to existing parents.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button onClick={() => { setShowGuide(false); downloadCsv(STUDENT_CSV_EXAMPLE, 'students_example.csv'); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium hover:bg-indigo-200">
                  <FileDown className="w-3.5 h-3.5" /> Download students_example.csv
                </button>
              </div>
            </div>
          </div>

          <div className="bg-green-50 border border-green-200 rounded-xl p-4">
            <h4 className="font-bold text-green-800 text-sm mb-1 flex items-center gap-2">
              <CheckCircle className="w-4 h-4" /> How CSV Parent Matching Works
            </h4>
            <p className="text-sm text-green-700">
              In the students CSV, the third column is <strong>"Parent Name"</strong>. When you import,
              CampusConnect automatically looks up that name in the existing parents list.
              If it finds an exact match, the student is linked. If not, you'll see a warning and can fix it manually.
            </p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════
// REUSABLE CSV PASTE AREA COMPONENT
// ═══════════════════════════════════
function CsvPasteArea({
  title, description, example, value, onChange, onImport, onCancel,
  onCopyTemplate, onDownloadExample, color, extraInfo
}: {
  title: string;
  description: string;
  example: string;
  value: string;
  onChange: (v: string) => void;
  onImport: () => void;
  onCancel: () => void;
  onCopyTemplate: () => void;
  onDownloadExample: () => void;
  color: 'indigo' | 'teal' | 'violet';
  extraInfo?: React.ReactNode;
}) {
  const colors = {
    indigo: { bg: 'bg-indigo-50', text: 'text-indigo-600', btn: 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200', ring: 'focus:ring-indigo-200 focus:border-indigo-400', hoverBg: 'hover:bg-indigo-100' },
    teal: { bg: 'bg-teal-50', text: 'text-teal-600', btn: 'bg-teal-600 hover:bg-teal-700 shadow-teal-200', ring: 'focus:ring-teal-200 focus:border-teal-400', hoverBg: 'hover:bg-teal-100' },
    violet: { bg: 'bg-violet-50', text: 'text-violet-600', btn: 'bg-violet-600 hover:bg-violet-700 shadow-violet-200', ring: 'focus:ring-violet-200 focus:border-violet-400', hoverBg: 'hover:bg-violet-100' },
  };
  const c = colors[color];

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800">{title}</h3>
        <div className="flex items-center gap-2">
          <button onClick={onDownloadExample}
            className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg", c.bg, c.text, c.hoverBg)}>
            <FileDown className="w-3.5 h-3.5" /> Download Example
          </button>
          <button onClick={onCopyTemplate}
            className={cn("flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg", c.bg, c.text, c.hoverBg)}>
            <Copy className="w-3.5 h-3.5" /> Copy Template
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        <code className="bg-slate-100 px-1.5 py-0.5 rounded">{description}</code>
        {' '}— first row with headers is auto-skipped
      </p>

      {extraInfo}

      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={10}
        placeholder={example}
        className={cn("w-full px-4 py-3 rounded-xl border border-slate-200 text-sm font-mono focus:ring-2 outline-none resize-none", c.ring)}
      />

      <div className="flex flex-wrap gap-3">
        <button onClick={onImport}
          className={cn("flex items-center gap-2 px-5 py-2.5 text-white rounded-xl font-medium text-sm shadow-lg transition-all", c.btn)}>
          <Download className="w-4 h-4" /> Import Rows
        </button>
        <button onClick={onCancel}
          className="px-5 py-2.5 bg-slate-100 text-slate-600 rounded-xl font-medium text-sm hover:bg-slate-200 transition-all">
          Cancel
        </button>
      </div>
    </div>
  );
}
