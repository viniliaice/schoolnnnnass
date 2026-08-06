import type { LessonPlanPeriod, UnitPlan } from '../types';
import { weekNumberFromLabel } from '../utils/weekDates';

export type AlignmentStatus = 'full' | 'partial' | 'none' | 'unknown';

export interface PeriodInstructionalReview {
  alignmentStatus: AlignmentStatus;
  alignmentLabel: string;
  alignmentReason: string;
  alignmentGap: string;
  aiReview: string;
  suggestedActivities: string[];
  matchedUnit?: UnitPlan;
  revisionStatus: 'included' | 'missing' | 'not_applicable';
  revisionReason: string;
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

function gradeBand(className: string | null | undefined): 'early' | 'middle' | 'upper' {
  const n = Number((className ?? '').match(/\d+/)?.[0] ?? 0);
  if (n > 0 && n <= 3) return 'early';
  if (n > 0 && n <= 6) return 'middle';
  return 'upper';
}

function subjectKind(...values: Array<string | null | undefined>): 'math' | 'english' | 'science' | 'social' | 'arabic' | 'general' {
  const value = values.filter(Boolean).join(' ').toLowerCase();
  if (/math|numeracy|algebra|geometry|addition|subtraction|multiplication|division/.test(value)) return 'math';
  if (/english|literacy|reading|writing|language|grammar/.test(value)) return 'english';
  if (/science|biology|chemistry|physics|environment/.test(value)) return 'science';
  if (/social|history|geography|civic|islamic|somali/.test(value)) return 'social';
  if (/arabic|quran|qur/.test(value)) return 'arabic';
  return 'general';
}

function activityNoun(period: LessonPlanPeriod): string {
  const topic = period.topic?.trim();
  const objective = period.objective?.trim();
  return topic || objective || 'the lesson skill';
}

function buildSuggestedActivities(period: LessonPlanPeriod, matchedUnit?: UnitPlan): string[] {
  const topic = activityNoun(period);
  const objective = period.objective?.trim() || `understand ${topic}`;
  const unitName = matchedUnit?.name || 'the relevant Unit Plan';
  const band = gradeBand(period.class_name);

  switch (subjectKind(period.subject, period.topic, period.objective, matchedUnit?.name, matchedUnit?.objectives)) {
    case 'math':
      return band === 'early'
        ? [
          `Students model ${topic} with counters, base-ten blocks, or classroom objects and explain their thinking to a partner.`,
          `Pairs solve three scaffolded ${topic} problems on mini-whiteboards, showing each step and checking against the objective: ${objective}.`,
          `Students complete a short real-life ${topic} task linked to ${unitName}, then share one strategy that worked.`,
        ]
        : [
          `Students solve a graduated set of ${topic} problems individually, annotating the rule or method used for each step.`,
          `Small groups compare two solution strategies for ${topic} and justify which strategy best meets the objective: ${objective}.`,
          `Students create and exchange a word problem connected to ${unitName}, then solve and peer-check the answer.`,
        ];
    case 'english':
      return [
        `Students annotate a short text for examples of ${topic}, then cite one line that proves their answer.`,
        `Pairs use a sentence frame to practise ${objective}, revising one response after peer feedback.`,
        `Students write a brief exit response connected to ${unitName}, using two vocabulary words from the lesson.`,
      ];
    case 'science':
      return [
        `Students observe or sort concrete examples of ${topic}, recording evidence in a simple table.`,
        `Groups conduct a short demonstration or model that tests the idea in the objective: ${objective}.`,
        `Students explain how their evidence connects to ${unitName} using a claim-evidence-reasoning sentence frame.`,
      ];
    case 'social':
      return [
        `Students analyze a map, image, timeline, or short source related to ${topic} and identify two key details.`,
        `Pairs discuss how the evidence supports the objective: ${objective}, then report one conclusion to the class.`,
        `Students complete a short comparison or cause-effect task that connects ${topic} to ${unitName}.`,
      ];
    case 'arabic':
      return [
        `Students practise reading or reciting examples related to ${topic} with partner correction and teacher feedback.`,
        `Pairs identify key vocabulary or language patterns that support the objective: ${objective}.`,
        `Students complete a short oral or written application task connected to ${unitName}.`,
      ];
    default:
      return [
        `Students complete a guided practice task using ${topic} and explain how it meets the objective: ${objective}.`,
        `Pairs apply ${topic} in a short scenario or example connected to ${unitName}.`,
        `Students finish with an exit ticket that asks them to demonstrate the objective independently.`,
      ];
  }
}

export function summarizeDay(periods: Array<Pick<LessonPlanPeriod, 'is_free' | 'topic'>>, periodCount: number): DayPlanningSummary {
  const free = periods.filter((period) => period?.is_free).length;
  const planned = periods.filter((period) => period && !period.is_free && (period.topic ?? '').trim()).length;
  const total = Math.max(periodCount, periods.length, 1);
  return { planned, free, total, percent: Math.round((planned / total) * 100) };
}

export function findMatchingUnitPlan(period: LessonPlanPeriod, unitPlans: UnitPlan[] = [], weekLabel?: string): UnitPlan | undefined {
  const subject = (period.subject ?? '').trim();
  const className = (period.class_name ?? '').trim();
  const periodGrade = gradeKey(className);
  const topicWords = words(period.topic);
  const weekNumber = weekNumberFromLabel(weekLabel);

  const candidates = unitPlans.filter((unit) => {
    const subjectMatches = !subject || unit.subject_id === subject;
    const classMatches = !className || unit.class_name === className || gradeKey(unit.class_name) === periodGrade;
    const weekMatches = weekNumber === null || (weekNumber >= unit.week_number_start && weekNumber <= unit.week_number_end);
    return subjectMatches && classMatches && weekMatches;
  });

  if (!candidates.length) return undefined;

  return candidates
    .map((unit) => {
      const unitWords = words(`${unit.name} ${unit.objectives}`);
      const topicScore = overlapCount(topicWords, unitWords);
      const weekBonus = weekNumber !== null && weekNumber >= unit.week_number_start && weekNumber <= unit.week_number_end ? 2 : 0;
      return { unit, score: topicScore + weekBonus };
    })
    .sort((a, b) => b.score - a.score)[0]?.unit;
}

export interface PeriodReviewContext {
  weekLabel?: string;
  previousSameDay?: Pick<LessonPlanPeriod, 'topic' | 'objective' | 'activities'> | null;
}

function revisionCheck(period: LessonPlanPeriod, previous?: Pick<LessonPlanPeriod, 'topic' | 'objective' | 'activities'> | null): { status: 'included' | 'missing' | 'not_applicable'; reason: string } {
  if (!previous || !previous.topic?.trim()) {
    return { status: 'not_applicable', reason: 'No same-day period was found in the previous week, so revision is not required.' };
  }
  const previousWords = words(`${previous.topic} ${previous.objective ?? ''}`);
  const currentRevisionText = `${period.activities ?? ''} ${(period.details ?? []).map(d => d.activity).join(' ')} ${period.topic ?? ''} ${period.objective ?? ''}`;
  const currentWords = words(currentRevisionText);
  const revisionLanguage = /revision|review|recap|warm\s*up|prior|previous|last week|reinforce|practice/i.test(currentRevisionText);
  const overlap = overlapCount(previousWords, currentWords);
  if (revisionLanguage || overlap >= Math.min(2, previousWords.length || 2)) {
    return { status: 'included', reason: `Includes revision/reinforcement of last week's ${period.day} topic: ${previous.topic}.` };
  }
  return { status: 'missing', reason: `Previous ${period.day} topic was "${previous.topic}", but this period does not include a clear recap, warm-up, or reinforcement activity.` };
}

export function reviewPeriodInstruction(period: LessonPlanPeriod, unitPlans: UnitPlan[] = [], context: PeriodReviewContext = {}): PeriodInstructionalReview {
  if (period.is_free || period.subject === '__FREE__') {
    return {
      alignmentStatus: 'unknown',
      alignmentLabel: 'Free Period',
      alignmentReason: 'No instructional alignment is needed for a free period.',
      alignmentGap: 'None — free period.',
      aiReview: 'This is marked as a free period, so no instructional coaching review is required.',
      suggestedActivities: [],
      revisionStatus: 'not_applicable',
      revisionReason: 'No instructional revision check is needed for a free period.',
    };
  }

  const measurableObjective = objectiveIsMeasurable(period.objective);
  const supportedByActivities = activitiesSupportObjective(period);
  const matchedUnit = findMatchingUnitPlan(period, unitPlans, context.weekLabel);
  const revision = revisionCheck(period, context.previousSameDay);
  const topicWords = words(period.topic);
  const unitWords = words(`${matchedUnit?.name ?? ''} ${matchedUnit?.objectives ?? ''}`);
  const topicOverlap = overlapCount(topicWords, unitWords);
  const topicAligned = !!matchedUnit && topicWords.length > 0 && topicOverlap >= Math.min(2, topicWords.length);
  const topicAdjacent = !!matchedUnit && topicWords.length > 0 && topicOverlap > 0;

  let alignmentStatus: AlignmentStatus = 'none';
  let alignmentLabel = '❌ Not Aligned';
  let alignmentReason = 'No matching Unit Plan was found for this subject, class/grade, and topic.';
  let alignmentGap = 'Unit Plan match is missing, so the reviewer cannot verify the lesson topic/objective against the expected unit sequence.';

  if (matchedUnit && topicAligned && measurableObjective && supportedByActivities) {
    alignmentStatus = 'full';
    alignmentLabel = '✅ Fully Aligned';
    alignmentReason = `Matches "${matchedUnit.name}" and the objective, topic, and activities support the unit direction.`;
    alignmentGap = 'No alignment gap found.';
  } else if (matchedUnit && !topicAdjacent) {
    alignmentStatus = 'none';
    alignmentLabel = '❌ Not Aligned';
    alignmentGap = `the lesson topic "${period.topic}" is not found in the scheduled Unit Plan objectives for week ${context.weekLabel ?? 'this plan'}`;
    alignmentReason = `Matches the class/subject/week range for "${matchedUnit.name}", but the period topic does not match the unit plan topic/objectives.`;
  } else if (matchedUnit) {
    alignmentStatus = 'partial';
    alignmentLabel = '⚠️ Partially Aligned';
    const gaps = [
      !topicAligned && 'the lesson topic is only loosely represented in the Unit Plan objectives',
      !measurableObjective && 'the objective is not measurable enough to verify mastery',
      !supportedByActivities && 'the activities do not directly practise or assess the stated objective',
    ].filter(Boolean) as string[];
    alignmentGap = gaps.join('; ') || 'some lesson evidence is incomplete.';
    alignmentReason = `Matches "${matchedUnit.name}" for the scheduled week range, but ${alignmentGap}.`;
  }

  const objectiveSentence = measurableObjective
    ? 'The objective is clear and measurable'
    : 'The objective should be made more measurable';
  const activitySentence = supportedByActivities
    ? 'the activities support the intended learning progression'
    : 'the activities need a clearer connection to the stated objective';
  const unitSentence = matchedUnit
    ? `The lesson ${alignmentStatus === 'full' ? 'follows' : 'partly follows'} the Unit Plan "${matchedUnit.name}".`
    : 'A matching Unit Plan was not found, so alignment should be confirmed before approval.';

  const revisionSentence = revision.status === 'included'
    ? 'The lesson includes appropriate weekly revision.'
    : revision.status === 'missing'
      ? 'Weekly revision is missing and should be added.'
      : 'No prior same-day lesson was available, so the weekly revision check is not applicable.';

  return {
    alignmentStatus,
    alignmentLabel,
    alignmentReason,
    alignmentGap,
    aiReview: `${objectiveSentence}, and ${activitySentence}. ${unitSentence} ${revisionSentence}`,
    suggestedActivities: alignmentStatus === 'full' && revision.status !== 'missing' ? [] : buildSuggestedActivities(period, matchedUnit),
    matchedUnit,
    revisionStatus: revision.status,
    revisionReason: revision.reason,
  };
}
