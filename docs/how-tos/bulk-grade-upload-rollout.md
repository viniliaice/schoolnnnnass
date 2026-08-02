# Roll out the secure Bulk Upload Grades flow

The secure workbook flow is introduced by migration
`20260802_bulk_grade_integrity.sql`. Deploy the migration **before** deploying
frontend code that calls `submit_bulk_grades`.

## Pre-deployment checks

1. Back up the `exams` table.
2. Confirm that `profiles.auth_id` maps every active account to a profile.
3. Confirm every active class/subject has exactly one `class_subjects.teacherId`
   assignment. Bulk uploads intentionally fail when the assigned teacher cannot
   be derived.
4. Run the non-destructive duplicate review view:

   ```sql
   select * from public.exam_historical_duplicate_candidates
   order by record_count desc;
   ```

   The migration deliberately leaves historical `assessmentLabel` values null.
   It does not delete, merge, or auto-label old Homework/Classwork rows.
   Review ambiguous historical duplicates manually before later backfilling
   assessment labels or enforcing uniqueness on historical rows.

## Template contract

New workbooks require `Student ID` and `Student Name`, followed by one or more
complete 11-column subject blocks:

| Slot | Header | Maximum | Stored exam type |
|---|---|---:|---|
| HW1–HW4 | `HW1 5` … `HW4 5` | 5 | Homework |
| CPW1–CPW4 | `CPW1 15` … `CPW4 15` | 15 | Classwork |
| Attendance | `Att 20` | 20 | Attendance |
| Monthly test | `MT 20` | 20 | Quiz |
| Akhlaaq | `Akhlaaq 10` | 10 | Discipline |

Akhlaaq is stored **per subject**. It remains a separate reported metric and
is not included in academic CA averages.

- Numeric `0` is a real scored zero.
- Blank or `-` creates no record.
- `Absent` creates an explicit `absent` record with no score.
- `N/A` creates an explicit `not_applicable` record with no score.
- Scores above the stated maximum, decimals, negatives, and malformed numbers
  are rejected; they are never clamped.
- A wholly blank subject block is treated as incomplete and blocks submission.

## Deployment verification

Use a staging teacher and an assigned class/subject to verify:

1. A valid sheet previews without writing rows.
2. A sheet with `Akhlaaq = 11` is rejected with the correct cell reference.
3. An unassigned subject or another class's student is rejected by the RPC.
4. The first confirmation creates grades; submitting the same assessment slots
   again shows an update count and, after confirmation, updates rather than
   duplicates the records.
5. An absent/N/A record displays as excluded and does not affect academic
   averages.
