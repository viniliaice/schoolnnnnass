# 🔬 AcademicWorkspace — Performance Analysis

**Date:** 2026-07-28
**File:** `src/pages/admin/academic-workspace/AcademicWorkspace.tsx` (1,431 lines)
**Bundle:** 3.44 MB total (gzip 1.31 MB) — single-file build

---

## 1. Component Complexity Overview

| Metric | Count | Verdict |
|--------|-------|---------|
| `useState` hooks | **26** | 🔴 Very high — each triggers re-render on change |
| `useMemo` hooks | **9** | 🟡 Good but insufficient relative to state count |
| `useCallback` hooks | **1** | 🔴 Only 1 of ~14 handler functions is memoized |
| `useEffect` hooks | **3** | 🟢 Acceptable |
| `.map()` iterations | **47** | 🔴 Extremely high — many nested |
| `.filter()` iterations | **33** | 🔴 Very high |
| `.find()` iterations | **4** in main + O(n²) in children | 🔴 Hidden O(n²) inside loops |
| `.some()` iterations | **5** | 🟡 Used inside other iterations |
| `onClick` handlers | **52** | 🔴 High DOM event surface |
| `onChange` handlers | **32** | 🔴 High reactivity surface |
| `<select>` elements | **9** | 🔴 Each re-renders all options on parent render |
| Inline arrow functions in JSX | **68** | 🔴 New closures every render |
| `React.memo` usage | **0** | 🔴 No child components are memoized |
| Helper sub-components | **5** (SideSection, StructureRow, ClassMultiSelect, MatrixView, WorkloadAnalytics) | 🔴 All re-render on every parent state change |

---

## 2. Critical Issues (P0 — Fix Now)

### 🔴 2.1 `renderSlideOver()` — Function Defined Inside Render Cycle

```tsx
const renderSlideOver = () => {
  if (!slideOver) return null;
  // ... hundreds of lines of JSX
};
```

**Problem:** This is a function that returns JSX, defined inside the component body. It's **recreated on every render** and when called, its entire subtree reconciles from scratch. React cannot diff it efficiently because it's not a component.

**Impact:** Every keystroke in the search box, every checkbox toggle, every teacher assignment change triggers full reconciliation of the slide-over panel (~200+ DOM nodes) even when it's closed (`null` return still requires React to process the call).

**Fix:** Convert to a proper component or inline the JSX directly.

```tsx
// Option A: Convert to component
function SlideOverPanel({ mode, ...props }) {
  if (!mode) return null;
  return <div>...</div>;
}
// Option B: Inline the JSX directly in the return statement
```

---

### 🔴 2.2 `PDFDownloadLink` + `<CurriculumPdfDocument>` — Evaluated on Every Render

```tsx
<PDFDownloadLink document={<CurriculumPdfDocument subjects={subjects} mappings={mappings} teachers={teachers} ... />} ...>
```

**Problem:** `<CurriculumPdfDocument>` is instantiated as JSX on **every render**. The `@react-pdf/renderer` library is **292 KB** and its `<Document>` component performs expensive layout computation. Even though the user never clicks "Export PDF", React still creates and reconciles this component tree on every state change.

Inside `CurriculumPdfDocument`:
- Creates `new Map()` twice (not memoized)
- Calls `calculateTeacherWorkload()` (iterates all mappings)
- Iterates all 48 CLASSES × mappings to build PDF table rows

**Impact:** Every checkbox click, every search keystroke triggers PDF document creation. This is **extremely expensive** and completely invisible to the user.

**Fix:** Lazy-load the PDF export. Only create the document when the user clicks "Export PDF":

```tsx
const [showPdfExport, setShowPdfExport] = useState(false);
// Only mount PDFDownloadLink when user clicks
<button onClick={() => setShowPdfExport(true)}>Export PDF</button>
{showPdfExport && (
  <PDFDownloadLink document={<CurriculumPdfDocument ... />} ...>
    ...
  </PDFDownloadLink>
)}
```

---

### 🔴 2.3 MatrixView — O(S × C × M) Nested Iterations

```tsx
// Inside MatrixView, for EVERY cell:
{classes.map(className => {
  const row = mappings.find(item => item.className === className && item.subjectId === subject.id);
  // ...renders <select> with ALL teachers
})}
```

**Problem:** This is the most dangerous code path. In the worst case:

| Scenario | Subjects | Classes | Mappings | `.find()` per cell | Total comparisons |
|----------|----------|---------|----------|--------------------|--------------------|
| Full school | 12 | 48 | 576 | 576 | **331,776** |
| Large school | 12 | 30 | 360 | 360 | **155,520** |
| Medium school | 8 | 20 | 160 | 160 | **25,600** |

Each `.find()` does a **linear scan** over all mappings. And each cell also renders a `<select>` with N teacher options.

**Impact:** Switching to matrix view with a fully configured school causes **~330K comparisons per render**. Any state change while in matrix view triggers this again.

**Fix:** Pre-compute a lookup map before rendering:

```tsx
const mappingLookup = useMemo(() => {
  const map = new Map<string, ClassSubject>();
  for (const m of mappings) {
    map.set(`${m.className}::${m.subjectId}`, m);
  }
  return map;
}, [mappings]);

// In render:
const row = mappingLookup.get(`${className}::${subject.id}`);
// O(1) instead of O(M)
```

---

### 🔴 2.4 `summary` useMemo — O(C × M) Complexity

```tsx
const summary = useMemo(() => {
  const configuredClasses = CLASSES.filter(className => mappings.some(row => row.className === className)).length;
  // ...
}, [mappings, subjects]);
```

**Problem:** `CLASSES.filter(className => mappings.some(...))` is **48 × 576 = 27,648** iterations in the worst case. This runs on every mappings change.

**Fix:**

```tsx
const configuredClasses = useMemo(() => {
  const set = new Set(mappings.map(m => m.className));
  return CLASSES.filter(cn => set.has(cn)).length;
}, [mappings]);
```

Or even simpler: pre-compute a Set of configured class names from mappings in a single O(M) pass.

---

### 🔴 2.5 `getUsers()` Fetches ALL Profiles (Up to 30,000)

```tsx
// useAcademicWorkspaceData.ts
const users = await getUsers(); // limit = 30,000!
setTeachers(users.filter(user => normalizeRole(user) === 'teacher'));
```

**Problem:** The hook fetches **all users** (parents, teachers, admins, supervisors — up to 30,000) just to filter down to teachers. A school with 2,000 parents and 50 teachers downloads and processes 2,050 user records.

**Fix:** Use the existing `getUsersByRole('teacher')` function instead:

```tsx
const teachers = await getUsersByRole('teacher');
```

---

### 🔴 2.6 Heatmap in WorkloadAnalytics — Same O(S × C × M) Problem

```tsx
{CLASSES.filter(c => mappings.some(r => r.className === c)).map(c => {
  const row = mappings.find(r => r.className === c && r.subjectId === subject.id);
  // ...
})}
```

Identical to the MatrixView problem. Runs inside the analytics slide-over. Same O(S × C × M) complexity.

**Fix:** Same lookup-map solution.

---

## 3. Significant Issues (P1 — Fix Soon)

### 🟡 3.1 No `React.memo` on Child Components

**Affected:** `SideSection`, `StructureRow`, `ClassMultiSelect`, `MatrixView`, `WorkloadAnalytics`, `SummaryCard`, `InfoPill`

**Problem:** Every time ANY of the 26 state variables changes (e.g., typing in the search box), ALL these sub-components re-render because:
1. None use `React.memo()`
2. Most receive inline arrow function props that change identity each render
3. Even the ones that receive stable data (like `StructureRow`) get new function references for `onEdit`/`onDelete`

**Impact:** Typing a character in the search box triggers re-renders of all `StructureRow` instances in the sidebar (all years, terms, subjects).

**Fix:** Wrap frequently-rendered children in `React.memo()` and memoize their callback props with `useCallback()`.

---

### 🟡 3.2 68 Inline Arrow Functions in JSX

```tsx
onClick={() => { setCopyFromClass(className); setSlideOver('bulk'); }}
onChange={event => setInlineTeacherForm(prev => ({ ...prev, name: event.target.value }))}
```

**Problem:** 68 arrow functions defined inside JSX attributes create **new function references on every render**. This:
1. Prevents React from bailing out of child re-renders
2. Increases garbage collection pressure
3. Allocates 68 closures per render even if they never execute

**Fix:** Extract to `useCallback` or move logic to named functions. At minimum, stabilize callbacks for components rendered in loops.

---

### 🟡 3.3 `useAcademicWorkspaceData` — 7 State Updates in Single `refresh()`

```tsx
setSubjects(subjectRows);
setYears(yearRows);
setTerms(termRows);
setMappings(mappingRows as MappingRow[]);
setTeachers(...);
setCurrentTerm(activeTerm);
setLoading(false);
```

**Problem:** React 18+ batches these in async contexts (good), but each `set*` call still triggers the hook's return value to change, which invalidates ALL dependent `useMemo` hooks downstream. The component receives **7 new reference values** simultaneously, triggering a cascade of recomputation.

**Impact:** After every `refresh()`, these memos all recompute:
- `subjectMeta` (iterates subjects)
- `subjectsById` (creates new Map)
- `teachersById` (creates new Map)
- `currentYear` (scans years)
- `filteredSubjects` (scans subjects)
- `filteredClasses` (scans CLASSES)
- `selectedClassMappings` (scans mappings)
- `workloadByTeacher` (iterates all mappings)
- `summary` (scans CLASSES × mappings)
- `warnings` (complex multi-pass algorithm)

That's **10 memos recomputing** after a single data refresh.

**Fix:** Use `useReducer` instead of 7 separate `useState` calls, or consolidate into a single data object:

```tsx
const [data, setData] = useState({ subjects: [], years: [], ... });
```

---

### 🟡 3.4 `useEffect` Dependency Mismatch

```tsx
useEffect(() => {
  if (!bulkSubjectId && subjects[0]?.id) setBulkSubjectId(subjects[0].id);
  // ...
}, [addSubjectId, bulkSubjectId, bulkTeacherId, replaceFromTeacherId, replaceToTeacherId, subjects, teachers]);
```

**Problem:** `addSubjectId` is in the dependency array but is never read inside the effect. This means any change to `addSubjectId` triggers a useless effect re-run. Additionally, `subjects` and `teachers` arrays are new references after every `refresh()`, causing this effect to run after every data load.

**Fix:** Remove `addSubjectId` from dependencies. Consider using `useRef` for the "has been initialized" pattern.

---

### 🟡 3.5 `WorkloadAnalytics` Duplicates Computation

```tsx
// WorkloadAnalytics.tsx — recomputes workload independently
const workloadByTeacher = useMemo(
  () => calculateTeacherWorkload(mappings, Object.fromEntries(subjects.map(s => [s.id, { weeklyLessons: s.weeklyLessons }]))),
  [mappings, subjects],
);
```

**Problem:** The parent `AcademicWorkspace` already computes `workloadByTeacher` via `useMemo`. But `WorkloadAnalytics` recomputes it independently with slightly different arguments. This means the workload calculation runs **twice** when analytics is visible.

**Fix:** Pass `workloadByTeacher` as a prop from the parent.

---

## 4. Moderate Issues (P2 — Fix When Possible)

### 🟠 4.1 `CLASSES` Array Has 48 Items — Hardcoded Constant

Every iteration over `CLASSES` processes 48 items. Many of these iterations happen inside `useMemo` hooks that re-run on every data change:

- `summary`: iterates 48 × mappings.some()
- `warnings.buildAcademicWarnings`: iterates 48 classes
- `WorkloadAnalytics.classCoverage`: iterates 48 classes
- `filteredClasses`: filters 48 items
- `ClassMultiSelect`: renders 48 checkboxes
- Class filter dropdown: renders 48 checkboxes

**Recommendation:** Consider whether all 48 classes are always relevant. A school might only use 15-20 classes at any given time. Add a "configured classes" filter or compute the active class list from data.

---

### 🟠 4.2 `@react-pdf/renderer` Adds ~292 KB to Bundle

The PDF export feature is always imported at the top level, meaning every user loads the PDF rendering engine even if they never export a PDF.

**Fix:** Dynamic import:
```tsx
const ExportPdfButton = lazy(() => import('./components/ExportPdfButton'));
```

---

### 🟠 4.3 Teacher `<select>` Elements Render All Teachers in Every Cell

In both cards view and matrix view, each subject card/cell renders a `<select>` with **all teachers as `<option>` elements**:

```tsx
<select>
  <option value="">Unassigned</option>
  {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
</select>
```

With 20 teachers × 576 mappings (worst case) = **11,520 `<option>` elements** in the DOM simultaneously.

**Impact:** Large DOM size, slower initial paint, more memory.

**Fix:** Consider an autocomplete/combobox component that only renders visible options.

---

### 🟠 4.4 `createAuditLog` Calls Are Fire-and-Forget Without Batching

Every action (create subject, update teacher, delete mapping, etc.) triggers an immediate `createAuditLog()` call, which is a separate Supabase INSERT. During bulk operations like `copyCurriculum()` or `replaceTeacherEverywhere()`, each item also fires an audit log.

**Impact:** In `replaceTeacherEverywhere`, if a teacher has 20 assignments, that's 20 update queries + 1 audit log = 21 sequential DB calls, followed by a `refresh()` = 27 total.

---

## 5. Data Flow Architecture Issues

### 🔴 5.1 Full Page Re-render Cascade on Teacher Assignment Change

When a user changes a teacher assignment via the `<select>` dropdown:

```
updateMappingTeacher()
  → await updateClassSubject() [DB]
  → setMappings() [local optimistic update]
  → addToast() [toast state change]
  → createAuditLog() [DB]
```

The `setMappings()` call triggers:
1. Component re-render
2. `selectedClassMappings` recomputes (O(M))
3. `workloadByTeacher` recomputes (O(M))
4. `summary` recomputes (O(C × M))
5. `warnings` recomputes (O(M + C × S))
6. `CurriculumPdfDocument` reconciles (O(C × M))
7. All 48 class filter buttons re-render
8. All sidebar items re-render
9. All subject chips re-render
10. All teacher `<select>` elements re-render

This cascade happens for **every single teacher assignment change**.

---

## 6. Quantified Impact Summary

| Metric | Current | Optimal | Ratio |
|--------|---------|---------|-------|
| Comparisons per render (matrix, full school) | **331,776** | 576 | 575× |
| Comparisons per render (heatmap) | **331,776** | 576 | 575× |
| `useState` triggers per render cycle | **26** | 1 (with useReducer) | 26× |
| Memos recomputed on data refresh | **10** | 3 (with consolidated state) | 3.3× |
| DOM `<option>` elements (full school) | **~11,520** | ~200 (virtualized) | 58× |
| Inline closures per render | **68** | ~5 | 14× |
| PDF doc evaluations per render | **1** (always) | 0 (lazy) | ∞ |
| Users fetched from DB | **up to 30,000** | ~50 (teachers only) | 600× |

---

## 7. Recommended Fix Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | Lazy-load PDF export | 10 min | Eliminates ~292 KB render cost per state change |
| **P0** | Convert `renderSlideOver` to component or inline | 15 min | Eliminates unnecessary subtree reconciliation |
| **P0** | Pre-compute mapping lookup Map (fix MatrixView + Heatmap) | 20 min | 575× fewer comparisons |
| **P0** | Use `getUsersByRole('teacher')` instead of `getUsers()` | 5 min | 600× less data fetched |
| **P1** | Add `React.memo()` to child components | 30 min | Prevents cascade re-renders |
| **P1** | Stabilize callbacks with `useCallback` | 45 min | Enables memo effectiveness |
| **P1** | Consolidate hook state (useReducer) | 30 min | Reduces re-render triggers |
| **P1** | Fix `summary` useMemo complexity | 10 min | O(C×M) → O(M) |
| **P1** | Pass `workloadByTeacher` to WorkloadAnalytics | 5 min | Eliminates duplicate computation |
| **P2** | Dynamic import for @react-pdf/renderer | 15 min | Reduces initial bundle |
| **P2** | Virtualize teacher selects | 60 min | Reduces DOM nodes |
| **P2** | Batch audit logs | 30 min | Reduces DB round trips |

---

## 8. Verdict

The AcademicWorkspace page has a **severe performance ceiling** at larger school sizes. The core problems are:

1. **Algorithmic complexity**: O(S × C × M) nested iterations where S=subjects, C=classes, M=mappings
2. **Missing memoization**: Only 1 of 14+ handlers uses `useCallback`; zero child components use `React.memo`
3. **Eager expensive rendering**: PDF document creation on every render
4. **Over-fetching**: Loading all 30,000 users to get 50 teachers
5. **State fragmentation**: 26 `useState` hooks trigger cascading recomputation

At current scale (small school: ~10 classes, ~8 subjects, ~10 teachers), performance is acceptable. At full scale (48 classes, 12 subjects, 50+ teachers, 500+ mappings), the page will exhibit visible jank on every interaction.

**Estimated fix time for P0 issues: ~50 minutes**
**Expected improvement: 95%+ reduction in per-render computation**
