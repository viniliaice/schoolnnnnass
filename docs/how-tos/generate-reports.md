# How to Generate Student Reports

The system generates three types of reports: monthly, midterm, and final. Each aggregates exam data differently.

## Prerequisites

- Exam results entered and approved
- Academic year and terms configured
- Grade scales defined

## Monthly reports

Shows one month of approved continuous-assessment data per subject.

1. Click **Monthly Report** (parent) or **Exam Reports** (admin/teacher).
2. Select the **Student** and **Month**.
3. The report shows per subject:
   - Each approved scored assessment in that month (CA, Homework, Classwork, Quiz, Attendance)
   - Average percentage for the month
   - Class average for comparison

`MT`/midterm entries are excluded from the monthly CA report even when they are stored as `examType='Quiz'` with `assessmentLabel='MT'`.

### How monthly average is calculated

Each assessment is first converted to a percentage, then those percentages are averaged:

```
Assessment Percentage = (score / total) × 100
Monthly Average = Average of the month's assessment percentages
```

Whole numbers and half-point scores are preserved through the percentage calculation.

## Midterm reports

Aggregates across multiple months in a term.

1. Click **Midterm Report**.
2. Select the **Student** and **Term**.
3. The report shows:
   - Per-subject scores across the term
   - Subject rank (position among classmates)
   - Class average per subject
   - Highest score in class
   - Overall rank among all students

### How midterm score is calculated

Midterm reports use approved scored midterm assessments for the term. This includes legacy rows stored with `examType='Midterm'` and bulk-uploaded `MT` rows stored as `examType='Quiz'` + `assessmentLabel='MT'`.

Each midterm assessment is converted to a percentage:

```
Midterm Percentage = (score / total) × 100
```

## Final reports

Combines CA, midterm, and final exam with configurable weights.

1. Click **Final Report**.
2. Select the **Student** and **Term**.
3. The report shows:
   - CA average (weighted)
   - Midterm score (weighted)
   - Final exam score (weighted)
   - Total final score
   - Letter grade (A-F)
   - Pass/Fail status
   - Teacher comment
   - Principal comment

### How final score is calculated

Each component is converted to a percentage first, then weighted using the active `report_config` row:

```
Final Score = (CA Average × CA Weight) + (Midterm × Midterm Weight) + (Final Exam × Final Weight)
```

The repo-shipped default configuration is currently CA 60%, Midterm 20%, Final 20%, but the report uses whatever weights are stored in `report_config`.

When `Quiz` is included in `report_config.caTypes`, `MT` rows are still excluded from the CA average and counted only as Midterm.

### Grade scale

| Score | Grade | Remark |
|-------|-------|--------|
| 90-100 | A | Excellent |
| 80-89 | B | Very Good |
| 70-79 | C | Good |
| 60-69 | D | Pass |
| 0-59 | F | Fail |

Passing threshold: 60.

## Verification

- Monthly reports update immediately when new exams are approved
- Midterm reports recalculate when any month in the term changes
- Final reports reflect the latest grade scale and weight configuration

## Troubleshooting

**Problem:** Report shows no data.
**Fix:** Check that exams exist for the selected student, month/term, and that they're approved (status = "approved").

**Problem:** Wrong grade on final report.
**Fix:** Verify the report config weights sum to 100 and the grade scale is correct.

**Problem:** Student rank seems wrong.
**Fix:** Rank is calculated across all students in the same class. Verify the student's `className` matches the class being compared.
