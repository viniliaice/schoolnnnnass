# How to Set Up Academic Year and Terms

Configure the academic calendar so exams, reports, and attendance are tied to the correct time period.

## Prerequisites

- Admin role
- Access to the Academic section

## Steps

### Create an academic year

1. Click **Academic** in the sidebar.
2. Click **Create Year**.
3. Fill in:
   - **Name:** e.g., "2025-2026"
   - **Start Date:** first day of the academic year
   - **End Date:** last day of the academic year
   - **Is Current:** toggle ON (only one year can be current)
4. Click **Save**.

### Create terms within the year

1. In the academic year view, click **Add Term**.
2. Fill in:
   - **Name:** e.g., "Term 1", "Term 2", "Term 3"
   - **Start Date:** first day of the term
   - **End Date:** last day of the term
   - **Is Current:** toggle ON for the active term
   - **Months:** select which calendar months this term covers (e.g., January, February, March)
3. Click **Save**.

### Configure grade scales

1. In the Academic section, find **Grade Scales**.
2. Define score ranges and letter grades:

| Min | Max | Grade | Remark | GPA |
|-----|-----|-------|--------|-----|
| 90 | 100 | A | Excellent | 4.0 |
| 80 | 89 | B | Very Good | 3.5 |
| 70 | 79 | C | Good | 3.0 |
| 60 | 69 | D | Pass | 2.5 |
| 0 | 59 | F | Fail | 0.0 |

3. Click **Save**.

### Configure report weights

1. Find **Report Config** in the Academic section.
2. Set the weights for final grade calculation:
   - **CA Weight:** e.g., 30% (continuous assessment average)
   - **Midterm Weight:** e.g., 30%
   - **Final Weight:** e.g., 40%
3. The weights must sum to 100.
4. Click **Save**.

## Verification

- The dashboard shows the current academic year and term.
- Teachers can only enter exams for the current term's months.
- Reports calculate using the configured weights.

## Troubleshooting

**Problem:** Teachers can't enter exams for a month.
**Fix:** Check that the month is included in the current term's month list.

**Problem:** Reports show wrong grades.
**Fix:** Verify the grade scale ranges are correct and non-overlapping.

**Problem:** Two academic years are marked current.
**Fix:** Only one year can be current — uncheck the old one first.
