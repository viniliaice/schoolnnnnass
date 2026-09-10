import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { MonthlyScoresTable } from '../MonthlyScoresTable';
import { aggregateMonthlyReport } from '../../../lib/monthlyReport';
import type { MonthlyScore } from '../../../types';

describe('MonthlyScoresTable', () => {
  it('shows CA, Quiz, 40/60 weights, Monthly score 76, and grade from 76 for ADEN-style row', () => {
    const rows: MonthlyScore[] = aggregateMonthlyReport([
      {
        subject: 'Mathematics',
        month: 'September',
        examType: 'CA',
        score: 70,
        total: 100,
        status: 'approved',
        entryState: 'scored',
        date: '2026-09-01',
      },
      {
        subject: 'Mathematics',
        month: 'September',
        examType: 'Quiz',
        score: 80,
        total: 100,
        status: 'approved',
        entryState: 'scored',
        date: '2026-09-02',
      },
    ]);

    const html = renderToStaticMarkup(
      <MonthlyScoresTable rows={rows} month="September" />,
    );

    expect(html).toContain('Mathematics');
    expect(html).toContain('70%');
    expect(html).toContain('80%');
    expect(html).toContain('40%');
    expect(html).toContain('60%');
    expect(html).toContain('76%');
    expect(html).toContain('>C<');
    expect(html).toContain('Quiz · Quiz');
    expect(html).toContain('CA · CA');
    expect(html).toContain('(CA × 40%) + (Quiz × 60%)');
    expect(html).toContain('data-testid="monthly-quiz-Mathematics"');
    expect(html).toContain('80%');
    expect(html).toContain('76%');
  });

  it('shows Not recorded for missing Quiz instead of 0', () => {
    const rows: MonthlyScore[] = aggregateMonthlyReport([
      {
        subject: 'English',
        month: 'September',
        examType: 'CA',
        score: 70,
        total: 100,
        status: 'approved',
        entryState: 'scored',
      },
    ]);
    const html = renderToStaticMarkup(
      <MonthlyScoresTable rows={rows} month="September" />,
    );
    expect(html).toContain('Not recorded');
    expect(html).not.toContain('>0%<');
  });
});
