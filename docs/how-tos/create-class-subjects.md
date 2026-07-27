# How to Create Class-Subject Assignments

Assign teachers to specific class-subject combinations so they can enter exam results and manage their classes.

## Prerequisites

- Admin role
- Existing teachers in the system
- Existing classes and subjects

## Steps

1. Click **Class Subjects** in the sidebar.
2. You'll see a table of existing assignments.
3. Click **Add Assignment**.
4. Select:
   - **Class:** e.g., "Grade 5-A"
   - **Subject:** e.g., "Mathematics"
   - **Teacher:** select from the dropdown of teachers with `assignedClasses` and `assignedSubjects` set
5. Click **Save**.

### Bulk assignments

To assign one teacher to multiple classes:

1. Go to **Users** in the sidebar.
2. Find the teacher and click **Edit**.
3. Under **Assigned Classes**, check all classes they teach.
4. Under **Assigned Subjects**, check all subjects they teach.
5. Click **Save**.

Then create class-subject assignments — the teacher will appear in the dropdown for their assigned classes.

### Remove an assignment

1. In **Class Subjects**, find the assignment.
2. Click the delete icon.
3. Confirm removal.

This doesn't delete the teacher or class — it just removes the teaching assignment.

## Verification

- The teacher's dashboard shows only their assigned classes.
- Teachers can only enter exam results for their assigned class-subject pairs.
- Supervisors see the assignment in the monitoring view.

## Troubleshooting

**Problem:** Teacher doesn't appear in the class-subject dropdown.
**Fix:** Check that the teacher's `assignedClasses` and `assignedSubjects` include the target class and subject.

**Problem:** Teacher can't see a class on their dashboard.
**Fix:** Create a class-subject assignment linking that teacher to the class.
