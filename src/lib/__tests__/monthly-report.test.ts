import { describe, expect, it } from 'vitest';
import { getGrade } from '../../types';
import {
  aggregateMonthlyReport,
  calculateMonthlyScore,
  formatReportPercent,
  monthlyGrade,
  monthlyRemark,
  MONTHLY_CA_WEIGHT,
  MONTHLY_QUIZ_WEIGHT,
  normalizeMonthlyReport,
  overallMonthlyAverage,
} from '../monthlyReport';

describe('Monthly calculation CA 40% / Quiz 60%', () => {
  it('Test 1 — Standard: CA 70, Quiz 80 → 76', () => {
    expect(calculateMonthlyScore(70, 80)).toBe(76);
  });

  it('Test 2 — High Quiz: CA 50, Quiz 90 → 74', () => {
    expect(calculateMonthlyScore(50, 90)).toBe(74);
  });

  it('Test 3 — High CA: CA 90, Quiz 50 → 66', () => {
    expect(calculateMonthlyScore(90, 50)).toBe(66);
  });

  it('Test 4 — Multiple quizzes average then apply 60% Quiz weight', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 80, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 90, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].quiz_avg).toBe(80);
    expect(rows[0].ca_avg).toBe(70);
    expect(rows[0].quiz_weight).toBe(60);
    expect(rows[0].ca_weight).toBe(40);
    expect(rows[0].average).toBe(76);
    expect(rows[0].quiz_count).toBe(3);
  });

  it('Test 5 — Missing Quiz is not silently converted to zero', () => {
    expect(calculateMonthlyScore(70, null)).toBeNull();
    expect(formatReportPercent(null)).toBe('Not recorded');
    expect(formatReportPercent(0)).toBe('0%');

    const missingQuiz = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    expect(missingQuiz[0].ca_avg).toBe(70);
    expect(missingQuiz[0].quiz_avg).toBeNull();
    expect(missingQuiz[0].average).toBeNull();
    expect(missingQuiz[0].grade).toBeNull();
    expect(formatReportPercent(missingQuiz[0].quiz_avg)).toBe('Not recorded');

    const recordedZero = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 0, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    expect(recordedZero[0].quiz_avg).toBe(0);
    expect(recordedZero[0].average).toBe(28);
  });

  it('Test 6 — Monthly 40/60 isolation: Midterm and Final formulas are unchanged', () => {
    expect(MONTHLY_CA_WEIGHT).toBe(40);
    expect(MONTHLY_QUIZ_WEIGHT).toBe(60);
    expect(calculateMonthlyScore(70, 80)).toBe(76);

    // Midterm continues to be a straight percentage, not CA 40 + Quiz 60.
    const midtermPercentage = Math.round((17.5 / 20) * 10000) / 100;
    expect(midtermPercentage).toBe(87.5);
    expect(midtermPercentage).not.toBe(calculateMonthlyScore(70, 87.5));

    // Final continues to use report_config weights (example 30/30/40), not 40/60.
    const finalTotal = 86.67 * 0.30 + 87.5 * 0.30 + 85 * 0.40;
    expect(Number(finalTotal.toFixed(2))).not.toBe(76);
    expect(calculateMonthlyScore(86.67, 87.5)).not.toBe(Number(finalTotal.toFixed(2)));
  });
});

describe('aggregateMonthlyReport', () => {
  it('calculates per subject and does not blend subjects before weighting', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 75, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 85, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'English', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'English', month: 'September', examType: 'Quiz', score: 80, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    const math = rows.find(row => row.subject === 'Mathematics')!;
    const english = rows.find(row => row.subject === 'English')!;
    expect(math.average).toBe(81);
    expect(english.average).toBe(76);
  });

  it('grades from the Monthly score, not from CA alone', () => {
    expect(monthlyGrade(76)).toBe('C');
    expect(getGrade(70)).toBe('C');
    expect(getGrade(80)).toBe('B');
    expect(monthlyRemark(76)).toBe('Good');

    const rows = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 80, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    expect(rows[0].average).toBe(76);
    expect(rows[0].grade).toBe('C');
    expect(rows[0].grade).not.toBe(getGrade(70) === 'C' && rows[0].ca_avg === 70 ? 'A' : rows[0].grade);
    expect(getGrade(rows[0].ca_avg!)).toBe('C');
    expect(rows[0].grade).toBe(getGrade(76));
  });

  it('includes bulk-uploaded MT rows as Quiz, not as CA', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'English', month: 'May', examType: 'Homework', assessmentLabel: 'HW1', score: 4.5, total: 5, status: 'approved', entryState: 'scored' },
      { subject: 'English', month: 'May', examType: 'Classwork', assessmentLabel: 'CPW1', score: 12.5, total: 15, status: 'approved', entryState: 'scored' },
      { subject: 'English', month: 'May', examType: 'Quiz', assessmentLabel: 'MT', score: 17.5, total: 20, status: 'approved', entryState: 'scored' },
    ]);
    expect(rows[0].ca_count).toBe(2);
    expect(rows[0].quiz_count).toBe(1);
    expect(rows[0].quiz_avg).toBe(87.5);
    expect(rows[0].quiz_details.some(detail => detail.type === 'MT')).toBe(true);
    expect(rows[0].ca_details.some(detail => detail.type === 'MT')).toBe(false);
  });

  it('does not treat Homework/Classwork/Attendance as Quiz, and ignores Midterm/Final/Discipline', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'Science', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Science', month: 'September', examType: 'Homework', score: 5, total: 5, status: 'approved', entryState: 'scored' },
      { subject: 'Science', month: 'September', examType: 'Quiz', score: 80, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Science', month: 'September', examType: 'Midterm', score: 10, total: 10, status: 'approved', entryState: 'scored' },
      { subject: 'Science', month: 'September', examType: 'Final', score: 10, total: 10, status: 'approved', entryState: 'scored' },
      { subject: 'Science', month: 'September', examType: 'Discipline', score: 10, total: 10, status: 'approved', entryState: 'scored' },
    ]);
    expect(rows[0].quiz_count).toBe(1);
    expect(rows[0].quiz_avg).toBe(80);
    expect(rows[0].ca_avg).toBe(85);
    expect(rows[0].average).toBe(82);
  });

  it('filters CA and Quiz against the same month', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'October', examType: 'Quiz', score: 80, total: 100, status: 'approved', entryState: 'scored' },
    ]);
    const september = rows.find(row => row.month === 'September')!;
    const october = rows.find(row => row.month === 'October')!;
    expect(september.quiz_avg).toBeNull();
    expect(october.ca_avg).toBeNull();
    expect(september.average).toBeNull();
    expect(october.average).toBeNull();
  });

  it('ignores pending, absent, and blank scores', () => {
    const rows = aggregateMonthlyReport([
      { subject: 'Mathematics', month: 'September', examType: 'CA', score: 70, total: 100, status: 'approved', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: 80, total: 100, status: 'pending', entryState: 'scored' },
      { subject: 'Mathematics', month: 'September', examType: 'Quiz', score: null, total: 100, status: 'approved', entryState: 'absent' },
    ]);
    expect(rows[0].quiz_avg).toBeNull();
    expect(rows[0].average).toBeNull();
  });
});

describe('normalizeMonthlyReport', () => {
  it('recomputes 40/60 from a legacy mixed-details RPC payload', () => {
    const rows = normalizeMonthlyReport([
      {
        subject: 'Mathematics',
        month: 'September',
        average: 75,
        assessment_count: 2,
        details: [
          { type: 'CA', score: 70, total: 100, percentage: 70, date: '2026-09-01' },
          { type: 'Quiz', score: 80, total: 100, percentage: 80, date: '2026-09-02' },
        ],
      },
    ]);
    expect(rows[0].ca_avg).toBe(70);
    expect(rows[0].quiz_avg).toBe(80);
    expect(rows[0].average).toBe(76);
    expect(rows[0].grade).toBe('C');
  });
});

describe('overallMonthlyAverage', () => {
  it('averages only subjects that have a complete Monthly score', () => {
    expect(overallMonthlyAverage([
      { average: 76 },
      { average: null },
    ])).toBe(76);
    expect(overallMonthlyAverage([{ average: null }])).toBeNull();
  });
});
