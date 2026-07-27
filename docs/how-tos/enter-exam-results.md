# How to Enter and Verify Exam Results

The exam workflow has two stages: teachers enter results, then supervisors verify them. This guide covers both.

## Prerequisites

- Teacher or admin role (for entering)
- Supervisor role (for verifying)
- Active academic year and term
- Class-subject assignments configured

## Entering exam results (teacher)

1. Click **Results** in the sidebar.
2. Select from the filters:
   - **Class:** your assigned class
   - **Subject:** your assigned subject
   - **Month:** a month in the current term
   - **Exam Type:** CA, Homework, Classwork, Quiz, or Attendance
3. The student list loads for that class.
4. For each student:
   - Enter **Score** (e.g., 85)
   - Enter **Total** (e.g., 100)
   - Optionally add a **Comment**
5. Click **Save All**.

Results save with status `pending`.

### Exam types

| Type | Purpose | Required? |
|------|---------|-----------|
| CA | Continuous Assessment | Yes (one of CA or Homework+Classwork) |
| Homework | Take-home work | Yes (with Classwork) |
| Classwork | In-class exercises | Yes (with Homework) |
| Quiz | Quick tests | Yes |
| Attendance | Presence tracking | Visible but not required |
| Midterm | Mid-term exam | Optional |
| Final | End-of-term exam | Optional |

### Monthly entry rules

- **Quiz** is always required for every student
- **Coursework** is required — satisfied by either:
  - CA for every student, OR
  - Both Homework and Classwork for every student
- **Attendance** is visible but not required

## Verifying exam results (supervisor)

1. Click **Verifications** in the sidebar.
2. Review pending entries — grouped by teacher, class, subject, and month.
3. For each entry:
   - Check the number of students entered matches enrollment
   - Review score distributions for outliers
   - Verify correct exam type and month
4. Click **Approve** to publish to parent reports.
5. Click **Reject** with a reason if something is wrong.

Approved results appear in parent and student portals immediately.

## Verification

- Teachers see "pending" status on entered results until verified.
- Supervisors see completion percentages in the monitoring view.
- Parents see results only after supervisor approval.

## Troubleshooting

**Problem:** Teacher can't enter results for a month.
**Fix:** Check the month is included in the current term. Only current term months are available.

**Problem:** Results don't appear on parent reports.
**Fix:** A supervisor must approve the results first. Check the verification queue.

**Problem:** Wrong number of students shown.
**Fix:** Verify the class-subject assignment and student enrollment match.
