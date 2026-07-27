# How to Generate Student Reports

The system generates three types of reports: monthly, midterm, and final. Each aggregates exam data differently.

## Prerequisites

- Exam results entered and approved
- Academic year and terms configured
- Grade scales defined

## Monthly reports

Shows one month of exam data per subject.

1. Click **Monthly Report** (parent) or **Exam Reports** (admin/teacher).
2. Select the **Student** and **Month**.
3. The report shows per subject:
   - Each exam type score (CA, Homework, Classwork, Quiz, Attendance)
   - Average score for the month
   - Class average for comparison

### How monthly average is calculated

```
Monthly Average = Sum of all exam scores / Number of exams
```

Each exam type contributes equally to the monthly average.

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

```
Midterm Score = Average of monthly averages for the term
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

```
Final Score = (CA Average × CA Weight) + (Midterm × Midterm Weight) + (Final Exam × Final Weight)
```

Default weights: CA 30%, Midterm 30%, Final 40%.

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
