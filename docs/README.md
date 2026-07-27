# MBK International School — Documentation

A complete school management system built with React, Vite, and Supabase. Manages students, teachers, parents, and supervisors across 9 feature domains.

## Quick start

| Role | What you can do |
|------|----------------|
| Admin | Manage users, classes, exams, academic calendar, bulk uploads |
| Teacher | Enter exam results, record attendance, assign homework, create quizzes |
| Parent | View children's reports, take quizzes, monitor progress |
| Supervisor | Review lesson plans, verify exam entries, monitor teachers |

## Documentation

### Tutorials (start here)

- [Admin getting started](tutorials/admin-getting-started.md) — from login to your first exam entry
- [Teacher getting started](tutorials/teacher-getting-started.md) — from login to uploading results
- [Parent getting started](tutorials/parent-getting-started.md) — from login to viewing your child's report
- [Supervisor getting started](tutorials/supervisor-getting-started.md) — from login to reviewing lesson plans

### How-to guides

- [Set up academic year and terms](how-tos/setup-academic-year.md)
- [Create class-subject assignments](how-tos/create-class-subjects.md)
- [Enter and verify exam results](how-tos/enter-exam-results.md)
- [Create and manage quizzes](how-tos/manage-quizzes.md)
- [Record student attendance](how-tos/record-attendance.md)
- [Generate student reports](how-tos/generate-reports.md)
- [Use the AI lesson planner](how-tos/use-ai-lesson-planner.md)

### Explanations

- [Architecture overview](explanations/architecture.md) — why React+Vite+Supabase, how routing works
- [Data model design](explanations/data-model.md) — why profiles→students→exams, RLS policies
- [The theming system](explanations/theming.md) — 4 themes, light/dark variants, CSS variables
- [AI lesson plan review](explanations/ai-lesson-review.md) — edge function, scoring, supervisor workflow

### Reference

The full reference documentation lives in `.kb/` — 170 concept files covering schema, RLS policies, UI pages, and API functions across all 9 feature domains. Start with `.kb/index.md`.

## Stack

- **Frontend:** React 19, Vite 7, Tailwind CSS 4, React Router 7
- **Backend:** Supabase (PostgreSQL, Auth, RLS, Edge Functions)
- **State:** TanStack React Query
- **Build:** Single-file output via vite-plugin-singlefile

## Getting started

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env  # Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

# Start dev server
npm run dev

# Type check
npm run typecheck

# Run tests
npm run test
```
