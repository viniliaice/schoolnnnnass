## 2026-07-27

Maintenance pass — validate + lint fixes across all 9 bundles:

**Validate fixes:**
- Stripped frontmatter from 9 nested `index.md` files (admin-tools, communications, core, exams, lesson-plans, parent-portal, quizzes, reports, teaching)
- Added YAML frontmatter to 4 role files (`admin-role.md`, `parent-role.md`, `supervisor-role.md`, `teacher-role.md`)
- Fixed broken cross-links in `admin-tools/data-model/student-promotions.md`

**Lint fixes:**
- Added 9 missing concept files to directory indexes (admin-dashboard, supervisor-dashboard, hooks×3, missing-tables, review-status, teacher-dashboard, teacher-students)
- Added 4 role files to root index.md
- Added `timestamp` field to all 103 concept files
- Disambiguated 6 duplicate title pairs (RLS Policies×9, get_system_stats×2, announcements×2, grade_scales×2, get_exam_status_counts×2, ParentQuizzes×2)

**Result:** ✓ conformant, 0 warnings, 61 info (floaters)

## 2026-07-27 (continued)

Cross-link pass — connected all 61 floating concepts into the graph:

**Core bundle (14 files):**
- Added `## Related` sections to profiles, students, subjects, academic-years, class-subjects, terms, grade-scales, constants, report-config-type, missing-tables, rls-policies, manage-users, manage-students, manage-academic, manage-class-subjects, manage-subjects, get-system-stats, hooks, progress-types, security-helpers

**Teaching bundle (8 files):**
- Added cross-links to attendance, homework, announcements data-models, rls-policies, attendance-functions, homework-functions, announcement-api, streams-api

**Admin-tools bundle (2 files):**
- Added cross-links to audit-functions, academic-workspace

**Communications bundle (6 files):**
- Added cross-links to message-functions, message-permissions, triggers, announcements, messages, rls-policies

**Exams bundle (10 files):**
- Added cross-links to all API functions, data-models, and rls-policies

**Lesson-plans, parent-portal, quizzes, reports (19 files):**
- Added cross-links to all remaining floating concepts

**Result:** ✓ healthy — no issues, 0 warn, 0 info
