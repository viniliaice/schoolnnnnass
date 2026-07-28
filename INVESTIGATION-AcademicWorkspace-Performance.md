# 🔬 AcademicWorkspace — Full Performance Investigation

**Date:** 2026-07-28
**Branch:** `arena/019faa1b-schoolnnnnass`
**Status:** P0 fixes applied; this report covers current state + remaining issues

---

## Executive Summary

| Category | Original | Current | Status |
|----------|----------|---------|--------|
| Comparisons per render (main view) | 331,776 | 576 | ✅ **Fixed (575×)** |
| Users fetched from DB | 30,000 | ~50 | ✅ **Fixed (600×)** |
| PDF evaluations per render | every render | 0 (lazy) | ✅ **Fixed** |
| Summary useMemo | O(C×M) = 27,648 | O(M) = 576 | ✅ **Fixed (48×)** |
| N+1 query bomb (ManageStudents) | 20+ requests | 1 request | ✅ **Fixed** |
| Data fetch resilience | full crash | partial load + retry | ✅ **Fixed** |
| React.memo on child components | 0 | 0 | 🔴 **Open** |
| Inline arrow functions | 68 | 76 | 🔴 **Open (grew)** |
| useEffect wrong dependency | addSubjectId | addSubjectId | 🔴 **Open** |
| WorkloadAnalytics duplicate compute | yes | yes | 🔴 **Open** |
| WorkloadAnalytics heatmap O(C×M) | yes | yes | 🟡 **Open (scoped)** |
| renderSlideOver inside render | yes | yes | 🟡 **Open (low cost)** |
| CurriculumPdfDocument un-memoized | yes | yes | 🟡 **Open (lazy)** |

---

## ✅ FIXED Issues (What We Already Solved)

### Fix #1: Lazy-load PDF export (P0 #1)
**File:** `AcademicWorkspace.tsx` (line ~185, ~1215)
**What:** Added `showPdfExport` state gate. `<PDFDownloadLink>` + `<CurriculumPdfDocument>` only mounts when user clicks "Export PDF".
**Impact:** Eliminated 292KB PDF engine evaluation on every keystroke/click.

### Fix #2: O(1) mapping lookup (P0 #3)
**File:** `AcademicWorkspace.tsx` (line ~221) + `WorkloadAnalytics.tsx` (line ~22)
**What:** Added `mappingLookup` Map keyed by `className::subjectId`. MatrixView uses `.get()` instead of `.find()`.
**Impact:** MatrixView: 331,776 → 576 comparisons per render (575× faster).

### Fix #3: Lightweight teacher fetch (P0 #4)
**File:** `useAcademicWorkspaceData.ts` + `profiles.ts`
**What:** New `getAllTeachers()` function uses simple `.eq('role','teacher')` instead of `getUsers()` which fetched up to 30,000 profiles.
**Impact:** ~600× less data transferred and processed.

### Fix #4: O(M) summary computation (P0 #5)
**File:** `AcademicWorkspace.tsx` (line ~230)
**What:** Added `configuredClassSet` useMemo (O(M) single-pass Set). Summary now uses `configuredClassSet.size` + single-pass counting loop instead of `CLASSES.filter(mappings.some())`.
**Impact:** 27,648 → 576 iterations (48× faster).

### Fix #5: N+1 query bomb in ManageStudents
**File:** `ManageStudents.tsx` (line ~100, ~113)
**What:** Replaced `Promise.all(missingParentIds.map(id => getUserById(id)))` with single `getUsersByIds(missingParentIds)` call.
**Impact:** N HTTP requests → 1 HTTP request.

### Fix #6: Resilient data loading
**File:** `useAcademicWorkspaceData.ts`
**What:** Each query runs independently with `fetchWithRetry()` (2 retries, exponential backoff). Partial error banner shows what failed with a Retry button. Full-page error only if core data (subjects + mappings) both fail.
**Impact:** Connection resets no longer crash the entire workspace.

---

## 🔴 OPEN Issues (Still Needing Fixes)

### Issue 1: Zero `React.memo()` on child components

**Severity:** 🔴 High
**Location:** All 5 sub-components in `AcademicWorkspace.tsx` and `components/`

**Current state:**
```
SideSection        — re-renders on every state change
StructureRow       — re-renders on every state change (rendered 48× in sidebar)
ClassMultiSelect   — re-renders on every state change
MatrixView         — re-renders on every state change
WorkloadAnalytics  — re-renders on every state change
SummaryCard        — re-renders on every state change (rendered 6× in dashboard)
InfoPill           — re-renders on every state change
```

**Impact:** Every keystroke in the search box triggers reconciliation of ALL sidebar items (years, terms, subjects), ALL summary cards, and the entire main content area — even though most of this data hasn't changed.

**Fix:** Wrap stable children in `React.memo()` and stabilize their callback props with `useCallback()`.

**Estimated effort:** 45 min
**Expected improvement:** 50-70% reduction in DOM reconciliation on state changes.

---

### Issue 2: 76 inline arrow functions in JSX (grew from 68)

**Severity:** 🔴 High
**Location:** Throughout `AcademicWorkspace.tsx`

**Current state:**
```tsx
onClick={() => { setCopyFromClass(className); setSlideOver('bulk'); }}
onChange={event => setInlineTeacherForm(prev => ({ ...prev, name: event.target.value }))}
```

**Impact:** 
- 76 new closure allocations per render
- Prevents React from bailing out of child re-renders
- Increases GC pressure
- Grew from 68 → 76 because we added the teacher upload panel (8 new handlers)

**Fix:** Extract to `useCallback` for handlers passed to memoized components. At minimum, stabilize callbacks for items rendered in loops.

**Estimated effort:** 60 min
**Expected improvement:** Enables React.memo to be effective; reduces GC by ~90%.

---

### Issue 3: `useEffect` with unused dependency `addSubjectId`

**Severity:** 🟡 Medium
**Location:** `AcademicWorkspace.tsx` line 273

**Current state:**
```tsx
useEffect(() => {
  if (!bulkSubjectId && subjects[0]?.id) setBulkSubjectId(subjects[0].id);
  if (!bulkTeacherId && teachers[0]?.id) setBulkTeacherId(teachers[0].id);
  if (!replaceFromTeacherId && teachers[0]?.id) setReplaceFromTeacherId(teachers[0].id);
  if (!replaceToTeacherId && (teachers[1]?.id || teachers[0]?.id)) setReplaceToTeacherId(teachers[1]?.id || teachers[0].id);
}, [addSubjectId, bulkSubjectId, bulkTeacherId, replaceFromTeacherId, replaceToTeacherId, subjects, teachers]);
//  ^^^^^^^^^^^^^ NOT USED inside the effect body
```

**Impact:** Every time `addSubjectId` changes, the effect re-runs unnecessarily. Combined with `subjects` and `teachers` changing after every `refresh()`, this effect fires more often than needed.

**Fix:** Remove `addSubjectId` from the dependency array.

**Estimated effort:** 2 min

---

### Issue 4: `WorkloadAnalytics` duplicates `workloadByTeacher` computation

**Severity:** 🟡 Medium
**Location:** `WorkloadAnalytics.tsx` line 30 vs parent `AcademicWorkspace.tsx` line 227

**Current state:**
```tsx
// Parent already computes this:
const workloadByTeacher = useMemo(
  () => calculateTeacherWorkload(mappings, subjectMeta),
  [mappings, subjectMeta],
);

// But WorkloadAnalytics recomputes it independently:
const workloadByTeacher = useMemo(
  () => calculateTeacherWorkload(mappings, Object.fromEntries(subjects.map(s => [s.id, { weeklyLessons: s.weeklyLessons }]))),
  [mappings, subjects],
);
```

**Impact:** When the analytics panel is open, workload is computed twice per render.

**Fix:** Pass `workloadByTeacher` as a prop from the parent.

**Estimated effort:** 5 min

---

### Issue 5: `WorkloadAnalytics` heatmap still has O(C×M) patterns

**Severity:** 🟡 Medium (only when analytics panel is open)
**Location:** `WorkloadAnalytics.tsx` lines 40-48, 125

**Current state:**
```tsx
// classCoverage: iterates CLASSES × filters mappings per class
const classCoverage = useMemo(() => {
  return CLASSES.map(className => {
    const classMappings = mappings.filter(r => r.className === className);
    // ...
  });
}, [mappings, subjects]);

// Heatmap header: CLASSES.filter(mappings.some())
{CLASSES.filter(cn => mappings.some(r => r.className === cn)).map(cn => (
  <th>...</th>
))}
```

**Impact:**
- `classCoverage`: O(C × M) = 48 × 576 = 27,648 iterations
- Heatmap header: O(C × M) = 27,648 iterations
- Total: ~55,308 comparisons (only when analytics panel is visible)

**Fix:** Use `configuredClassSet` (already computed in parent) passed as prop, or build it inside the memo with a single-pass Set.

**Estimated effort:** 10 min

---

### Issue 6: `renderSlideOver()` defined inside render cycle

**Severity:** 🟡 Low (returns null most of the time)
**Location:** `AcademicWorkspace.tsx` line 716

**Current state:**
```tsx
const renderSlideOver = () => {
  if (!slideOver) return null;
  return (<div>...366 lines of JSX...</div>);
};
// Later:
{renderSlideOver()}
```

**Impact:** Function reference is recreated every render. When `slideOver` is null (most of the time), the cost is minimal — just one function call that returns null. The real cost would be if the JSX were always in the tree, but the early return prevents that.

**Why it's low priority:** The function body is guarded by `if (!slideOver) return null;`. React never processes the JSX subtree when no slide-over is open. The 366-line JSX tree is only materialized when the user actually opens a panel.

**Fix:** Either inline the JSX at the call site, or extract to a component outside the render cycle. Given the ~25 state variables it accesses, extraction requires a large props interface.

**Estimated effort:** 30 min
**Expected improvement:** Negligible when panel is closed; modest when open.

---

### Issue 7: `CurriculumPdfDocument` uses `new Map()` without memoization

**Severity:** 🟢 Very Low (only relevant when PDF export is active)
**Location:** `CurriculumPdfDocument.tsx` lines 55-56

**Current state:**
```tsx
const subjectsById = new Map(subjects.map(s => [s.id, s]));
const teachersById = new Map(teachers.map(t => [t.id, t]));
```

**Impact:** Creates 2 new Maps on every PDF document evaluation. However, since we lazy-loaded the PDF (Fix #1), this only runs when the user clicks "Export PDF".

**Fix:** Already lazy-loaded — no further action needed.

---

## 📊 Complete Before/After Comparison

| Metric | Original | After P0 Fixes | Remaining | Final Target |
|--------|----------|---------------|-----------|--------------|
| **Main view comparisons** | 331,776 | 576 | 576 | 576 ✅ |
| **Analytics comparisons** | 331,776 | 55,308 | 55,308 | ~600 |
| **Users fetched** | 30,000 | ~50 | ~50 | ~50 ✅ |
| **PDF evals per render** | 1 (always) | 0 (lazy) | 0 | 0 ✅ |
| **DB requests on load** | 6 parallel | 5 + 1 seq | same | same ✅ |
| **N+1 queries** | 20+ per page | 1 per page | 1 ✅ | 1 ✅ |
| **React.memo components** | 0 | 0 | 0 | 5+ |
| **Inline closures** | 68 | 76 | 76 | ~10 |
| **Summary iterations** | 27,648 | 576 | 576 ✅ | 576 ✅ |
| **Connection crash → full error** | yes | no | no ✅ | no ✅ |

---

## 🎯 Recommended Fix Order (Remaining)

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **1** | Fix useEffect wrong dependency | 2 min | Eliminates unnecessary effect runs |
| **2** | Pass `workloadByTeacher` to WorkloadAnalytics | 5 min | Eliminates duplicate computation |
| **3** | Fix WorkloadAnalytics O(C×M) with Set | 10 min | 55,308 → ~600 when analytics open |
| **4** | Add React.memo to SummaryCard + InfoPill | 15 min | Prevents dashboard card re-renders |
| **5** | Add React.memo to StructureRow + SideSection | 15 min | Prevents sidebar re-renders on search |
| **6** | Add React.memo to MatrixView | 10 min | Prevents matrix re-render on unrelated state |
| **7** | Stabilize loop-callbacks with useCallback | 30 min | Enables all React.memo to be effective |

**Total remaining effort: ~87 min**
**Expected cumulative improvement: 80-90% reduction in all render costs**

---

## Verification

```
✅ TypeScript typecheck: 0 errors
✅ Vite build: succeeds (3.44 MB)
✅ All 35 tests pass
✅ Git history: 4 commits on arena/019faa1b-schoolnnnnass
   - feat: teacher bulk upload
   - perf: P0 fixes (lazy PDF, O(1) lookup, getAllTeachers, O(M) summary)
   - fix: ERR_HTTP2_SERVER_REFUSED_STREAM (resilient loading)
   - fix: N+1 query bomb in ManageStudents
```
