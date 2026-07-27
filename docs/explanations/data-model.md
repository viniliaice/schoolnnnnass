# Data Model Design

Why the database is structured the way it is, and how the entities relate.

## The problem

A school management system needs to track:
- Users (admin, teacher, parent, supervisor)
- Students and their class enrollments
- Exam results across subjects, months, and exam types
- Academic calendar (years, terms, months)
- Assignments (which teacher teaches which class-subject)
- Reports (aggregated exam data)

The challenge: these entities have complex relationships, and the access patterns differ by role.

## The approach

### Core entity relationship

```
profiles (users)
  ├── students (one profile → many students via parentId)
  ├── exams (one teacher → many exams via teacherId)
  ├── class_subjects (one teacher → many assignments)
  └── auth_id → auth.users (Supabase auth)

students
  ├── exams (one student → many exams)
  ├── attendance (one student → many records)
  └── parentId → profiles (link to parent)

class_subjects
  ├── className + subjectId → subjects
  └── teacherId → profiles
```

### Why profiles instead of users

The `profiles` table stores application-level user data. Supabase's `auth.users` handles authentication. They're linked via `auth_id`:

```
auth.users (Supabase)     profiles (Application)
├── id (UUID)             ├── id (TEXT)
├── email                 ├── auth_id → auth.users.id
└── password_hash         ├── name
                          ├── role
                          ├── assignedClasses
                          └── assignedSubjects
```

This separation means:
- Auth is handled by Supabase (secure, maintained)
- Application data is in our control (flexible schema)
- The `auth_id` link allows session restoration

### Why exams are the central entity

The exam table connects everything:

```
exam
├── studentId → students
├── teacherId → profiles
├── subject (text, denormalized)
├── examType (CA, Homework, Classwork, Quiz, Midterm, Final)
├── month (text)
├── status (pending → approved/rejected)
└── termId → terms (optional)
```

The `status` field creates a workflow: teachers enter → supervisors approve → parents see. This two-step process ensures data quality.

### Why class_subjects exists

Teachers don't just teach "Mathematics" — they teach "Mathematics to Grade 5-A". The `class_subjects` table captures this:

```
class_subjects
├── className: "Grade 5-A"
├── subjectId → subjects
└── teacherId → profiles
```

This enables:
- Teachers see only their assigned classes
- Supervisors monitor specific class-subject combinations
- Reports aggregate by class-subject

### RLS policies

Row-Level Security ensures each role sees only what they should:

```
Teacher: WHERE teacherId = auth.uid()
  → can only see their own exam entries

Parent:  WHERE parentId = auth.uid()
  → can only see their children's exams

Student: WHERE studentId = auth.uid()
  → can only see their own exams
```

Supervisors bypass RLS — they need to see all data for verification.

## Trade-offs

**Denormalized subject on exams:** The `exams` table stores `subject` as text, not a foreign key. This duplicates data but simplifies queries — no JOIN needed for basic exam listing.

**Text IDs:** The app uses TEXT for primary keys (nanoid or similar). UUIDs would be more standard but TEXT is simpler and works with Supabase.

**Term linkage is optional:** Exams can exist without a `termId`. This allows flexibility but means reports must handle orphaned exams.

## Alternatives considered

**Normalized subject:** Using `subjectId` as a foreign key on exams would prevent typos but add a JOIN to every exam query. The denormalized approach was chosen for query simplicity.

**Separate exam_types table:** An enum or lookup table for exam types would be more normalized but the types are fixed and small — an enum in the CHECK constraint is sufficient.

**Soft deletes:** Adding a `deletedAt` timestamp would allow recovery but adds complexity. The current approach uses hard deletes with CASCADE.
