import type { LessonPlanPeriod, UnitPlan } from '../types';

export type AlignmentStatus = 'full' | 'partial' | 'none' | 'unknown';

export interface PeriodInstructionalReview {
  alignmentStatus: AlignmentStatus;
  alignmentLabel: string;
  alignmentReason: string;
  aiReview: string;
  matchedUnit?: UnitPlan;
}

export interface DayPlanningSummary {
  planned: number;
  free: number;
  total: number;
  percent: number;
}

const MEASURABLE_VERBS = [
  'identify', 'explain', 'solve', 'calculate', 'compare', 'describe', 'write',
  'read', 'analyze', 'classify', 'demonstrate', 'create', 'use', 'apply',
  'evaluate', 'measure', 'draw', 'list', 'name', 'recognize', 'practice',
];

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'will',
  'able', 'students', 'student', 'lesson', 'topic', 'unit', 'plan', 'using',
  'their', 'they', 'them', 'then', 'than', 'have', 'has', 'are', 'was', 'were',
]);

function words(value: string | null | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function gradeKey(className: string | null | undefined): string {
  return (className ?? '').toLowerCase().match(/[a-z]*\d+/)?.[0] ?? (className ?? '').toLowerCase();
}

function overlapCount(a: string[], b: string[]): number {
  const bSet = new Set(b);
  return [...new Set(a)].filter((word) => bSet.has(word)).length;
}

function objectiveIsMeasurable(objective: string | null | undefined): boolean {
  const text = (objective ?? '').toLowerCase();
  if (!text.trim()) return false;
  return MEASURABLE_VERBS.some((verb) => text.includes(verb)) || /\b\d+\b|%|score|rubric|accur/i.test(text);
}

function activitiesSupportObjective(period: LessonPlanPeriod): boolean {
  const objectiveWords = words(period.objective);
  const activityText = [period.activities, ...(period.details ?? []).map((detail) => detail.activity)].join(' ');
  const activityWords = words(activityText);
  if (!objectiveWords.length || !activityWords.length) return false;
  return overlapCount(objectiveWords, activityWords) >= Math.min(2, objectiveWords.length);
}

export function summarizeDay(periods: Array<Pick<LessonPlanPeriod, 'is_free' | 'topic'>>, periodCount: number): DayPlanningSummary {
  const free = periods.filter((period) => period?.is_free).length;
  const planned = periods.filter((period) => period && !period.is_free && (period.topic ?? '').trim()).length;
  const total = Math.max(periodCount, periods.length, 1);
  return { planned, free, total, percent: Math.round((planned / total) * 100) };
}

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
  const topicWords = words(period.topic);
  const unitWords = words(`${matchedUnit?.name ?? ''} ${matchedUnit?.objectives ?? ''}`);
  const topicAligned = !!matchedUnit && (topicWords.length === 0 || overlapCount(topicWords, unitWords) > 0);

  let alignmentStatus: AlignmentStatus = 'none';
  let alignmentLabel = '❌ Not Aligned';
  let alignmentReason = 'No matching Unit Plan was found for this subject, class/grade, and topic.';

  if (matchedUnit && topicAligned && measurableObjective && supportedByActivities) {
    alignmentStatus = 'full';
    alignmentLabel = '✅ Fully Aligned';
    alignmentReason = `Matches "${matchedUnit.name}" and the objective, topic, and activities support the unit direction.`;
  } else if (matchedUnit) {
    alignmentStatus = 'partial';
    alignmentLabel = '⚠️ Partially Aligned';
    const gaps = [
      !topicAligned && 'topic link is not explicit',
      !measurableObjective && 'objective needs a clearer measurable outcome',
      !supportedByActivities && 'activities should connect more directly to the objective',
    ].filter(Boolean).join('; ');
    alignmentReason = `Matches "${matchedUnit.name}", but ${gaps || 'some lesson evidence is incomplete'}.`;
  }

  const objectiveSentence = measurableObjective
    ? 'The objective is clear and measurable'
    : 'The objective should be made more measurable';
  const activitySentence = supportedByActivities
    ? 'the activities support the intended learning progression'
    : 'the activities need a clearer connection to the stated objective';
  const unitSentence = matchedUnit
    ? `The lesson ${alignmentStatus === 'full' ? 'aligns well' : 'partially aligns'} with the Unit Plan "${matchedUnit.name}".`
    : 'A matching Unit Plan was not found, so alignment should be confirmed before approval.';

  return {
    alignmentStatus,
    alignmentLabel,
    alignmentReason,
    aiReview: `${objectiveSentence}, and ${activitySentence}. ${unitSentence}`,
    matchedUnit,
  };
}
