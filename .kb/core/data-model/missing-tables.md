---
type: Database Table
title: Missing Tables — academic_years, terms, grade_scales, report_config
description: Four tables used by the app code but missing from all existing SQL files. Created by migration 20260727_create_missing_tables.sql.
tags: [core, schema, academic, grading]
timestamp: 2026-07-27T00:00:00Z
---

## academic_years

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Client-generated ID |
| name | TEXT | Year name (e.g. '2025-2026') |
| startDate | DATE | First day of the academic year |
| endDate | DATE | Last day of the academic year |
| isCurrent | BOOLEAN | Flag for current active year |
| createdAt | TIMESTAMPTZ | Row creation timestamp |

## terms

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Client-generated ID |
| name | TEXT | Term name (e.g. 'Term 1') |
| academicYearId | TEXT FK | References academic_years(id) ON DELETE CASCADE |
| startDate | DATE | Term start date |
| endDate | DATE | Term end date |
| isCurrent | BOOLEAN | Flag for current active term |
| months | TEXT[] | Months covered by this term |
| createdAt | TIMESTAMPTZ | Row creation timestamp |

## grade_scales

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Client-generated ID |
| minScore | INTEGER | Minimum score for this grade |
| maxScore | INTEGER | Maximum score for this grade |
| grade | TEXT | Letter grade (A, B, C, D, F) |
| remark | TEXT | Description (e.g. 'Excellent') |
| gpa | NUMERIC(3,1) | GPA value (optional) |

## report_config

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Single row with id='default' |
| caWeight | NUMERIC(5,2) | Continuous assessment weight (default 60) |
| midtermWeight | NUMERIC(5,2) | Midterm exam weight (default 20) |
| finalWeight | NUMERIC(5,2) | Final exam weight (default 20) |
| caTypes | TEXT[] | Exam types counted as CA (default: CA,Homework,Classwork,Quiz,Attendance) |
| updatedAt | TIMESTAMPTZ | Last update timestamp

## Related

* [AcademicYears](academic-years.md) — full schema definition for this table.
* [Terms](terms.md) — full schema definition for this table.
* [Grade Scales (Core)](grade-scales.md) — full schema definition for this table.
* [ReportConfig](report-config-type.md) — type definition for this table's config.
