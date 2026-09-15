# Parent Portal — “This Week’s Learning” UX/UI Proposal

**Status:** Proposal only (no broad application changes)  
**Repository reviewed:** `viniliaice/schoolnnnnass` at `eb39772` + current branch  
**Review date:** 15 September 2026

## Executive recommendation

Add a dedicated parent route, `/parent/weekly-learning`, reached primarily from a prominent card near the top of the existing Parent Dashboard. Do **not** add another parent sidebar item initially. The screen should be a mobile-first day timeline containing compact subject cards; tapping a card reveals only parent-safe lesson details.

Reuse the existing `lesson_plans`, `lesson_plan_periods`, `students`, `subjects`, academic-year/week utilities, parent/student relationship, dashboard visual language, and Supabase client. Do not duplicate lesson plans.

Before exposing data, add a parent-safe database/API boundary. The current lesson-plan RLS is not suitable for parents and its original `admin_all_*` policies use `USING (true)`, which should be treated as a security blocker and independently remediated. A parent-facing RPC should return an allowlisted projection only when:

1. the authenticated profile is a parent;
2. the requested student belongs to that parent;
3. the period/plan class matches that student’s effective class; and
4. the plan is explicitly parent-visible.

There are two product/schema mismatches to resolve before implementation:

- **School week mismatch:** the request says Monday–Thursday, but the application and PostgreSQL enum define **Saturday–Wednesday** (`DAYS_OF_WEEK`, `day_of_week`) and week ranges are five teaching days. The UI must follow the configured MBK teaching week rather than hard-code Monday–Thursday. If MBK has changed schedules, that requires a deliberate two-step enum/config migration and updates to existing week utilities.
- **Approval is not publication:** `lesson_plans.status = 'approved'` exists, but there is no separate “published to parents” state. Approval may safely act as publication for an MVP only if school policy confirms that every approved plan is immediately parent-visible. Otherwise add explicit publication fields.

---

## 1. Existing-system investigation

### Lesson-plan storage and ownership

- `lesson_plans` stores one plan row per teacher/week/class (the migration comment says per subject, although the UI can also carry subject per period).
- Key fields: `teacher_id`, `subject_id`, `class_name`, `week_label`, `title`, `status`, `period_count` plus internal review metadata.
- `teacher_id` references `profiles(id)`. Teacher UI fetches own plans by this field.
- `lesson_plan_periods` stores scheduled entries by `plan_id`, `day`, and `period_number`.
- Parent-usable period fields already exist: `subject`, `topic`, `objective`, `activities`, `details`, `class_name`, and `is_free`.
- `details` is an array of `{ activity, time, resource, place }`; it can supply a concise learning summary and optional resources after sanitization.
- Plans are associated with classes through `lesson_plans.class_name`; periods also have `class_name`. There is no class ID foreign key. This string-based join is reusable but fragile.

### Week identity

- Canonical labels look like `2026-W07` and are stored in `lesson_plans.week_label`.
- The week number is anchored to `academic_years.startDate`, not ISO calendar-week start.
- `src/utils/weekDates.ts` already computes current week labels and display ranges.
- `src/lib/lessonPlanWeeks.ts` already normalizes legacy labels for supervisor views.
- Current teaching days are Saturday, Sunday, Monday, Tuesday, Wednesday.

### Approval/publication

- Workflow statuses are `draft`, `submitted`, `in_review`, `approved`, `rejected`, `ai_failed`, and `revision_requested`.
- Supervisor/admin actions set `approved` or `rejected`.
- No `published_at`, `is_parent_visible`, or equivalent field exists.
- Parents must never receive any non-approved/non-published row, nor infer that such a row exists.

### Homework

- `homework` is a separate, student-specific table with `studentId`, `className`, `subject`, `title`, `description`, `dueDate`, and status.
- Parents already receive homework for their own children through existing RLS and `getParentPortalSnapshot`.
- There is **no explicit relationship** between a homework record and a lesson plan or period. Matching class/subject/date heuristically can produce incorrect associations and is not recommended as an authoritative link.

### Parent/student/class relationship

- `students.parentId` links each child to a parent profile; `students.className` supplies the current class.
- Existing parent RLS limits student reads to `parentId = current_profile_id()`.
- `getParentPortalSnapshot(parentId)` already loads all children and parent-scoped attendance/homework/results.
- Historical enrollments and `class_for_term(...)` exist elsewhere in the schema. For historical weekly navigation, the API should use the child’s effective class for that week/term, not blindly use today’s `students.className`, otherwise a promoted child could see the wrong historical plan.

### Parent dashboard and navigation

- Parent dashboard uses white rounded cards (`rounded-2xl`, slate borders) and a violet role accent.
- Existing parent sidebar is already long. The requested feature fits naturally as a dashboard destination.
- Routing is currently a centralized path switch rather than nested React Router routes.

---

## 2. Proposed weekly-learning screen

### Information hierarchy

1. Page title and week range
2. Selected child and class
3. Previous/current/next week controls
4. Today’s section (when viewing current week)
5. Remaining teaching days
6. Friendly unpublished/empty states

### Mobile wireframe (320–390 px)

```text
← Dashboard
This Week’s Learning
Week: 12 Sep – 16 Sep 2026

Select Child
[ Amina · Grade 5-A ▼ ]     (select if 2+ children)
Amina Hassan
Class: Grade 5-A

[← Previous] [This Week] [Next →]

TODAY · TUESDAY 15 SEP
┌ English ─────────────────────────┐
│ Reading for meaning              │  topic
│ Identify the main idea…          │  short objective/learning
│ 🏠 Practice: Read pages 12–14     │  only when linked
│                              ⌄   │
└──────────────────────────────────┘

┌ Mathematics ─────────────────────┐
│ Equivalent fractions             │
│ Compare fractions using models   │
│ No homework                      │
│                              ⌄   │
└──────────────────────────────────┘

WEDNESDAY · 16 SEP
  Lesson information is not available yet.
```

Single-child families do not see a redundant selector; they see only name and class. Multi-child families get a native/select-style full-width control at 320 px, or horizontal child chips if all labels fit without truncating identity.

### Expanded lesson card

Expansion is inline and exclusive per day by default (opening another card closes the previous card) to reduce scrolling:

```text
English
Topic                         Reading for meaning
Learning objective            Identify the main idea and two details.
What we are learning          Reading a short passage and discussing clues.
Homework / practice           Read pages 12–14 by Wednesday.
Resources                     Student book · Vocabulary sheet
                              [Open resource]
[Show less]
```

Rules:

- Collapsed card shows subject, topic, one short learning line, and homework indicator.
- Expanded content uses plain labels, not teacher-plan terminology.
- Never show the full plan, period number unless parents need timetable context, teacher identity, review notes, scores, or workflow badges.
- A subject receives one consistent, subtle accent (left border/icon tint) sourced from `subjects.color`; use a stable accessible fallback palette. Color is supplementary, never the only identifier.
- Entire card header is a minimum 44 px tap target and uses a real button with `aria-expanded`/`aria-controls`.
- Truncate collapsed learning text to roughly two lines; never truncate expanded content.

### Day states

Distinguish these without exposing workflow:

- **Published lessons:** render lesson cards.
- **No scheduled lessons:** “No lessons are scheduled for this day.” Use only if the backend can authoritatively know the day has no lessons.
- **No parent-visible information:** “Lesson information for this day is not available yet.” This covers absent, draft, rejected, or private data without revealing which.
- **Whole week empty:** “Lesson plans for this week are not available yet.” This is a calm informational card, not an error alert.
- **Network failure:** separate retry state: “We couldn’t load this week’s learning. Try again.” Do not confuse it with unpublished content.
- **Missing homework:** show “No homework” only where an explicit link or explicit no-homework value establishes that fact. Until then use “Homework: Not provided” or omit the row; never infer no homework from a failed/missing query.
- **Free period:** omit it from the parent feed rather than showing internal `is_free` rows.

---

## 3. Dashboard entry point

Place the card **after the welcome heading and before Family ID, releases, announcements, and statistics**, because weekly learning is a high-frequency academic task and should be visible without scrolling.

```text
┌ 📚 This Week’s Learning ─────────────────────────┐
│ See what Amina is learning and what to do at home│
│ 5 Subjects · Saturday–Wednesday                  │
│                              View weekly lessons →│
└──────────────────────────────────────────────────┘
```

For multiple children, use the last selected child; otherwise the first child in deterministic name/ID order. The supporting line may read “Amina · 5 subjects · Saturday–Wednesday”. If counts have not loaded, display “Lessons, objectives and practice for this week” rather than a misleading zero. If no plans are published, display “Weekly lesson information is not available yet” while keeping the card navigable.

Do not add a sidebar item for the first release. Add one later only if analytics/support feedback shows dashboard discoverability is insufficient.

---

## 4. Responsive layouts

### Mobile (320, 360, 390 px)

- One column; 16 px page padding at 360/390, 12 px at 320.
- Full-width child selector and segmented week controls.
- Week controls use compact accessible labels; at 320 px they may use arrow icons plus “Previous”/“Next”, while accessible names retain “Previous week”/“Next week”.
- Day heading remains visible immediately above its cards; no horizontal timetable.
- Typography target: 24 px title, 16–18 px day/subject headings, 14 px body, 12 px metadata; body line-height at least 1.4.
- No fixed-width children, no horizontal overflow, no hover-only behavior.
- Today appears first only visually when appropriate? **Recommendation:** retain chronological order and auto-scroll/focus today after loading, with a prominent “Today” marker. This avoids confusing week order.
- Collapsed-by-default cards keep the initial screen scannable.

### Tablet/desktop

Use the same mental model rather than switching to a table:

```text
[Title + range]                         [Child selector]
[Previous Week] [This Week] [Next Week]

[Today / Saturday — cards in 2 columns]
[Sunday — cards in 2 columns]
[Monday — cards in 2 columns]
...
```

- Content max width about 1100–1200 px, aligned to the existing dashboard shell.
- Day sections span full width; lesson cards use a two-column grid from `md` upward.
- Expanded cards may span their grid column; avoid modal dialogs so browser back, keyboard use, and mobile reading remain simple.
- Do not introduce a dense five-day timetable.

---

## 5. Data displayed and transformation rules

### Parent-safe output

| UI field | Existing source | Rule |
|---|---|---|
| Student name | `students.name` | Requested child must belong to current parent |
| Class | effective enrollment class; fallback `students.className` | Prefer class valid for selected week |
| Week range | `week_label` + academic-year start | Reuse `weekDates.ts`; do not derive from free-text title |
| Day/date | `lesson_plan_periods.day` + calculated dates | Follow configured teaching days |
| Subject | period `subject`, fallback joined `subjects.name` | Normalize empty values |
| Topic | period `topic` | Plain text; short collapsed display |
| Learning objective | period `objective` | Expanded view |
| What we are learning | period `activities` or safe summary of `details[].activity` | Do not use AI review summaries |
| Homework/practice | explicitly linked `homework` | Show title, concise description, due date where useful |
| Resources | `details[].resource` and safe `place` URL | Only non-empty; sanitize/allowlist URL schemes |

Period `activities` may be legacy free text while `details` is structured. Prefer joined non-empty `details[].activity`; fall back to `activities`. Preserve teacher-authored text and use deterministic truncation—do not generate an AI parent summary in the initial implementation.

If multiple approved plans produce the same class/day/subject/period, the backend needs a deterministic conflict rule and should log the data-quality issue. Recommended rule: use the latest `updated_at` approved/published row for that exact slot; do not show duplicates to parents.

### Never return to the parent client

- `teacher_id`, teacher profile/name, supervisor identity
- plan `status` values or internal status labels
- `previous_score`, `previous_reviewed_at`
- `ai_started_at`, `ai_failure_reason`
- revision notes/timestamps
- AI reviews, period AI reviews, scores, strengths/improvements
- supervisor comments, approval/rejection details
- review logs, generated-quiz provenance, submission tracking
- private/admin-only attachments
- raw plan row or full teacher lesson-plan document/PDF
- class data for any child not owned by the authenticated parent
- evidence/counts that draft/rejected/private plans exist

The API response should expose `available: boolean` or simply an empty lesson list, not internal status.

---

## 6. User flows

### One child

1. Parent opens dashboard.
2. “This Week’s Learning” card summarizes the only child’s current published week.
3. Parent taps the card.
4. Current week opens by default; today is marked and brought into view.
5. Parent scans topic/objective/homework, taps a lesson for details.
6. Parent moves to previous/next week or returns to “This Week”.

### Multiple children

1. Dashboard card uses the last-selected child (persist child ID locally; server still authorizes every request).
2. Parent opens weekly learning.
3. Child selector lists only their own active children with name and class.
4. Selecting a child clears stale lesson content, shows a skeleton, and requests that child’s effective class/week.
5. Week remains selected where practical; all counts, lessons, empty states, and homework refresh atomically.
6. Deep link may use `?student=<id>&week=<label>`, but the backend must distrust both parameters and re-authorize them.

If a child has no effective class for a historical/future week, show “Learning information is not available for this week,” not another class’s data.

---

## 7. Database/API changes actually required

### Required: secure parent read boundary

Prefer one `SECURITY DEFINER`, `STABLE` RPC such as:

```sql
get_parent_weekly_learning(p_student_id text, p_week_label text)
```

It should:

- derive actor identity from `auth.uid()` / `current_profile_id()`; never accept `parentId`;
- verify caller role is `parent`;
- verify `students.id = p_student_id AND students.parentId = actor`;
- resolve the student’s effective class for the selected week/term;
- filter plans to exact normalized week, effective class, and parent-visible state;
- omit `is_free` periods;
- return a fixed allowlist of fields, ideally JSON grouped by day;
- run with a pinned `search_path` and schema-qualified references;
- grant execute only to `authenticated`, revoke from `PUBLIC`/`anon`;
- expose no plan existence/status distinction when no rows qualify.

A database view alone is less attractive because safe parameterized student/week checks and historical class resolution are easier to centralize in an RPC. Direct parent SELECT policies can work, but would make raw internal columns queryable from the browser; the allowlisted RPC is safer.

### Required: explicit publication decision

Choose one:

**MVP policy (no column):** `status = 'approved'` means immediately published to parents. Document this as a school-wide contract.

**Recommended durable model:** add to `lesson_plans`:

```sql
parent_visible boolean not null default false,
published_at timestamptz,
published_by text references profiles(id)
```

Only authorized supervisor/admin functions may publish/unpublish, and `parent_visible` is valid only for approved plans. Parent output still must not return these fields. If approval must always publish, set these atomically in the approval RPC rather than adding another workflow step.

### Homework relationship

For correct per-lesson homework, add a nullable relationship rather than duplicate content:

```sql
alter table homework
  add column lesson_plan_period_id text null
  references lesson_plan_periods(id) on delete set null;
```

Teachers/admins can attach existing homework creation to a period. Keep homework itself in the existing table. Index the FK. The parent RPC should include a homework item only when both the homework row is parent-readable for the selected child and its period belongs to the selected published plan.

If schema change is deferred, show the existing child homework in a separate “Practice at home” week section filtered by due date, but do **not** claim it belongs to a specific lesson.

### Optional robustness changes

- Replace string class association with a stable class/enrollment ID over time; retain names for display. This is a broader migration, not necessary for the first screen if effective-class matching is reliable.
- Add a normalized/explicit `week_start_date` eventually. Current labels plus academic-year start are reusable, but legacy labels and academic-year assumptions add complexity.
- Add data-quality constraints preventing multiple current parent-visible plans for the same class/week/slot.
- Make teaching days configurable if MBK schedules vary by campus/year. Do not hard-code the request’s Monday–Thursday dates over the current Saturday–Wednesday model.

---

## 8. Security and RLS considerations

### Current blocker

The initial lesson-plan migration creates `admin_all_plans` and `admin_all_periods` with `USING (true)` and no role predicate. PostgreSQL permissive policies are OR-combined, so this can make enabled RLS ineffective for authenticated users depending on grants. No later migration found in this review replaces those two policies. Before parent launch:

- replace broad policies with explicit `current_user_role() IN ('admin', ...)` predicates and proper `WITH CHECK` clauses;
- verify table grants; RLS is not a substitute for least-privilege grants;
- add automated tests for parent A vs parent B, all workflow states, role spoofing, direct REST table access, historical class changes, and malformed week labels;
- ensure the parent RPC cannot be used to enumerate student IDs, classes, plan IDs, or unpublished counts;
- do not rely on client filters (`.eq('status','approved')`, class name, or parent ID) for authorization;
- avoid exposing raw resource URLs without rejecting `javascript:`, `data:`, and unsafe schemes. Prefer `https` and approved storage URLs;
- treat teacher-entered text as untrusted content and render it as text, never HTML;
- keep service-role keys out of browser code;
- do not subscribe parents to unfiltered `lesson_plans` realtime changes. Re-fetch through the scoped RPC after a safe notification, or omit realtime for MVP.

### Minimum RLS test matrix

| Scenario | Expected |
|---|---|
| Parent requests own child, published plan, matching class/week | Safe lesson projection |
| Parent requests sibling linked to same parent | Safe projection |
| Parent requests another family’s student ID | Empty/forbidden, no metadata |
| Own child, draft/submitted/rejected/revision/AI-failed plan | Empty; no status leakage |
| Own child changed class after selected historical week | Historical effective class only |
| Matching class name but child not owned | No rows |
| Parent queries raw lesson tables | Denied (preferred) or strictly safe RLS only |
| Teacher/supervisor invokes parent RPC | Denied unless product explicitly permits impersonation |

---

## 9. Reuse versus rebuild

### Reuse

- `lesson_plans` and `lesson_plan_periods` as the source of truth
- `students.parentId` and student records for the child selector
- enrollment/class-history helpers for historical weeks
- `subjects.name/color` for labels and subtle accents
- `weekDates.ts` for current-week calculation and range formatting
- selected patterns from `lessonPlanWeeks.ts` for legacy-label normalization
- existing parent Dashboard card styling, violet accent, layout shell, icons, and loading skeletons
- existing `homework` table and parent-scoped access
- existing central path navigation (add one parent case rather than introduce a second routing architecture)

### Do not reuse directly in parent UI

- `PlanReadView` and lesson-plan PDF: they are staff-oriented and expose too much detail
- supervisor hooks/queries: they include teacher and workflow information
- AI review data or generated summaries
- raw `fetchPlanById` response

A small parent-specific presentation model/component is warranted even though the underlying data is reused.

---

## 10. Recommended implementation plan

### Phase 0 — confirm policy (product/security)

1. Confirm the actual teaching week (current system: Saturday–Wednesday; request example: Monday–Thursday).
2. Decide whether approval automatically means parent publication.
3. Decide whether historical views use class-at-week (recommended).
4. Define max parent-facing text lengths and resource URL policy.

### Phase 1 — security and data contract

1. Remediate broad lesson-plan RLS policies and audit grants.
2. Add publication fields or formalize approved-as-published.
3. Implement the parent-safe RPC with explicit projection.
4. Add homework-period FK if lesson-specific homework is required in v1.
5. Add database tests covering cross-family and unpublished-state leakage.

### Phase 2 — data access and deterministic helpers

1. Add `src/lib/db/parentWeeklyLearning.ts` with typed RPC mapping.
2. Reuse/refactor current-week helpers without changing staff behavior.
3. Add pure functions for day grouping, subject fallback, activity/resource summarization, and empty-state classification.
4. Unit-test legacy week labels, duplicate slots, missing fields, promotion history, and no-homework semantics.

### Phase 3 — UI

1. Add `/parent/weekly-learning` to the parent route switch.
2. Build `ParentWeeklyLearning` with child selector, week navigation, day sections, and accessible expandable cards.
3. Add dashboard entry card near the top; pass/use the application’s existing `navigate` pattern.
4. Keep sidebar unchanged.
5. Add loading skeleton, calm empty state, and distinct retry state.

### Phase 4 — responsive/accessibility QA

- Verify 320, 360, 390, tablet, and desktop widths.
- Keyboard and screen-reader test expansion, child selection, and week controls.
- Test long names, long class names, Somali/English text expansion, RTL readiness if applicable, no homework/resources, and slow networks.
- Confirm no horizontal overflow and 44 px touch targets.

### Phase 5 — release

1. Backfill publication only for plans the school explicitly approves for parent release; do not bulk-publish historical approvals without review.
2. Roll out behind a parent-portal feature flag if available.
3. Monitor RPC errors and aggregate usage without logging lesson content or child-sensitive data.
4. Gather parent feedback on whether dashboard-only discovery is sufficient before considering a sidebar item.

---

## Acceptance criteria

A release is ready when a parent can, within a few seconds:

- identify the selected child and class;
- identify today and this week’s topics/objectives;
- identify explicitly connected homework/practice;
- switch children without stale or mixed data;
- navigate weeks and return to the current week;
- understand calmly when information is not yet available;
- do all of the above at 320 px without horizontal scrolling;
- and cannot access another family’s, unpublished, staff-review, or AI data through UI, RPC, direct REST, URL manipulation, or realtime channels.
