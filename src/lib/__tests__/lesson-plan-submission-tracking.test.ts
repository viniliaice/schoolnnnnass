import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_TRACKING_STATUSES,
  buildSubmissionRows,
  buildSubmissionWeeks,
  defaultSubmissionWeek,
  filterSubmissionRows,
  sortSubmissionRows,
  submissionClassLabel,
  submissionClassOptions,
  submissionStamp,
  summarizeSubmissions,
  type ExpectedSubmitter,
  type SubmissionTrackingPlan,
} from '../lessonPlanSubmissionTracking';

// Academic year starts Saturday 1 Aug 2026:
//   week 6 = 5 Sep – 9 Sep 2026
//   week 7 = 12 Sep – 16 Sep 2026   <- the "current" week in this fixture
const YEAR = { startDate: '2026-08-01', endDate: '2027-07-31' };
const TODAY = new Date('2026-09-12T10:00:00');

// ─── Weeks ────────────────────────────────────────────────────────────────

describe('buildSubmissionWeeks — the submission week selector', () => {
  it('generates every week of the academic year so far, most recent first', () => {
    const weeks = buildSubmissionWeeks([], YEAR, TODAY);
    expect(weeks.map((w) => w.label)).toEqual([
      'Week 2026-W07', 'Week 2026-W06', 'Week 2026-W05', 'Week 2026-W04',
      'Week 2026-W03', 'Week 2026-W02', 'Week 2026-W01',
    ]);
  });

  it('marks the week containing today as current and keeps weeks with zero submissions selectable', () => {
    const weeks = buildSubmissionWeeks(
      [{ week_label: '2026-W07', plan_count: 8 }],
      YEAR,
      TODAY
    );
    expect(weeks[0]).toMatchObject({ week: 7, isCurrent: true, planCount: 8 });
    // Week 5 has no submissions at all — it must still be selectable, or the
    // page could never show a week where nobody submitted.
    const week5 = weeks.find((w) => w.week === 5);
    expect(week5).toMatchObject({ isCurrent: false, planCount: 0, rangeLabel: '29 Aug – 2 Sep 2026' });
    expect(week5?.weekLabels).toEqual(['2026-W05']);
  });

  it('derives the date range from the academic calendar, not the plan title', () => {
    const weeks = buildSubmissionWeeks(
      [{ week_label: '2026-W07', plan_count: 8 }],
      YEAR,
      TODAY
    );
    expect(weeks[0].rangeLabel).toBe('12 Sep – 16 Sep 2026');
    expect(weeks[0].label).toBe('Week 2026-W07');
  });

  it('folds legacy label spellings into their calendar week so their plans are found', () => {
    const weeks = buildSubmissionWeeks(
      [
        { week_label: '2026-W06', plan_count: 5 },
        { week_label: 'week 6', plan_count: 2 }, // legacy spelling, no year
        { week_label: 'Week7', plan_count: 3 }, // legacy spelling of week 7
      ],
      YEAR,
      TODAY
    );
    const week6 = weeks.find((w) => w.week === 6);
    const week7 = weeks.find((w) => w.week === 7);
    expect(week6?.weekLabels.sort()).toEqual(['2026-W06', 'week 6'].sort());
    expect(week6?.planCount).toBe(7);
    // "Week7" carries no year, so it folds into week 7 of the current year.
    expect(week7?.weekLabels).toContain('Week7');
    expect(week7?.planCount).toBe(3);
  });

  it('keeps weeks beyond the current one selectable when plans exist for them', () => {
    const weeks = buildSubmissionWeeks(
      [
        { week_label: '2026-W07', plan_count: 8 },
        { week_label: '2026-W09', plan_count: 2 }, // submitted ahead of schedule
      ],
      YEAR,
      TODAY
    );
    expect(weeks[0]).toMatchObject({ week: 9, isCurrent: false });
    expect(weeks[1]).toMatchObject({ week: 7, isCurrent: true });
  });

  it('keeps last year’s submitted weeks below this year’s calendar', () => {
    const weeks = buildSubmissionWeeks(
      [{ week_label: '2025-W30', plan_count: 4 }],
      YEAR,
      TODAY
    );
    expect(weeks[0]).toMatchObject({ week: 7, isCurrent: true });
    expect(weeks[weeks.length - 1]).toMatchObject({ year: 2025, week: 30 });
  });

  it('caps the calendar at the academic year’s end date', () => {
    const shortYear = { startDate: '2026-08-01', endDate: '2026-09-04' }; // 5 weeks
    const weeks = buildSubmissionWeeks([], shortYear, TODAY);
    expect(weeks.map((w) => w.week)).toEqual([5, 4, 3, 2, 1]);
  });

  it('falls back to submitted weeks only when no academic year exists', () => {
    const weeks = buildSubmissionWeeks(
      [
        { week_label: '2026-W07', plan_count: 8 },
        { week_label: '2026-W06', plan_count: 6 },
      ],
      null,
      TODAY
    );
    expect(weeks.map((w) => w.label)).toEqual(['Week 2026-W07', 'Week 2026-W06']);
    expect(weeks.every((w) => !w.isCurrent)).toBe(true);
  });

  it('never marks anything current before the school year starts', () => {
    const weeks = buildSubmissionWeeks([], YEAR, new Date('2026-07-20T09:00:00'));
    expect(weeks.map((w) => w.label)).toEqual(['Week 2026-W01']);
    expect(weeks[0].isCurrent).toBe(true);
    expect(defaultSubmissionWeek(weeks)?.week).toBe(1);
  });
});

describe('defaultSubmissionWeek', () => {
  it('opens on the current school week, not the newest submitted one', () => {
    const weeks = buildSubmissionWeeks(
      [{ week_label: '2026-W09', plan_count: 2 }],
      YEAR,
      TODAY
    );
    expect(defaultSubmissionWeek(weeks)?.week).toBe(7);
  });

  it('falls back to the newest submitted week when there is no academic year', () => {
    const weeks = buildSubmissionWeeks(
      [
        { week_label: '2026-W09', plan_count: 2 },
        { week_label: '2026-W06', plan_count: 1 },
      ],
      null,
      TODAY
    );
    expect(defaultSubmissionWeek(weeks)?.week).toBe(9);
  });
});

// ─── Rows ─────────────────────────────────────────────────────────────────

function plan(
  id: string,
  teacherId: string,
  className: string,
  status: SubmissionTrackingPlan['status'],
  stamp: string
): SubmissionTrackingPlan {
  return {
    id,
    teacher_id: teacherId,
    class_name: className,
    week_label: '2026-W07',
    status,
    ai_started_at: stamp,
    created_at: stamp,
    updated_at: stamp,
    teacher_name: null,
  };
}

const SUBMITTERS: ExpectedSubmitter[] = [
  { teacherId: 't-omar', teacherName: 'Omar Dahir', classes: ['Grade 1-A'] },
  { teacherId: 't-huda', teacherName: 'Huda Cali Xasan', classes: ['Grade 2-B'] },
  { teacherId: 't-ahmed', teacherName: 'Ahmed Hassan', classes: ['Grade 1-C'] },
  { teacherId: 't-ayan', teacherName: 'Ayan Warsame', classes: ['Grade 5-A', 'Grade 6-B'] },
];

const W07_PLANS: SubmissionTrackingPlan[] = [
  { ...plan('plan-omar-1', 't-omar', 'Grade 1-A', 'approved', '2026-09-12T05:14:00Z'), teacher_name: 'Omar Dahir' },
  // Huda accidentally has two records for the same week — she is ONE teacher.
  { ...plan('plan-huda-1', 't-huda', 'Grade 2-B', 'in_review', '2026-09-12T05:22:00Z'), teacher_name: 'Huda Cali Xasan' },
  { ...plan('plan-huda-2', 't-huda', 'Grade 2-B', 'approved', '2026-09-12T06:05:00Z'), teacher_name: 'Huda Cali Xasan' },
  { ...plan('plan-ayan-1', 't-ayan', 'Grade 5-A', 'submitted', '2026-09-12T06:01:00Z'), teacher_name: 'Ayan Warsame' },
];

describe('buildSubmissionRows — the teacher list', () => {
  const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);

  it('starts from the roster: every expected teacher appears exactly once', () => {
    expect(rows.map((r) => r.teacherName).sort()).toEqual([
      'Ahmed Hassan', 'Ayan Warsame', 'Huda Cali Xasan', 'Omar Dahir',
    ]);
  });

  it('marks a teacher with no plan for the week as Not Submitted instead of dropping them', () => {
    const ahmed = rows.find((r) => r.teacherId === 't-ahmed');
    expect(ahmed).toMatchObject({
      submitted: false,
      submittedAt: null,
      planCount: 0,
      latestPlanId: null,
    });
  });

  it('counts a teacher once even with several plan records for the week', () => {
    const huda = rows.find((r) => r.teacherId === 't-huda');
    expect(huda?.submitted).toBe(true);
    expect(huda?.planCount).toBe(2);
    expect(huda?.submittedClasses).toEqual(['Grade 2-B']);
    // The row keeps the latest submission and links to the latest plan.
    expect(huda?.submittedAt).toBe('2026-09-12T06:05:00Z');
    expect(huda?.latestPlanId).toBe('plan-huda-2');
  });

  it('shows the classes a multi-class teacher actually submitted for', () => {
    const ayan = rows.find((r) => r.teacherId === 't-ayan');
    expect(ayan?.submittedClasses).toEqual(['Grade 5-A']);
    expect(ayan?.assignedClasses).toEqual(['Grade 5-A', 'Grade 6-B']);
  });

  it('counts a revision_requested plan as submitted (the teacher did hand it in)', () => {
    const rowsWithRevision = buildSubmissionRows(SUBMITTERS, [
      ...W07_PLANS,
      plan('plan-ahmed-1', 't-ahmed', 'Grade 1-C', 'revision_requested', '2026-09-12T07:30:00Z'),
    ]);
    const ahmed = rowsWithRevision.find((r) => r.teacherId === 't-ahmed');
    expect(ahmed?.submitted).toBe(true);
    expect(ahmed?.latestPlanStatus).toBe('revision_requested');
  });

  it('never counts drafts', () => {
    expect(SUBMISSION_TRACKING_STATUSES).not.toContain('draft');
  });

  it('keeps teachers who submitted but left the roster (never flags them missing)', () => {
    const rowsWithGhost = buildSubmissionRows(
      SUBMITTERS.filter((s) => s.teacherId !== 't-omar'),
      W07_PLANS
    );
    const omar = rowsWithGhost.find((r) => r.teacherId === 't-omar');
    expect(omar).toMatchObject({ submitted: true, assignedClasses: [] });
    expect(omar?.submittedClasses).toEqual(['Grade 1-A']);
  });

  it('is week-scoped: the same roster, another week’s plans, flips the statuses', () => {
    // Ahmed submitted week 6 but not week 7.
    const w06Rows = buildSubmissionRows(SUBMITTERS, [
      plan('plan-ahmed-6', 't-ahmed', 'Grade 1-C', 'approved', '2026-09-05T05:00:00Z'),
    ]);
    expect(w06Rows.find((r) => r.teacherId === 't-ahmed')?.submitted).toBe(true);
    expect(w06Rows.find((r) => r.teacherId === 't-omar')?.submitted).toBe(false);
    expect(rows.find((r) => r.teacherId === 't-ahmed')?.submitted).toBe(false);
  });
});

describe('submissionStamp', () => {
  it('prefers the submit-time stamp, then updated_at, then created_at', () => {
    const base = { id: 'p', teacher_id: 't', class_name: 'c', week_label: 'w', status: 'submitted' as const };
    expect(submissionStamp({ ...base, ai_started_at: 'a', updated_at: 'b', created_at: 'c' })).toBe('a');
    expect(submissionStamp({ ...base, ai_started_at: null, updated_at: 'b', created_at: 'c' })).toBe('b');
    expect(submissionStamp({ ...base, ai_started_at: null, updated_at: 'b', created_at: 'c' } as never)).toBe('b');
  });
});

// ─── Summary, filters, sorting ────────────────────────────────────────────

describe('summarizeSubmissions — the summary cards', () => {
  it('counts teachers, not plan records', () => {
    const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);
    expect(summarizeSubmissions(rows)).toEqual({ total: 4, submitted: 3, notSubmitted: 1, rate: 75 });
  });

  it('returns a zero rate when nobody is expected', () => {
    expect(summarizeSubmissions([])).toEqual({ total: 0, submitted: 0, notSubmitted: 0, rate: 0 });
  });

  it('matches the 40/32/8/80% accountability example', () => {
    const submitters: ExpectedSubmitter[] = Array.from({ length: 40 }, (_, i) => ({
      teacherId: `t-${i}`,
      teacherName: `Teacher ${i}`,
      classes: ['Grade 1-A'],
    }));
    const plans = Array.from({ length: 32 }, (_, i) =>
      plan(`p-${i}`, `t-${i}`, 'Grade 1-A', 'submitted', '2026-09-12T08:00:00Z')
    );
    expect(summarizeSubmissions(buildSubmissionRows(submitters, plans))).toEqual({
      total: 40,
      submitted: 32,
      notSubmitted: 8,
      rate: 80,
    });
  });
});

describe('filterSubmissionRows — filters work together with the week', () => {
  const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);
  const noFilters = { status: 'all' as const, className: null, search: '' };

  it('status filter: only missing teachers', () => {
    const missing = filterSubmissionRows(rows, { ...noFilters, status: 'not_submitted' });
    expect(missing.map((r) => r.teacherName)).toEqual(['Ahmed Hassan']);
  });

  it('status filter: only submitted teachers', () => {
    const done = filterSubmissionRows(rows, { ...noFilters, status: 'submitted' });
    expect(done.map((r) => r.teacherName).sort()).toEqual(['Ayan Warsame', 'Huda Cali Xasan', 'Omar Dahir']);
  });

  it('class filter matches the class a teacher submitted for', () => {
    const grade2 = filterSubmissionRows(rows, { ...noFilters, className: 'Grade 2-B' });
    expect(grade2.map((r) => r.teacherName)).toEqual(['Huda Cali Xasan']);
  });

  it('class filter also matches a missing teacher’s assigned class', () => {
    const grade1c = filterSubmissionRows(rows, { ...noFilters, className: 'Grade 1-C' });
    expect(grade1c.map((r) => r.teacherName)).toEqual(['Ahmed Hassan']);
  });

  it('class + status together: Grade 5 teachers who have not submitted', () => {
    const combined = filterSubmissionRows(rows, {
      status: 'not_submitted',
      className: 'Grade 1-A',
      search: '',
    });
    // Omar (Grade 1-A) submitted; nobody else is assigned 1-A.
    expect(combined).toEqual([]);
    const grade5Missing = filterSubmissionRows(
      buildSubmissionRows(
        [...SUBMITTERS, { teacherId: 't-halima', teacherName: 'Halima Aden', classes: ['Grade 5-A'] }],
        W07_PLANS
      ),
      { status: 'not_submitted', className: 'Grade 5-A', search: '' }
    );
    expect(grade5Missing.map((r) => r.teacherName)).toEqual(['Halima Aden']);
  });

  it('search is case-insensitive on the teacher name', () => {
    const hits = filterSubmissionRows(rows, { ...noFilters, search: '  omar ' });
    expect(hits.map((r) => r.teacherName)).toEqual(['Omar Dahir']);
  });
});

describe('sortSubmissionRows — missing submissions first by default', () => {
  const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);

  it('puts Not Submitted teachers before submitted ones', () => {
    const sorted = sortSubmissionRows(rows, 'missing-first');
    expect(sorted[0].submitted).toBe(false);
    expect(sorted.slice(1).every((r) => r.submitted)).toBe(true);
    expect(sorted.map((r) => r.teacherName)).toEqual([
      'Ahmed Hassan', // missing, first
      'Ayan Warsame', // then submitted, A–Z
      'Huda Cali Xasan',
      'Omar Dahir',
    ]);
  });

  it('name sort is a plain A–Z', () => {
    expect(sortSubmissionRows(rows, 'name').map((r) => r.teacherName)).toEqual([
      'Ahmed Hassan', 'Ayan Warsame', 'Huda Cali Xasan', 'Omar Dahir',
    ]);
  });

  it('latest sort follows the most recent submission', () => {
    expect(sortSubmissionRows(rows, 'latest').map((r) => r.teacherName)).toEqual([
      'Huda Cali Xasan', // 06:05
      'Ayan Warsame', // 06:01
      'Omar Dahir', // 05:14
      'Ahmed Hassan', // never submitted — last
    ]);
  });
});

describe('class display helpers', () => {
  it('shows submitted classes when present, assigned classes otherwise', () => {
    const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);
    expect(submissionClassLabel(rows.find((r) => r.teacherId === 't-ayan')!)).toBe('Grade 5-A');
    expect(submissionClassLabel(rows.find((r) => r.teacherId === 't-ahmed')!)).toBe('Grade 1-C');
  });

  it('lists every class the supervisor can filter by', () => {
    const rows = buildSubmissionRows(SUBMITTERS, W07_PLANS);
    expect(submissionClassOptions(rows)).toEqual([
      'Grade 1-A', 'Grade 1-C', 'Grade 2-B', 'Grade 5-A', 'Grade 6-B',
    ]);
  });
});
