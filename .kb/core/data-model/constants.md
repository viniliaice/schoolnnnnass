---
type: Configuration
title: App Constants
description: "Global constants used across the app: EXAM_TYPES, CA_TYPES, MONTHS, CLASSES, SUBJECTS, DEPARTMENTS, DAYS_OF_WEEK, PERFORMANCE_LEVELS."
tags: [core, configuration, constants]
timestamp: 2026-07-27T00:00:00Z
---

EXAM_TYPES: ['CA','Homework','Classwork','Quiz','Midterm','Final','Attendance'] — 7 exam type categories.
CA_TYPES: ['CA','Homework','Classwork','Quiz','Attendance'] — 5 types counted as continuous assessment.
MONTHS: ['September','October','November','December','January','February','March','April','May','June','July','August'] — 12-month academic calendar.
CLASSES: Foundation (A,D,B,C), KG (A,E), Grade 1-A through 12-C, Year 12 (A,C) — full class roster.
SUBJECTS: Mathematics, English, Science, Somali, Islamic Studies, Social Studies, Physics, Chemistry, Biology, History, Geography, Arabic — 12 subjects.
DEPARTMENTS: 6 academic departments for subject grouping.
PERFORMANCE_LEVELS: 5 levels with min scores and colors (from 0-100%).
Defined in src/types/index.ts.

## Related

* [Subjects](subjects.md) — SUBJECTS constant enumerates subject names.
* [ReportConfig](report-config-type.md) — CA_TYPES constant informs report config defaults.
