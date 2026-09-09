// Assessment-block presentation layer for the class-specific Bulk Upload Grades
// workflow.
//
// This module DOES NOT define a second source of truth for assessment types,
// maximum scores, or exam-type mappings. Every value here is derived from
// `ASSESSMENT_DEFINITIONS` in `../excel-parser`, which is also what the client
// parser and the `submit_bulk_grades` RPC validate against. If a maximum ever
// changes, it changes in exactly one place.

import { ASSESSMENT_DEFINITIONS, type AssessmentLabel } from '../excel-parser';
import type { ExamType } from '../../types';

export interface AssessmentBlock {
  label: AssessmentLabel;
  examType: ExamType;
  total: number;
}

export type AssessmentGroupId = 'homework' | 'cpw' | 'attendance' | 'midterm' | 'akhlaaq';

export interface AssessmentGroup {
  id: AssessmentGroupId;
  title: string;
  blocks: AssessmentBlock[];
}

/** All 11 blocks, in the fixed sheet order, sourced from the parser definitions. */
export const ASSESSMENT_BLOCKS: AssessmentBlock[] = ASSESSMENT_DEFINITIONS.map(definition => ({
  label: definition.assessmentLabel,
  examType: definition.examType,
  total: definition.total,
}));

const BLOCK_BY_LABEL = new Map<AssessmentLabel, AssessmentBlock>(
  ASSESSMENT_BLOCKS.map(block => [block.label, block]),
);

export function getAssessmentBlock(label: AssessmentLabel): AssessmentBlock {
  const block = BLOCK_BY_LABEL.get(label);
  if (!block) throw new Error(`Unknown assessment label: ${label}`);
  return block;
}

/**
 * The teacher-facing grouping of the 11 blocks. Titles match the wizard's
 * "Select assessment blocks" step (Homework / CPW / Attendance / Midterm /
 * Akhlaaq). Order and membership are computed from the definitions, so a new
 * definition automatically appears in the right group.
 */
export const ASSESSMENT_GROUPS: AssessmentGroup[] = (() => {
  const groups: Record<AssessmentGroupId, AssessmentGroup> = {
    homework: { id: 'homework', title: 'Homework', blocks: [] },
    cpw: { id: 'cpw', title: 'CPW', blocks: [] },
    attendance: { id: 'attendance', title: 'Attendance', blocks: [] },
    midterm: { id: 'midterm', title: 'Midterm', blocks: [] },
    akhlaaq: { id: 'akhlaaq', title: 'Akhlaaq', blocks: [] },
  };
  for (const block of ASSESSMENT_BLOCKS) {
    if (block.label.startsWith('HW')) groups.homework.blocks.push(block);
    else if (block.label.startsWith('CPW')) groups.cpw.blocks.push(block);
    else if (block.label === 'ATTENDANCE') groups.attendance.blocks.push(block);
    else if (block.label === 'MT') groups.midterm.blocks.push(block);
    else if (block.label === 'AKHLAAQ') groups.akhlaaq.blocks.push(block);
  }
  return [groups.homework, groups.cpw, groups.attendance, groups.midterm, groups.akhlaaq];
})();

/** Human-friendly display name for a block, e.g. "HW1", "Attendance", "MT". */
export function blockDisplayName(label: AssessmentLabel): string {
  if (label === 'ATTENDANCE') return 'Attendance';
  if (label === 'AKHLAAQ') return 'Akhlaaq';
  return label;
}

/**
 * Returns the requested blocks in the canonical sheet order, de-duplicated.
 * Used to normalize whatever order the teacher clicked the checkboxes in.
 */
export function orderBlocks(labels: Iterable<AssessmentLabel>): AssessmentBlock[] {
  const wanted = new Set(labels);
  return ASSESSMENT_BLOCKS.filter(block => wanted.has(block.label));
}
