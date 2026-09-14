// Content configuration for the three Academic Workspace help guides.
//
// Each config describes the REAL workflow as implemented in the app:
//   * bulk-grade-upload  → src/pages/teacher/BulkUploadGrades.tsx  (6-step wizard, teal)
//   * lesson-plan        → src/pages/teacher/LessonPlanner.tsx     (4-tab planner, indigo)
//   * unit-plan          → src/pages/teacher/UnitPlans.tsx         (form + list, indigo)
//
// The visuals are simplified mock renderings of the actual screens — the same
// labels, buttons, counts and messages that appear in the app. Nothing here is
// invented: every button name, error message and validation rule is taken from
// the real components.
//
// Adding a future workflow = adding one more config here. No component changes.

import {
  BookOpen,
  CalendarRange,
  ClipboardList,
  Download,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FolderOpen,
  Layers,
  ListChecks,
  PlusCircle,
  Save,
  SearchCheck,
  Send,
  Upload,
  Users,
} from 'lucide-react';
import type { WorkflowHelpConfig } from './WorkflowHelp';
import {
  Legend,
  Mark,
  MockButton,
  MockCard,
  MockCheck,
  MockChip,
  MockCountCard,
  MockInput,
  MockLabel,
  MockSelect,
  MockToast,
  ScoreCell,
  SpreadsheetMock,
} from './visuals';

// ─────────────────────────────────────────────────────────────────────────────
// 1 · BULK GRADE UPLOAD — mirrors BulkUploadGrades.tsx (6 steps, teal)
// ─────────────────────────────────────────────────────────────────────────────

const bulkGradeSpreadsheet = (
  <SpreadsheetMock
    headers={[
      <Mark key="h0" tone="amber" n={1}>
        Student Name
      </Mark>,
      <Mark key="h1" tone="amber">
        Mathematics HW1
      </Mark>,
      <Mark key="h2" tone="amber">
        Mathematics HW2
      </Mark>,
      <Mark key="h3" tone="amber">
        Mathematics CPW1
      </Mark>,
      <Mark key="h4" tone="amber">
        Mathematics Attendance
      </Mark>,
      <Mark key="h5" tone="amber">
        English MT
      </Mark>,
    ]}
    rows={[
      [
        'Axmed Cabdale',
        <Mark key="a" tone="teal" n={3}>
          <ScoreCell>4.5</ScoreCell>
        </Mark>,
        <ScoreCell key="b">5</ScoreCell>,
        <ScoreCell key="c">14</ScoreCell>,
        <ScoreCell key="d">20</ScoreCell>,
        <ScoreCell key="e">19</ScoreCell>,
      ],
      [
        'Fartun Axmed',
        <Mark key="f" tone="teal">
          <ScoreCell tone="note">Absent</ScoreCell>
        </Mark>,
        <ScoreCell key="g">5</ScoreCell>,
        <ScoreCell key="h" tone="note">N/A</ScoreCell>,
        <ScoreCell key="i" tone="blank">blank</ScoreCell>,
        <ScoreCell key="j">17.5</ScoreCell>,
      ],
      [
        'Maxamed Cabdi',
        <Mark key="k" tone="red" n={4}>
          <ScoreCell tone="bad">6</ScoreCell>
        </Mark>,
        <ScoreCell key="l">4</ScoreCell>,
        <ScoreCell key="m">15</ScoreCell>,
        <ScoreCell key="n">18</ScoreCell>,
        <ScoreCell key="o" tone="blank">blank</ScoreCell>,
      ],
    ]}
  />
);

export const bulkGradeUploadHelp: WorkflowHelpConfig = {
  id: 'bulk-grade-upload',
  title: 'Bulk Upload Grades',
  tagline: 'Enter grades for one class at a time using a ready-made workbook, then confirm the server-validated changes.',
  accent: 'teal',
  steps: [
    {
      id: 'class',
      icon: Users,
      title: 'Class & Subjects',
      summary:
        'Tap exactly one class — the classes you teach are shown as buttons. Then tick the subjects you want in this upload. Only the subjects you teach in that class are listed.',
      visual: (
        <div className="space-y-4">
          <div>
            <MockLabel>Class</MockLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Mark n={1}>
                <MockChip active>Grade 5-A</MockChip>
              </Mark>
              <MockChip>Grade 6-B</MockChip>
              <MockChip>Grade 7-A</MockChip>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <MockLabel>Subjects</MockLabel>
              <MockButton tone="outline" className="px-2.5 py-1 text-xs">
                Select all subjects
              </MockButton>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <Mark n={2}>
                <MockCheck checked>Mathematics</MockCheck>
              </Mark>
              <MockCheck checked>Science</MockCheck>
              <MockCheck>English</MockCheck>
              <MockCheck>Social Studies</MockCheck>
            </div>
            <Mark n={3}>
              <p className="mt-2 text-xs text-slate-500">27 students currently in Grade 5-A.</p>
            </Mark>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'One class per upload — this workflow is for a single class, not several classes at once.' },
            { n: 2, text: 'Only subjects you teach in that class appear here.' },
            { n: 3, text: 'The roster size is shown before you download, so you can spot a wrong class early.' },
          ]}
        />
      ),
      warning: 'Picking a different class later clears the subjects and any workbook you already uploaded — start here and stay on this class.',
    },
    {
      id: 'assessment',
      icon: ListChecks,
      title: 'Assessment blocks',
      summary:
        'The term is set for you. Choose the month and assessment date, then tick the assessment columns you want in the workbook. Each block has a fixed maximum score.',
      visual: (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold text-slate-500">Assessment blocks</p>
            <MockButton tone="outline" className="px-2.5 py-1 text-xs">
              Select all
            </MockButton>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Mark n={1} block>
              <MockSelect label="Term" value="Term 1 · 2026–27" disabled />
            </Mark>
            <MockSelect label="Month" value="September" />
            <MockSelect label="Assessment date" value="2026-09-14" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-2.5">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Homework</p>
              <div className="grid grid-cols-2 gap-1">
                {['HW1 / 5', 'HW2 / 5', 'HW3 / 5', 'HW4 / 5'].map(label => (
                  <MockCheck key={label} checked>
                    {label}
                  </MockCheck>
                ))}
              </div>
            </div>
            <Mark n={2} block>
              <div className="rounded-xl border border-slate-200 p-2.5">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">CPW</p>
                <div className="grid grid-cols-2 gap-1">
                  {['CPW1 / 15', 'CPW2 / 15', 'CPW3 / 15', 'CPW4 / 15'].map(label => (
                    <MockCheck key={label} checked>
                      {label}
                    </MockCheck>
                  ))}
                </div>
              </div>
            </Mark>
            <div className="rounded-xl border border-slate-200 p-2.5">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Attendance</p>
              <MockCheck checked>Attendance / 20</MockCheck>
            </div>
            <div className="rounded-xl border border-slate-200 p-2.5">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Midterm · Akhlaaq</p>
              <div className="space-y-1">
                <MockCheck checked>MT / 20</MockCheck>
                <MockCheck checked>Akhlaaq / 10</MockCheck>
              </div>
            </div>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'The term is read-only — it always shows the current term.' },
            { n: 2, text: 'Every block has a fixed maximum: HW /5, CPW /15, Attendance /20, MT /20, Akhlaaq /10. The server enforces them.' },
            { n: 3, text: 'Only the ticked blocks become columns in your workbook.' },
          ]}
        />
      ),
    },
    {
      id: 'upload',
      icon: Download,
      title: 'Download & upload the workbook',
      summary:
        'Press Download example to get a workbook for this class — one row per student, one column per subject-assessment. Enter your scores, save, then drop the file onto the upload area. Excel only, maximum 5 MB.',
      visual: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-800">Upload the completed workbook</p>
            <Mark n={2}>
              <MockButton tone="outline" className="border-teal-200 bg-teal-50 text-teal-700">
                <Download className="h-4 w-4" /> Download example
              </MockButton>
            </Mark>
          </div>
          {bulkGradeSpreadsheet}
          <Mark n={5} block className="mt-3">
            <div className="flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-200 p-4 text-center">
              <FileSpreadsheet className="mb-1.5 h-7 w-7 text-teal-600" />
              <p className="text-xs font-semibold text-slate-800">Select or drop the grade workbook</p>
              <p className="text-[11px] text-slate-500">Excel only, maximum 5 MB.</p>
            </div>
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'The app creates the Student Name rows and every column header — keep them exactly as downloaded.' },
            { n: 2, text: 'Download example always matches the class and subjects you selected.' },
            { n: 3, text: 'Enter whole or half points only (e.g. 4 or 4.5), or type “Absent” / “N/A” — blank means no grade.' },
            { n: 4, tone: 'red', text: 'Scores above the maximum (6 in HW1 /5) are flagged as workbook errors with the cell reference.' },
            { n: 5, text: 'Drop the saved file here. It is checked immediately, before anything is saved.' },
          ]}
        />
      ),
      warning:
        'Do not rename column headers, student names, or reorder rows — the workbook structure must stay exactly as downloaded, or rows go to Needs Review / Errors.',
    },
    {
      id: 'resolve',
      icon: SearchCheck,
      title: 'Resolve & Validate',
      summary:
        'After upload, the app checks every row and shows five counters: Valid, Errors, Needs Review, Excluded and Students. Fix file errors in your spreadsheet and upload again. When everything is clean, press Validate — the server re-checks it all and nothing is saved yet.',
      visual: (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
            <MockCountCard label="Valid" count={24} tone="teal" />
            <MockCountCard label="Errors" count={2} tone="red" />
            <MockCountCard label="Needs Review" count={1} tone="amber" />
            <MockCountCard label="Excluded" count={0} tone="slate" />
            <MockCountCard label="Students" count={27} tone="slate" />
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left">
            <p className="text-xs font-bold text-amber-900">Needs Review (1)</p>
            <p className="mt-1 text-xs text-amber-800">Fartun Axmed — Grade 5-A · could not match automatically.</p>
            <div className="mt-2 space-y-1">
              <Mark n={1} tone="teal" block>
                <MockButton tone="outline" className="w-full justify-start border-teal-200 bg-teal-50 text-teal-700">
                  Fartun Axmed (Grade 5-A) — Use this student
                </MockButton>
              </Mark>
              <Mark tone="slate">
                <MockButton tone="outline" className="px-3 py-1.5 text-xs">
                  Exclude row
                </MockButton>
              </Mark>
            </div>
          </div>
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-left">
            <p className="text-xs font-bold text-red-900">Workbook errors (2)</p>
            <p className="mt-1 text-xs text-red-800">• D5: Mathematics HW1 cannot exceed 5.</p>
            <p className="text-xs text-red-800">• F7: Science CPW1 must be a number from 0 to 15 in whole or half points.</p>
          </div>
          <div className="flex justify-end">
            <Mark n={2} tone="teal">
              <MockButton>Validate 24 records →</MockButton>
            </Mark>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Amber “Needs Review” rows need a decision: pick the matching student or exclude the row.' },
            { n: 2, text: 'Red errors must be fixed in Excel (or the row removed) before Validate unlocks.' },
            { n: 3, text: 'Validate sends your rows to the server for a full re-check — still nothing is saved.' },
          ]}
        />
      ),
      warning: 'You can always go Back, fix your spreadsheet, and upload it again — your class, subjects and assessment choices are kept.',
    },
    {
      id: 'review',
      icon: Eye,
      title: 'Review changes',
      summary:
        'The server computed exactly what will change. New grades appear without a current value; updated grades show the database value and your new value. A red panel lists grades that were already approved — uploading returns them to Pending review.',
      visual: (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            <MockCountCard label="New grades" count={18} tone="teal" />
            <MockCountCard label="Grades changing" count={4} tone="amber" />
            <MockCountCard label="Records in upload" count={24} tone="slate" />
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Student</th>
                  <th className="px-2 py-1.5">Subject</th>
                  <th className="px-2 py-1.5">Assessment</th>
                  <th className="px-2 py-1.5">Current</th>
                  <th className="px-2 py-1.5">New</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-2 py-1.5 font-semibold text-slate-800">Axmed Cabdale</td>
                  <td className="px-2 py-1.5 text-slate-600">Mathematics</td>
                  <td className="px-2 py-1.5 text-slate-600">HW1</td>
                  <td className="px-2 py-1.5 text-slate-400">
                    <Mark n={1}>—</Mark>
                  </td>
                  <td className="px-2 py-1.5">
                    <ScoreCell>4.5</ScoreCell>
                  </td>
                </tr>
                <tr>
                  <td className="px-2 py-1.5 font-semibold text-slate-800">Fartun Axmed</td>
                  <td className="px-2 py-1.5 text-slate-600">Science</td>
                  <td className="px-2 py-1.5 text-slate-600">CPW2</td>
                  <td className="px-2 py-1.5 text-slate-500">12</td>
                  <td className="px-2 py-1.5">
                    <Mark n={2}>
                      <ScoreCell tone="note">→ 14</ScoreCell>
                    </Mark>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Mark n={3} tone="red" block>
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-left">
              <p className="text-xs font-bold text-red-900">Approved grades being changed (1)</p>
              <p className="mt-1 text-xs text-red-800">
                • Maxamed Cabdi · MT · 19 → 20 · <span className="font-bold">Approved → Pending</span>
              </p>
            </div>
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: '“New” rows have no current value — these are brand-new grades.' },
            { n: 2, text: 'Updates show database current → your new value; nothing has been written yet.' },
            { n: 3, tone: 'red', text: 'Approved grades being changed will return to Pending review after upload.' },
          ]}
        />
      ),
    },
    {
      id: 'confirm',
      icon: Send,
      title: 'Confirm & Upload',
      summary:
        'The summary lists your class, subjects, students and every change with errors at 0. If approved grades are affected, tick the acknowledgement. Confirm & Upload saves everything in one atomic step — this is the only point where grades are written.',
      visual: (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {[
              ['Class', 'Grade 5-A'],
              ['Subjects', 'Mathematics, Science'],
              ['Students', '27'],
              ['New grades', '18'],
              ['Grades changing', '4'],
              ['Approved changing', '1'],
              ['Errors', '0'],
              ['Assessment blocks', 'HW1–HW4, CPW1, MT'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 p-2">
                <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-800">{value}</p>
              </div>
            ))}
          </div>
          <Mark n={2} tone="red" block>
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-xs text-red-900">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-red-300 bg-white text-[10px] font-bold text-red-600">
                ✓
              </span>
              I understand that the 1 approved grade shown in the review will be replaced and returned to Pending review.
            </div>
          </Mark>
          <div className="flex justify-end">
            <Mark n={1} tone="teal">
              <MockButton>
                <Upload className="h-4 w-4" /> Confirm &amp; Upload
              </MockButton>
            </Mark>
          </div>
          <Mark n={3} block>
            <MockToast
              tone="success"
              title="Grades saved: 18 created, 4 updated"
              description="Upload reference: upl_1f4e2a — the workflow resets for the next class."
            />
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Confirm & Upload writes every change at once — nothing is saved before this button.' },
            { n: 2, text: 'The acknowledgement unlocks the button when approved grades are affected.' },
            { n: 3, text: 'The success toast confirms how many grades were created and updated.' },
          ]}
        />
      ),
    },
  ],
  good: {
    title: 'Correct',
    items: [
      'One class selected, with only that class’s subjects ticked.',
      'Workbook downloaded from this page — student rows match the roster.',
      'Scores inside each maximum: HW /5 · CPW /15 · Attendance /20 · MT /20 · Akhlaaq /10.',
      'Resolve shows 0 errors and 0 needs-review, then Validate runs.',
      'Confirm shows the “Grades saved” toast.',
    ],
  },
  mistakes: {
    title: 'Common mistakes',
    items: [
      'Renaming column headers, reordering rows, or editing the Student Name column.',
      'Scores above the maximum or not whole/half points — flagged with cell references.',
      'Skipping Needs Review rows — every row must be chosen or excluded.',
      'Expecting a multi-class upload — this workflow is one class at a time.',
      'Trying to Validate with errors — the button stays disabled.',
    ],
  },
  finalNote: 'Grades are never saved until you press Confirm & Upload on the final step.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 2 · LESSON PLANS — mirrors LessonPlanner.tsx (4 tabs, indigo)
// ─────────────────────────────────────────────────────────────────────────────

export const lessonPlanHelp: WorkflowHelpConfig = {
  id: 'lesson-plan',
  title: 'Lesson Plans',
  tagline: 'Plan the week period-by-period, review it, and submit it to your supervisor — right inside the app.',
  accent: 'indigo',
  steps: [
    {
      id: 'setup',
      icon: BookOpen,
      title: 'Setup — class, week & periods',
      summary:
        'Pick the class you teach and how many periods each school day has (4, 5 or 6). Use the arrows to move to the week you are planning, then press Start Planning.',
      visual: (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Mark n={1} block>
              <MockSelect label="Class" value="Grade 5-A" />
            </Mark>
            <Mark n={2} block>
              <MockSelect label="Periods per day" value="5 periods" />
            </Mark>
          </div>
          <Mark n={3} block>
            <div className="flex items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white py-2">
              <span className="text-slate-400">‹</span>
              <span className="text-sm font-semibold text-slate-700">7 Sep – 11 Sep 2026</span>
              <span className="text-slate-400">›</span>
            </div>
          </Mark>
          <MockInput label="Title" value="Week 31 – Fractions" optional />
          <div className="flex justify-end">
            <Mark n={4}>
              <MockButton tone="indigo">Start Planning</MockButton>
            </Mark>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'The class controls which subjects appear in the grid.' },
            { n: 2, text: 'Classes run 4, 5 or 6 periods a day — pick what applies to this class.' },
            { n: 3, text: 'Move weeks with the arrows; the shown dates always follow the selected week.' },
            { n: 4, text: 'Start Planning creates this week’s plan — or opens it if it already exists.' },
          ]}
        />
      ),
      warning: 'Start Planning stays disabled until a class is selected.',
    },
    {
      id: 'plan',
      icon: CalendarRange,
      title: 'Fill the weekly grid',
      summary:
        'Each cell is one period of one day: choose a subject (or Free Period) and add the topic, objective, slide number and activities. The app autosaves — the “All changes saved” pill appears after a few seconds.',
      visual: (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="grid grid-cols-5 border-b border-slate-200 bg-slate-50 text-center text-[10px] font-semibold text-slate-600">
              <div className="py-1.5">Sat 5/9</div>
              <div className="border-l border-slate-200 py-1.5">Sun 6/9</div>
              <div className="border-l border-slate-200 py-1.5">Mon 7/9</div>
              <div className="border-l border-slate-200 py-1.5">Tue 8/9</div>
              <div className="border-l border-slate-200 py-1.5">Wed 9/9</div>
            </div>
            <div className="grid grid-cols-5">
              <div className="p-2 text-[10px] text-slate-400">P1</div>
              <div className="col-span-2 border-l border-slate-100 p-2 text-left">
                <div className="space-y-1">
                  <Mark n={1} block>
                    <MockSelect label="Subj:" value="Mathematics" />
                  </Mark>
                  <Mark n={2} block>
                    <MockInput label="Topic" value="Fractions: adding halves" />
                  </Mark>
                  <Mark n={3} block>
                    <MockInput label="Objective" value="Add halves to make a whole" />
                  </Mark>
                  <Mark n={4} block>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                      <span className="font-semibold">Activities</span>
                      <p className="mt-0.5">1. Warm-up quiz (10 min)</p>
                    </div>
                  </Mark>
                </div>
              </div>
              <div className="col-span-2 border-l border-slate-100 p-2">
                <div className="flex h-full items-center justify-center">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-600">
                    Free Period
                  </span>
                </div>
              </div>
            </div>
          </div>
          <Mark n={5} block>
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <MockButton tone="outline" className="px-3 py-1.5 text-xs">
                <Upload className="h-3.5 w-3.5" /> Upload from Excel
              </MockButton>
              <span className="text-[10px] text-slate-400">Supports .xlsx, .xls, .csv</span>
              <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-medium text-emerald-700">
                week31.xlsx
              </span>
            </div>
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Pick the subject you teach in this class — or mark the period Free.' },
            { n: 2, text: 'A topic is required for every active period before submission.' },
            { n: 3, text: 'Objective and slide number are optional per period.' },
            { n: 4, text: 'Activities can each have a time, resource and place.' },
            { n: 5, text: 'Optional: import from Excel with Date, Period, Subject, Topic, Objective and Activity columns.' },
          ]}
        />
      ),
      warning: 'You can continue only when at least one period has a topic — empty periods are listed before submission.',
    },
    {
      id: 'review',
      icon: FileCheck2,
      title: 'Review & Submit',
      summary:
        'A readiness banner tells you if anything is missing and shows completion. Check the day-by-day summary, then press Submit to Supervisor — your plan is saved, locked, and AI review starts automatically in the background.',
      visual: (
        <div className="space-y-3">
          <Mark n={2} block>
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-left">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                ✓
              </span>
              <div>
                <p className="text-xs font-semibold text-emerald-800">This plan is ready to submit</p>
                <p className="text-[11px] text-emerald-700">
                  Once submitted, the plan goes to your supervisor and an AI review is generated automatically.
                </p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/70">
                  <div className="h-full w-full rounded-full bg-emerald-500" />
                </div>
                <p className="mt-1 text-[10px] text-slate-500">100% complete</p>
              </div>
            </div>
          </Mark>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
            <MockCountCard label="Periods planned" count={25} tone="slate" />
            <MockCountCard label="Empty periods" count={0} tone="slate" />
            <MockCountCard label="Free periods" count={0} tone="slate" />
            <MockCountCard label="With objectives" count={25} tone="slate" />
            <MockCountCard label="Activities" count={12} tone="slate" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MockButton tone="outline">
              <Download className="h-3.5 w-3.5" /> Export PDF
            </MockButton>
            <Mark n={1}>
              <MockButton tone="indigo">
                <Send className="h-3.5 w-3.5" /> Submit to Supervisor
              </MockButton>
            </Mark>
          </div>
          <Mark n={3} block>
            <MockToast
              tone="success"
              title="Submitted to supervisor"
              description="Your plan is locked and saved. AI review is running in the background."
            />
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Submit saves and locks the plan, then sends it to your supervisor.' },
            { n: 2, text: 'Green banner = ready. Amber banner lists the periods that still need a topic.' },
            { n: 3, text: 'AI review runs in the background — your supervisor sees its results.' },
          ]}
        />
      ),
      warning: 'After submission the plan becomes read-only. To change it, ask your supervisor to request revisions.',
    },
    {
      id: 'mine',
      icon: FolderOpen,
      title: 'My Lesson Plans',
      summary:
        'All your plans live here. Open a draft to keep editing; submitted plans show their status and stay read-only until your supervisor requests revisions.',
      visual: (
        <div className="space-y-2">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div>
              <p className="text-xs font-semibold text-slate-800">Week 30 – Grade 5-A</p>
              <p className="text-[10px] text-slate-500">7 Sep – 11 Sep 2026</p>
            </div>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700">draft</span>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div>
              <p className="text-xs font-semibold text-slate-800">Week 29 – Grade 5-A</p>
              <p className="text-[10px] text-slate-500">31 Aug – 4 Sep 2026</p>
            </div>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
              submitted · read-only
            </span>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-left">
            <span className="mt-0.5 text-amber-600">⚠</span>
            <div>
              <p className="text-xs font-bold text-amber-900">Revisions requested — this plan is editable again</p>
              <p className="text-[11px] text-amber-800">
                Supervisor note: “Please add objectives to Thursday’s lessons.”
              </p>
            </div>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Every plan shows its status: draft or submitted.' },
            { n: 2, text: 'Submitted plans open read-only with a lock banner.' },
            { n: 3, text: 'A revision request from your supervisor re-opens editing.' },
          ]}
        />
      ),
    },
  ],
  good: {
    title: 'Correct',
    items: [
      'Class, week and periods per day set before planning.',
      'Every active period has a topic; free periods are marked Free.',
      'Review banner is green: “This plan is ready to submit”.',
      'After submit: “Submitted to supervisor” toast, and the plan appears under My Lesson Plans.',
    ],
  },
  mistakes: {
    title: 'Common mistakes',
    items: [
      'Wrong class or week — always check the date range in the header.',
      'Leaving periods empty — submission is blocked and the empty periods are listed.',
      'Importing an Excel file without Date, Period and Subject columns (“No valid rows found”).',
      'Trying to edit a submitted plan — it is locked until revisions are requested.',
    ],
  },
  finalNote: 'Plans save automatically as you type — but nothing reaches your supervisor until you press Submit to Supervisor.',
};

// ─────────────────────────────────────────────────────────────────────────────
// 3 · UNIT PLANS — mirrors UnitPlans.tsx (form + list, indigo)
// ─────────────────────────────────────────────────────────────────────────────

export const unitPlanHelp: WorkflowHelpConfig = {
  id: 'unit-plan',
  title: 'Unit Plans',
  tagline: 'Group your lesson plans into curriculum units — created with a form in this app, no file upload needed.',
  accent: 'indigo',
  steps: [
    {
      id: 'create',
      icon: PlusCircle,
      title: 'Open the unit form',
      summary:
        'Unit plans group your lesson plans into curriculum units. Press New Unit Plan in the top-right corner to open the form. There is no spreadsheet to upload — the unit is created directly in the app.',
      visual: (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Unit Plans</p>
              <p className="text-xs text-slate-500">Group your lesson plans into curriculum units</p>
            </div>
            <Mark n={1}>
              <MockButton tone="indigo">
                <PlusCircle className="h-4 w-4" /> New Unit Plan
              </MockButton>
            </Mark>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
            <Layers className="mx-auto mb-1.5 h-6 w-6 text-slate-400" />
            <p className="text-xs font-semibold text-slate-800">No unit plans yet</p>
            <p className="text-[11px] text-slate-500">Create your first unit to start grouping your lesson plans.</p>
            <Mark n={2} className="mt-2">
              <MockButton tone="indigo" className="px-3 py-1.5 text-xs">
                Create Unit Plan
              </MockButton>
            </Mark>
          </div>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'New Unit Plan opens the form — your existing list stays underneath.' },
            { n: 2, text: 'The empty state offers the same button.' },
          ]}
        />
      ),
    },
    {
      id: 'details',
      icon: ClipboardList,
      title: 'Fill in the unit details',
      summary:
        'Give the unit a name, choose its class, subject and term, set the weeks it covers, and write the learning objectives. Starred fields are required.',
      visual: (
        <div className="space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Mark n={1} block>
                <MockInput label="Unit Name *" value="Fractions & Decimals" />
              </Mark>
            </div>
            <Mark n={2} block>
              <MockSelect label="Class *" value="Grade 5-A" />
            </Mark>
            <Mark n={3} block>
              <MockSelect label="Subject *" value="Mathematics" />
            </Mark>
            <Mark n={4} block>
              <MockSelect label="Term *" value="Term 1 · 2026–27" />
            </Mark>
            <div className="grid grid-cols-2 gap-2">
              <Mark n={5} block>
                <MockInput label="Start Week" value="5" />
              </Mark>
              <Mark n={5} block>
                <MockInput label="End Week" value="8" />
              </Mark>
            </div>
            <div className="sm:col-span-2">
              <Mark n={6} block>
                <label className="block text-xs font-medium text-slate-600">
                  Learning Objectives *
                  <span className="mt-1 block rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 leading-relaxed text-slate-700">
                    Add and subtract fractions with like denominators; compare decimal numbers…
                  </span>
                </label>
              </Mark>
            </div>
          </div>
          <p className="text-[11px] text-slate-500">Term: 30 Aug 2026 – 31 Dec 2026</p>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'A clear name, e.g. “Fractions & Decimals”.' },
            { n: 2, text: 'The class this unit belongs to.' },
            { n: 3, text: 'Teachers only see subjects they teach in the chosen class.' },
            { n: 4, text: 'The term sets the school period.' },
            { n: 5, text: 'The unit’s teaching window, in weeks within the term.' },
            { n: 6, text: 'What students should be able to do by the end of the unit.' },
          ]}
        />
      ),
      warning: 'The end week must be the same as or after the start week — otherwise the app blocks saving.',
    },
    {
      id: 'save',
      icon: Save,
      title: 'Create the unit',
      summary:
        'Press Create. The app checks that every required field is filled and that the weeks are in order — on success the unit appears in your list.',
      visual: (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Mark n={1}>
              <MockButton tone="indigo">Create</MockButton>
            </Mark>
            <MockButton tone="outline">Cancel</MockButton>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <Mark n={2} tone="red" block>
              <MockToast tone="error" title="Please fill in all required fields" />
            </Mark>
            <Mark n={2} tone="red" block>
              <MockToast tone="error" title="End week must be after start week" />
            </Mark>
          </div>
          <Mark n={3} tone="indigo" block>
            <MockToast tone="success" title="Unit plan created" />
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'Create saves the unit immediately — no extra upload step.' },
            { n: 2, text: 'Missing fields or reversed weeks are reported as error toasts and the form stays open.' },
            { n: 3, text: 'Success shows “Unit plan created” and the unit joins your list.' },
          ]}
        />
      ),
    },
    {
      id: 'manage',
      icon: Eye,
      title: 'Review & manage your units',
      summary:
        'Your units are listed with class, subject and weeks. Use the eye icon to view the full unit, the pencil to edit it, and the bin to delete it.',
      visual: (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Class</th>
                  <th className="px-2 py-1.5">Subject</th>
                  <th className="px-2 py-1.5">Weeks</th>
                  <th className="px-2 py-1.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-2 py-1.5 font-semibold text-slate-800">Fractions &amp; Decimals</td>
                  <td className="px-2 py-1.5 text-slate-600">Grade 5-A</td>
                  <td className="px-2 py-1.5 text-slate-600">Mathematics</td>
                  <td className="px-2 py-1.5 text-slate-600">Week 5 - Week 8</td>
                  <td className="px-2 py-1.5 text-right">
                    <span className="inline-flex gap-1">
                      <Mark n={1}>
                        <MockButton tone="outline" className="px-2 py-1 text-[10px]">
                          <Eye className="h-3 w-3" />
                        </MockButton>
                      </Mark>
                      <Mark n={2}>
                        <MockButton tone="outline" className="px-2 py-1 text-[10px]">
                          ✎
                        </MockButton>
                      </Mark>
                      <Mark n={3} tone="red">
                        <MockButton tone="outline" className="px-2 py-1 text-[10px] text-red-600">
                          🗑
                        </MockButton>
                      </Mark>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Mark n={4} block>
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3 text-left">
              <p className="text-xs font-bold text-indigo-900">Fractions &amp; Decimals</p>
              <p className="text-[11px] text-slate-500">Grade 5-A · Mathematics · Term 1</p>
              <div className="mt-2 rounded-lg bg-white p-2 text-[11px] leading-relaxed text-slate-700">
                <span className="font-bold">Learning objectives:</span> Add and subtract fractions with like
                denominators; compare decimal numbers…
              </div>
            </div>
          </Mark>
        </div>
      ),
      legend: (
        <Legend
          items={[
            { n: 1, text: 'View opens the unit summary: class, subject, term, teaching window and objectives.' },
            { n: 2, text: 'Edit re-opens the form with the current values.' },
            { n: 3, text: 'Delete removes the unit after a confirmation — lesson plans keep their data.' },
            { n: 4, text: 'The view is the unit’s real layout: header, teaching window, learning objectives.' },
          ]}
        />
      ),
      warning: 'Deleting a unit does not delete lesson plans — they keep their data but no longer belong to a unit.',
    },
  ],
  good: {
    title: 'Correct unit plan',
    items: [
      'Name, class, subject, term and objectives all filled.',
      'Class and subject match the lessons the unit will group.',
      'End week is the same as or after the start week.',
      'The unit appears in the list right after “Unit plan created”.',
    ],
  },
  mistakes: {
    title: 'Common errors',
    items: [
      'Missing required fields — blocked with “Please fill in all required fields”.',
      'End week before start week — blocked with “End week must be after start week”.',
      'Wrong class or subject for the unit.',
      'Empty or one-line learning objectives.',
      'Looking for a file-upload step — unit plans are created with this form, not uploaded.',
    ],
  },
  finalNote: 'Unit plans are created with this form — there is no spreadsheet or file to upload.',
};

// ─────────────────────────────────────────────────────────────────────────────

/** All registered help guides, keyed by config id. */
export const WORKFLOW_HELP_CONFIGS: Record<string, WorkflowHelpConfig> = {
  [bulkGradeUploadHelp.id]: bulkGradeUploadHelp,
  [lessonPlanHelp.id]: lessonPlanHelp,
  [unitPlanHelp.id]: unitPlanHelp,
};

/** Resolve a guide by id (useful for shared headers/toolbars). */
export function getWorkflowHelpConfig(id: string): WorkflowHelpConfig | undefined {
  return WORKFLOW_HELP_CONFIGS[id];
}
