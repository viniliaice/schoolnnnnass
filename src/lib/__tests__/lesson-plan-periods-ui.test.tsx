import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { CreatePlanForm } from '../../components/lesson-planner/CreatePlanForm';
import { PlanGrid } from '../../components/lesson-planner/PlanGrid';
import { PlanConfigBar } from '../../components/lesson-planner/PlanConfigBar';
import { createEmptyPeriods } from '../lessonPlanPeriods';
import type { PeriodCell } from '../lessonPlanPeriods';

// LessonPlanner's page-level contexts are not needed here: the tested pieces
// are presentational and driven by the same dynamic period helpers.

function filledGrid(count: number): PeriodCell[] {
  return createEmptyPeriods(count).map((cell) => ({ ...cell, topic: `Topic ${cell.period_number}` }));
}

function renderPlanGrid(count: number): string {
  return renderToStaticMarkup(
    <PlanGrid
      periods={filledGrid(count)}
      periodCount={count}
      teacherClasses={['Foundation-KG']}
      subjects={[]}
      planClassName="Foundation-KG"
      weekDates={['', '', '', '', '']}
      onUpdateCell={() => undefined}
      onUpdateActivity={() => undefined}
      onAddActivity={() => undefined}
      onRemoveActivity={() => undefined}
      onChangePeriodCount={() => undefined}
    />
  );
}

describe('Lesson Plan Upload / editor period UI', () => {
  it('shows a fixed 4/5/6 dropdown instead of a free-form stepper', () => {
    const markup = renderToStaticMarkup(
      <CreatePlanForm
        className="Foundation-KG"
        setClassName={() => undefined}
        periodCount={4}
        setPeriodCount={() => undefined}
        title=""
        setTitle={() => undefined}
        teacherClasses={['Foundation-KG']}
        onCreate={() => undefined}
        loading={false}
        weekStartDate=""
        weekEndDate=""
        onPrevWeek={() => undefined}
        onNextWeek={() => undefined}
      />
    );
    expect(markup).toContain('Periods per day');
    expect(markup).toContain('aria-label="Periods per day"');
    // Exactly the three allowed options, with 4 preselected.
    expect(markup).toContain('4 periods');
    expect(markup).toContain('5 periods');
    expect(markup).toContain('6 periods');
    expect(markup).toContain('value="4"');
    // No free-form number entry anymore.
    expect(markup).not.toContain('type="number"');
    expect(markup).not.toContain('7 periods');
  });

  it('the config bar also uses the fixed dropdown', () => {
    const markup = renderToStaticMarkup(
      <PlanConfigBar
        className="Foundation-KG"
        setClassName={() => undefined}
        periodCount={4}
        setPeriodCount={() => undefined}
        teacherClasses={['Foundation-KG']}
        weekLabel="2026-W30"
        weekStartDate=""
        weekEndDate=""
        onPrevWeek={() => undefined}
        onNextWeek={() => undefined}
      />
    );
    expect(markup).toContain('Periods/day');
    expect(markup).toContain('aria-label="Periods per day"');
    expect(markup).toContain('4 periods');
    expect(markup).toContain('5 periods');
    expect(markup).toContain('6 periods');
    expect(markup).toContain('value="4"');
    expect(markup).not.toContain('type="number"');
  });

  it('renders exactly the four period rows for a Foundation/KG plan — no period 5 or 6', () => {
    const markup = renderPlanGrid(4);
    expect(markup).toContain('>P1<');
    expect(markup).toContain('>P2<');
    expect(markup).toContain('>P3<');
    expect(markup).toContain('>P4<');
    expect(markup).not.toContain('>P5<');
    expect(markup).not.toContain('>P6<');
    expect(markup).toContain('Add Period 5');
    expect(markup).toContain('4 periods per day');
  });

  it('renders five periods when the plan has five', () => {
    const markup = renderPlanGrid(5);
    expect(markup).toContain('>P5<');
    expect(markup).not.toContain('>P6<');
    expect(markup).toContain('Add Period 6');
    expect(markup).toContain('5 periods per day');
  });

  it('renders six periods when the plan has six and never offers a seventh', () => {
    const markup = renderPlanGrid(6);
    expect(markup).toContain('>P6<');
    expect(markup).not.toContain('>P7<');
    expect(markup).not.toContain('Add Period 7');
    expect(markup).toContain('Maximum of 6 periods per day');
    expect(markup).toContain('6 periods per day');
  });

  it('offers a remove control on the last period row so extra periods can be removed', () => {
    const markup = renderPlanGrid(6);
    expect(markup).toContain('aria-label="Remove period 6"');
    // A five-period plan can still go down to 4.
    expect(renderPlanGrid(5)).toContain('aria-label="Remove period 5"');
  });

  it('never offers to drop below the 4-period minimum', () => {
    const markup = renderPlanGrid(4);
    expect(markup).not.toContain('Remove period 4');
    expect(markup).not.toContain('aria-label="Remove period');
  });
});
