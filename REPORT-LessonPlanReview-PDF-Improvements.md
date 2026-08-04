# Report: Lesson Plan Review + PDF Export Improvements

## Summary

This report documents the latest Lesson Plan Review and PDF export changes added to PR #14.

PR branch: `arena/019fcd2e-schoolnnnnass`  
Latest implementation commit before this report: `2f313da Improve lesson plan PDF review and alignment`

The changes improve PDF reliability, PDF print layout, per-period instructional feedback, Unit Plan alignment visibility, daily planning summaries, and responsive Lesson Plan Review readability.

---

## 1. PDF Export Font Crash Fixed

### Problem

`@react-pdf/renderer` was throwing:

```text
Error: Unknown font format
```

The PDF document registered remote `.woff` fonts:

```ts
Font.register({
  family: 'Helvetica',
  fonts: [
    { src: 'https://fonts.cdnfonts.com/s/29107/HelveticaNeue.woff', fontWeight: 'normal' },
    { src: 'https://fonts.cdnfonts.com/s/29107/HelveticaNeueBd.woff', fontWeight: 'bold' },
  ],
});
```

React PDF is more reliable with built-in fonts or valid local `.ttf` files. Remote `.woff` files can fail depending on bundling/runtime behavior.

### Fix

Removed remote font registration and used React PDF's built-in Helvetica fallback.

```ts
// Do not register remote/browser fonts here. @react-pdf supports built-in
// Helvetica reliably in both dev and production; remote .woff files caused
// "Unknown font format" crashes in PDF export. If a custom font is added later,
// register a local .ttf only and keep this built-in fallback.
const FONT_FAMILY = 'Helvetica';
```

The page style now uses that safe built-in font:

```ts
page: {
  paddingTop: 74,
  paddingBottom: 54,
  paddingHorizontal: 34,
  fontFamily: FONT_FAMILY,
  fontSize: 10.5,
  color: INK,
  lineHeight: 1.45,
  backgroundColor: '#ffffff',
},
```

### Result

PDF generation no longer depends on unsupported remote font formats and should render reliably in both development and production.

---

## 2. Professional PDF Layout Redesign

### Improvements

The Lesson Plan PDF was redesigned to be more print-friendly and easier to read:

- Larger typography
- Better spacing and hierarchy
- Fixed header and footer
- Page numbers
- Better period cards
- Cleaner day sections
- Long content wraps naturally
- Period blocks avoid awkward splits where possible

### Header and Page Number Snippet

```tsx
<View fixed style={styles.fixedHeader}>
  <View>
    <Text style={styles.headerTitle}>MBK Lesson Plan Review</Text>
    <Text style={styles.headerMeta}>{plan.class_name} · {plan.week_label}</Text>
  </View>
  <Text
    style={styles.pageNumber}
    render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
  />
</View>
```

### Footer Snippet

```tsx
<View fixed style={styles.fixedFooter}>
  <Text>MBK International School</Text>
  <Text>{formatStatus(plan.status)}</Text>
</View>
```

### Period Block Snippet

```tsx
<View style={styles.periodCard} wrap={false}>
  <View style={styles.periodTop}>
    <Text style={styles.periodBadge}>P{period.period_number}</Text>
    <Text style={styles.periodTitle}>{isFree ? 'Free period' : period.topic || 'No topic entered'}</Text>
  </View>

  {!isFree && (
    <>
      <View style={styles.tagRow}>
        <Text style={styles.tag}>{period.subject || 'Subject —'}</Text>
        <Text style={styles.tag}>{period.class_name || 'Class —'}</Text>
        {period.slide_number && <Text style={styles.tag}>Page {period.slide_number}</Text>}
      </View>
      {period.objective && (
        <>
          <Text style={styles.label}>Objective</Text>
          <Text style={styles.body}>{period.objective}</Text>
        </>
      )}
    </>
  )}
</View>
```

---

## 3. Dashboard-Style Day Summary

### Requirement

Replace a simple summary like:

```text
Saturday
4 of 5 periods planned
```

with a dashboard header showing:

- Day name
- Planned periods
- Free periods
- Completion percentage
- Progress bar

### Shared Summary Helper

A reusable helper was added in `src/lib/lessonPlanReview.ts`:

```ts
export function summarizeDay(
  periods: Array<Pick<LessonPlanPeriod, 'is_free' | 'topic'>>,
  periodCount: number
): DayPlanningSummary {
  const free = periods.filter((period) => period?.is_free).length;
  const planned = periods.filter((period) => period && !period.is_free && (period.topic ?? '').trim()).length;
  const total = Math.max(periodCount, periods.length, 1);
  return { planned, free, total, percent: Math.round((planned / total) * 100) };
}
```

### Review Page UI Snippet

```tsx
<div className="mt-3 grid grid-cols-3 gap-2 text-center sm:max-w-md">
  <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">
    {summary.planned} planned
  </span>
  <span className="rounded-lg bg-white px-2 py-1 text-xs font-semibold text-slate-600 shadow-sm">
    {summary.free} free
  </span>
  <span className="rounded-lg bg-white px-2 py-1 text-xs font-bold text-indigo-700 shadow-sm">
    {summary.percent}% done
  </span>
</div>
<div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
  <div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${summary.percent}%` }} />
</div>
```

### PDF Snippet

```tsx
<View style={styles.dayHeader} wrap={false}>
  <View style={styles.dayTop}>
    <Text style={styles.dayName}>{day}</Text>
    <Text style={styles.dayPercent}>{summary.percent}% complete</Text>
  </View>
  <View style={styles.statRow}>
    <Text style={styles.statPill}>{summary.planned} planned</Text>
    <Text style={styles.statPill}>{summary.free} free</Text>
    <Text style={styles.statPill}>{summary.total} total periods</Text>
  </View>
  <View style={styles.progressTrack}>
    <View style={[styles.progressFill, { width: `${summary.percent}%` }]} />
  </View>
</View>
```

---

## 4. Per-Period AI Review

### Requirement

Every period now includes an AI Review section that:

- Uses a concise instructional-coach tone
- Evaluates objective clarity/measurability
- Checks whether activities support the objective
- Checks Unit Plan alignment
- Mentions gaps only when needed

### Shared Review Logic

Added `reviewPeriodInstruction` in `src/lib/lessonPlanReview.ts`:

```ts
export function reviewPeriodInstruction(period: LessonPlanPeriod, unitPlans: UnitPlan[] = []): PeriodInstructionalReview {
  if (period.is_free || period.subject === '__FREE__') {
    return {
      alignmentStatus: 'unknown',
      alignmentLabel: 'Free Period',
      alignmentReason: 'No instructional alignment is needed for a free period.',
      aiReview: 'This is marked as a free period, so no instructional coaching review is required.',
    };
  }

  const measurableObjective = objectiveIsMeasurable(period.objective);
  const supportedByActivities = activitiesSupportObjective(period);
  const matchedUnit = findMatchingUnitPlan(period, unitPlans);
  // ...alignment scoring continues
}
```

### Review Page Snippet

```tsx
{showAiReview && <AiReviewBox period={cell!} unitPlans={unitPlans} />}
```

### AI Review Box Snippet

```tsx
<div className={cn('mt-3 rounded-xl border p-3', tone)}>
  <div className="mb-1 flex flex-wrap items-center gap-2">
    <span className="text-xs font-bold uppercase tracking-wide">AI Review</span>
    <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-bold shadow-sm">
      {review.alignmentLabel}
    </span>
  </div>
  <p className="text-sm leading-6">{review.aiReview}</p>
  <p className="mt-1 text-xs leading-5 opacity-80">{review.alignmentReason}</p>
</div>
```

---

## 5. Unit Plan Alignment

### Matching Strategy

Lessons are matched to Unit Plans by:

1. Subject
2. Class / grade
3. Topic overlap against Unit Plan name and objectives

### Unit Matching Snippet

```ts
export function findMatchingUnitPlan(period: LessonPlanPeriod, unitPlans: UnitPlan[] = []): UnitPlan | undefined {
  const subject = (period.subject ?? '').trim();
  const className = (period.class_name ?? '').trim();
  const periodGrade = gradeKey(className);
  const topicWords = words(period.topic);

  const candidates = unitPlans.filter((unit) => {
    const subjectMatches = !subject || unit.subject_id === subject;
    const classMatches = !className || unit.class_name === className || gradeKey(unit.class_name) === periodGrade;
    return subjectMatches && classMatches;
  });

  if (!candidates.length) return undefined;

  return candidates
    .map((unit) => {
      const unitWords = words(`${unit.name} ${unit.objectives}`);
      return { unit, score: overlapCount(topicWords, unitWords) };
    })
    .sort((a, b) => b.score - a.score)[0]?.unit;
}
```

### Alignment Labels

The UI displays:

```text
✅ Fully Aligned
⚠️ Partially Aligned
❌ Not Aligned
```

For PDF compatibility, emoji are stripped in the PDF label to avoid font issues:

```ts
function pdfAlignmentLabel(label: string): string {
  return label.replace(/[✅⚠️❌]/g, '').trim();
}
```

---

## 6. Data Fetching and Performance

### Unit Plans

The Lesson Plan Review now fetches relevant Unit Plans once per class and uses React Query caching:

```ts
const { data: unitPlans = [] } = useUnitPlansByClass(plan?.class_name ?? null);
```

The class-based Unit Plan hook now has explicit cache timing:

```ts
return useQuery({
  queryKey: ['unitPlans', 'class', className],
  queryFn: () => {
    if (!className) return [];
    return unitPlansDb.fetchUnitPlansByClass(className);
  },
  enabled: !!className,
  staleTime: 1000 * 60 * 5,
  gcTime: 1000 * 60 * 15,
});
```

This preserves the previous duplicate-request fix for lesson plans and AI reviews. No polling was reintroduced.

---

## Files Changed

- `src/pages/shared/LessonPlanPdfDocument.tsx`
- `src/components/lesson-planner/PlanReadView.tsx`
- `src/lib/lessonPlanReview.ts`
- `src/lib/hooks/useUnitPlans.ts`
- `src/pages/supervisor/LessonPlanReview.tsx`
- `src/pages/teacher/SubmittedPlansView.tsx`

---

## Validation

The following commands passed after the implementation:

```bash
npm run typecheck
npm run test:ci -- lesson-plan
npm run build
```

---

## Expected User Impact

- PDF export should no longer crash due to unsupported font formats.
- Review PDFs are more professional and easier to print/read.
- Supervisors get per-period instructional feedback directly in the review page.
- Unit Plan alignment is visible for each period.
- Daily planning progress is clearer, especially for days such as Saturday.
- No duplicate AI review polling has been reintroduced.
