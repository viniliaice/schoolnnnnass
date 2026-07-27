# Tutorial: Admin Getting Started

This tutorial walks you through the admin workflow — from logging in to entering your first exam result. You'll learn the core navigation, understand the role-based dashboard, and complete a real task.

## What you'll need

- Admin credentials (email + password)
- A browser (Chrome, Firefox, or Edge)
- The application URL (e.g., `http://localhost:5173` in development)

## Step 1: Log in

1. Open the application URL.
2. You'll see the login page with the MBK International School branding.
3. Enter your admin email and password.
4. Click **Sign In**.

You'll land on the **Admin Dashboard** — the central hub showing key stats: total students, teachers, classes, and exam progress.

## Step 2: Explore the dashboard

The dashboard displays:

- **Student count** — total enrolled students
- **Teacher count** — active teachers
- **Class count** — classes with assigned subjects
- **Exam progress** — percentage of exams entered this month

The sidebar on the left shows all admin navigation. Each section corresponds to a feature domain.

## Step 3: Set up the academic year

Before entering exams, you need an active academic year and term.

1. Click **Academic** in the sidebar.
2. If no academic year exists, click **Create Year**.
3. Enter the year name (e.g., "2025-2026"), start date, and end date.
4. Toggle **Is Current** to on.
5. Create a term within that year (e.g., "Term 1").
6. Select the months this term covers.

Now the system knows which term exams belong to.

## Step 4: Assign teachers to classes

Teachers need class-subject assignments before they can enter grades.

1. Click **Class Subjects** in the sidebar.
2. Select a class (e.g., "Grade 5-A").
3. Select a subject (e.g., "Mathematics").
4. Assign a teacher.
5. Click **Save**.

Repeat for each class-subject-teacher combination.

## Step 5: Enter an exam result

Now try entering a student's exam result:

1. Click **Exam Reports** or navigate to a class view.
2. Select the class, subject, month, and exam type (e.g., "CA").
3. Find the student in the list.
4. Enter their score (e.g., 85) and total (e.g., 100).
5. Click **Save**.

The exam saves with status "pending" — supervisors verify these before they appear on reports.

## Step 6: Verify it worked

1. Go back to the dashboard.
2. The exam progress counter should update.
3. The student's parent can now see this score in their portal.

## What you built

You've completed the core admin loop: set up academic structure → assign teachers → enter exams → parents see results. Every other admin task builds on this foundation.

## Next steps

- [How to set up academic year and terms](../how-tos/setup-academic-year.md) — detailed configuration
- [How to enter and verify exam results](../how-tos/enter-exam-results.md) — the full exam workflow
- [How to generate student reports](../how-tos/generate-reports.md) — monthly, midterm, and final reports
