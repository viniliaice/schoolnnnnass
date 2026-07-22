# Attendance & Homework Creation — Design Doc

## Problem

The `attendance` and `homework` tables exist in the Supabase DB but have no creation UI. The StreamsPage (`/streams`) and parent dashboard query them and always show "No records available." Meanwhile, `UploadResults.tsx` stores Attendance as an *exam type* in the `exams` table — that's a separate track for teacher-exam-entry progress reporting, not these per-student stream records.

## Principles

1. **Roll-call attendance** — students default to present; teacher only marks absent/late.
2. **Homework is class-level with per-student overrides** — one assignment targets a whole class; teacher can tweak due dates or add notes per student.
3. **New sidebar pages** — separate from Streams view, distinct from Upload Results.
4. **Roles** — Teachers, Admin, and Supervisors all get both pages.

## Feature 1: Record Attendance

### Data model (existing `attendance` table)

```
AttendanceRecord {
  id: string          // auto-generated
  studentId: string   // FK → students.id
  className: string
  date: string        // YYYY-MM-DD
  status: 'present' | 'absent' | 'late'
  note?: string
  teacherId: string   // FK → profiles.id
  createdAt: string
}
```

### UI flow (per-class navigation)

1. Teacher opens **Record Attendance** from sidebar
2. Sees a class selector dropdown (only classes they're assigned to; admin sees all)
3. Picks a class → date picker (defaults to today) → **Load** button
4. Page loads a table of all students in that class, each row showing:
   - Student name
   - Status dropdown (Present / Absent / Late) — default **Present** for all
   - Optional note field
5. Controls:
   - **Mark all absent** (bulk override row by row)
   - **Mark all late** (bulk override row by row)
   - **Reset all to present** (one click)
   - **Save** — inserts `attendance` rows only for non-present students (saves writes). If ALL students are Present, inserts a single summary marker row or skips (teacher sees "All present — nothing to save")
6. After save: toast success, optionally keep form for next entry

### Edge cases

- **Duplicate date+student**: warn "Attendance already recorded for [student] on [date]. Overwrite?" then upsert.
- **No students in class**: show empty state "No students enrolled in this class."
- **Weekend/holiday**: free-text note field lets teacher explain.

## Feature 2: Assign Homework

### Data model (existing `homework` table)

```
HomeworkRecord {
  id: string
  studentId: string   // FK → students.id
  className: string
  subject: string
  title: string
  description?: string
  dueDate: string
  status: 'assigned' | 'submitted' | 'graded'
  teacherId: string
  createdAt: string
}
```

### UI flow (two-tab layout, matching UploadResults step-indicator)

**Tab 1: View Assignments**
- Select class → see all homework assigned to that class
- Each row shows title, subject, due date, student count
- Edit: click to modify title/description/due date
- Delete: confirm dialog, removes all student rows for that assignment

**Tab 2: New Assignment** (two-step, step-indicator like UploadResults)
- Step 1 (Config):
  - Class dropdown (assigned for teacher/supervisor, all for admin)
  - Subject dropdown (pulls from assigned subjects via `class_subjects` join, stores name string)
  - Title (required), Description (optional), Due date (required)
- Step 2 (Students):
  - Table of all students in the class
  - Per-row overrides: Due date (prefilled editable), Notes (optional), Include? checkbox
  - Bulk: "Set all due dates to [date]" button
- **Assign** button → inserts one `homework` row per included student
- After save: toast success, offer "Assign another"

### Edge cases

- **Duplicate title+class+subject**: warn before creating duplicates
- **No students in class**: show empty state
- **Exempt all students**: block assign, "No students selected"

## Routing & Sidebar

### New routes

| Page               | Path                        | Roles                |
|--------------------|-----------------------------|----------------------|
| Record Attendance  | `/teacher/attendance`       | teacher, admin, supervisor |
| Assign Homework    | `/teacher/homework`         | teacher, admin, supervisor |

Admin sees them under different paths since admin routing uses `/admin/*`:
- Admin: `/admin/attendance`, `/admin/homework`
- Supervisor: `/supervisor/attendance`, `/supervisor/homework`

### Sidebar nav items

Add to admin, teacher, and supervisor nav arrays in `Sidebar.tsx`:
- `{ label: 'Record Attendance', icon: CalendarCheck, path: '/<role>/attendance' }`
- `{ label: 'Assign Homework', icon: BookOpenCheck, path: '/<role>/homework' }`

### App.tsx routes

Add cases to the teacher, admin, and supervisor route switches.

## DB layer

New file `src/lib/db/attendance.ts` and `src/lib/db/homework.ts` (or extend existing `streams.ts`):

```typescript
// attendance.ts
export async function getStudentsAttendanceStatus(classNames: string[], date: string): Promise<AttendanceRecord[]>
export async function upsertAttendanceBatch(records: { studentId: string; status: string; note?: string }[]): Promise<void>
export async function hasAttendanceForDate(className: string, date: string): Promise<boolean>

// homework.ts
export async function createHomeworkBatch(records: HomeworkRecord[]): Promise<void>
export async function getHomeworkByClass(className: string): Promise<HomeworkRecord[]>
export async function deleteHomework(id: string): Promise<void>
export async function updateHomework(id: string, data: Partial<HomeworkRecord>): Promise<void>
```

## Implementation order

1. `src/lib/db/attendance.ts` — DB functions for upserting attendance batch
2. `src/pages/teacher/RecordAttendance.tsx` — the attendance UI page
3. Wire into `Sidebar.tsx` and `App.tsx` routes for teacher, admin, supervisor
4. `src/lib/db/homework.ts` — DB functions for homework batch create
5. `src/pages/teacher/AssignHomework.tsx` — the homework UI page
6. Wire sidebar + routes for homework
7. Update `supabase-schema.sql` with table definitions for `attendance` and `homework` (currently missing from the file — they exist live but not in version control)
