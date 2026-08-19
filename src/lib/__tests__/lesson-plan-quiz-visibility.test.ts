import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const teacherView = readFileSync(
  new URL('../../pages/teacher/SubmittedPlansView.tsx', import.meta.url),
  'utf8',
);
const supervisorView = readFileSync(
  new URL('../../pages/supervisor/LessonPlanReview.tsx', import.meta.url),
  'utf8',
);

describe('lesson-plan quiz role boundaries', () => {
  it('does not fetch, preview, generate, or redo quizzes in the teacher submitted-plan view', () => {
    expect(teacherView).not.toContain('useLessonPlanQuizPreviews');
    expect(teacherView).not.toContain('useGenerateLessonPlanQuizzes');
    expect(teacherView).not.toContain('handleGenerateQuizzes');
    expect(teacherView).not.toContain('Student quizzes');
    expect(teacherView).not.toContain('Redo quiz set');
  });

  it('keeps preview, generate, redo, and quiz-bank controls in the supervisor review', () => {
    expect(supervisorView).toContain('useLessonPlanQuizPreviews');
    expect(supervisorView).toContain('useGenerateLessonPlanQuizzes');
    expect(supervisorView).toContain('handleGenerateQuizzes');
    expect(supervisorView).toContain('Redo quiz set');
    expect(supervisorView).toContain('Add to Quiz Bank');
  });

  it('does not couple period-review regeneration to quiz generation', () => {
    expect(supervisorView).not.toContain('handleGenerateMissingAssets');
    expect(supervisorView).not.toMatch(
      /regeneratePeriodReviewMut\.mutateAsync\([^)]*\);\s*await generateQuizzesMut\.mutateAsync/s,
    );
  });
});
