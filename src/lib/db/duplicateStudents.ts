// Duplicate Students — client side detection + merge RPC wrappers.
//
// Candidate detector: normalized name + current class (as required by spec).
// That is ONLY a candidate signal; the preview/merge RPCs enforce strong-
// identity checks (Gov ID, parents, exam collisions, enrollments).

import { supabase } from '../supabase';
import type { Student } from '../../types';
import { getStudents } from './students';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DuplicatePair {
  id: string;
  groupKey: string;
  className: string;
  normalizedName: string;
  studentA: Student;
  studentB: Student;
  // Parent names where available (filled on demand)
  parentNameA?: string | null;
  parentNameB?: string | null;
}

export interface DuplicateGroup {
  groupKey: string;
  className: string;
  normalizedName: string;
  students: Student[];
  pairs: DuplicatePair[];
}

export type EvidenceStrength = 'strong' | 'possible' | 'conflicting';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PairEvaluation {
  evidence: EvidenceStrength;
  risk: RiskLevel;
  canMergeLocal: boolean; // before exam check
  blockedReasons: string[];
  evidenceSummary: string[];
  recommendation: { keep: 'A' | 'B'; reasons: string[] };
  isHighConfidence: boolean;
  isBlocked: boolean;
  isParentVsUnassigned: boolean;
  hasGovId: boolean;
  hasSameGov: boolean;
  hasConflictingGov: boolean;
  bothHaveParents: boolean;
}

export interface MergePreview {
  canonical: Student & { parentId: string | null };
  duplicate: Student & { parentId: string | null };
  counts: {
    exams: { canonical: number; duplicate: number; conflicts: number };
    attendance: { canonical: number; duplicate: number; conflicts: number };
    homework: { canonical: number; duplicate: number };
    promotions: { canonical: number; duplicate: number };
    quizAttempts: { canonical: number; duplicate: number; conflicts: number };
    authorizedPickups: { canonical: number; duplicate: number };
    releaseLogs: { canonical: number; duplicate: number; conflicts: number };
    reportComments: { canonical: number; duplicate: number };
    enrollments: {
      canonicalOpen: { className: string; academicYearId: string } | null;
      duplicateOpen: { className: string; academicYearId: string } | null;
      canonicalHistory: number;
      duplicateHistory: number;
    };
  };
  enrollment: {
    canonicalOpen: { className: string; academicYearId: string } | null;
    duplicateOpen: { className: string; academicYearId: string } | null;
    action: string;
    willConsolidate: boolean;
    canMerge: boolean;
  };
  conflicts: {
    examConflicts: number;
    attendanceConflicts: number;
    quizConflicts: number;
    releaseConflicts: number;
    govConflict: boolean;
    bothHaveParents: boolean;
    sameGov: boolean;
  };
  canMerge: boolean;
  blockedReasons: string[];
  riskLevel: RiskLevel;
  evidence: EvidenceStrength;
}

export interface MergeResult {
  auditId: string;
  canonicalId: string;
  duplicateId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  enrollmentAction: Record<string, unknown>;
  createdAt: string;
}

export interface MergeAudit {
  id: string;
  canonical_id: string;
  duplicate_id: string;
  admin_id: string | null;
  reason: string | null;
  before_counts: Record<string, unknown>;
  after_counts: Record<string, unknown>;
  enrollment_action: Record<string, unknown>;
  created_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function normalizeNameForDuplicate(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

export function govKeyLoose(gov: string | null | undefined): string {
  if (!gov) return '';
  return gov.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
}

export function evaluatePair(a: Student, b: Student): PairEvaluation {
  const aGov = (a.govId || '').trim();
  const bGov = (b.govId || '').trim();
  const aHasGov = aGov !== '';
  const bHasGov = bGov !== '';
  const aGovKey = govKeyLoose(aGov);
  const bGovKey = govKeyLoose(bGov);
  const sameGov = aHasGov && bHasGov && aGovKey !== '' && aGovKey === bGovKey;
  const conflictingGov = aHasGov && bHasGov && aGovKey !== '' && bGovKey !== '' && aGovKey !== bGovKey;
  const aHasParent = !!a.parentId;
  const bHasParent = !!b.parentId;
  const bothHaveParents = aHasParent && bHasParent;
  const oneHasParent = aHasParent !== bHasParent;
  const isParentVsUnassigned = oneHasParent;
  const hasGovId = aHasGov || bHasGov;

  let evidence: EvidenceStrength = 'possible';
  let risk: RiskLevel = 'high';
  let canMergeLocal = true;
  const blockedReasons: string[] = [];
  const evidenceSummary: string[] = [];

  // Base signals
  evidenceSummary.push('✓ Same normalized name');
  evidenceSummary.push('✓ Same class');

  if (conflictingGov) {
    evidence = 'conflicting';
    risk = 'critical';
    canMergeLocal = false;
    blockedReasons.push('gov_id_conflict');
    evidenceSummary.push('✗ Different Government IDs (' + aGov + ' vs ' + bGov + ')');
  } else if (sameGov) {
    evidence = 'strong';
    risk = 'low';
    evidenceSummary.push('✓ Same Government ID — strong identity signal');
    if (aHasParent && bHasParent) {
      // both have parents but same gov is still strong, not blocking (though still high-risk)
      evidenceSummary.push('! Both have parents but shared Gov ID supports merge after review');
    } else if (oneHasParent) {
      evidenceSummary.push('✓ One parent assigned, one unassigned');
    }
  } else if (bothHaveParents && !sameGov) {
    evidence = 'conflicting';
    risk = 'critical';
    canMergeLocal = false;
    blockedReasons.push('both_have_parents');
    evidenceSummary.push('✗ Both records have different parents');
    if (aHasGov || bHasGov) {
      evidenceSummary.push('✗ No shared Gov ID to resolve parent conflict');
    } else {
      evidenceSummary.push('✗ No Gov ID to disambiguate');
    }
  } else if (oneHasParent) {
    // Parent assigned vs unassigned — high confidence
    evidence = 'strong';
    risk = 'low';
    evidenceSummary.push(oneHasParent ? '✓ One record has parent assigned, other is unassigned' : '');
    if (aHasGov || bHasGov) {
      if ((aHasParent && aHasGov) || (bHasParent && bHasGov)) {
        evidenceSummary.push('✓ Parent-assigned record also has Gov ID');
      } else if (( !aHasParent && aHasGov) || (!bHasParent && bHasGov)) {
        evidenceSummary.push('! Unassigned record contains a Gov ID — confirm which identity is correct before merging');
        risk = 'high';
        evidence = 'possible';
      } else {
        evidenceSummary.push('✓ No conflicting Gov ID');
      }
    } else {
      evidenceSummary.push('! No Gov ID present');
      // Still strong per Axmed case
    }
  } else {
    // Neither has parent
    evidence = 'possible';
    risk = 'high';
    evidenceSummary.push('! Neither record has a parent assigned');
    if (aHasGov || bHasGov) {
      if (aHasGov && bHasGov) {
        // both have gov but not same (conflicting already handled) — this branch would be not conflicting?
        // If both have gov and not same nor conflicting? impossible
      } else {
        evidenceSummary.push('! One record has a Gov ID — review which identity is correct');
      }
    } else {
      evidenceSummary.push('! No Gov ID on either record');
    }
  }

  // Recommendation
  let keep: 'A' | 'B' = 'A';
  const reasons: string[] = [];
  // Score each side
  let scoreA = 0;
  let scoreB = 0;
  if (aHasParent) { scoreA += 3; } else { scoreA += 0; }
  if (bHasParent) { scoreB += 3; }
  if (aHasGov) { scoreA += 3; }
  if (bHasGov) { scoreB += 3; }
  // Older record preferred (stable)
  const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (aTime && bTime && aTime < bTime) { scoreA += 1; } else if (bTime && aTime && bTime < aTime) { scoreB += 1; }
  // If scores equal, prefer A (older typically)
  if (scoreB > scoreA) {
    keep = 'B';
  } else {
    keep = 'A';
  }
  const keeper = keep === 'A' ? a : b;
  const other = keep === 'A' ? b : a;
  if (keeper.parentId) reasons.push('Parent assigned');
  if (keeper.govId) reasons.push('Gov ID present');
  if ((keep === 'A' && aTime < bTime) || (keep === 'B' && bTime < aTime)) reasons.push('Older established record');
  if (!other.parentId && keeper.parentId) reasons.push('Other record is unassigned');

  const isBlocked = !canMergeLocal;
  const isHighConfidence = evidence === 'strong' && risk === 'low' && canMergeLocal;

  return {
    evidence,
    risk,
    canMergeLocal,
    blockedReasons,
    evidenceSummary: evidenceSummary.filter(Boolean),
    recommendation: { keep, reasons },
    isHighConfidence,
    isBlocked,
    isParentVsUnassigned,
    hasGovId,
    hasSameGov: sameGov,
    hasConflictingGov: conflictingGov,
    bothHaveParents,
  };
}

// ── Fetch & Group ───────────────────────────────────────────────────────────

export async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  // Try server function first (fast, no pagination limits), fallback to client grouping.
  try {
    const { data, error } = await supabase.rpc('get_duplicate_candidates');
    if (!error && Array.isArray(data) && data.length > 0) {
      // Server returns group_key, student_ids, class_name, member_count — need to hydrate students.
      const ids = (data as Array<{ student_ids: string[] }>).flatMap(g => g.student_ids);
      if (ids.length > 0) {
        // Fetch those students in one batch via paginated fetch then filter.
        const all = await getStudents(10000);
        const byId = new Map(all.map(s => [s.id, s]));
        const groups: DuplicateGroup[] = [];
        for (const row of data as Array<{ group_key: string; student_ids: string[]; class_name: string }>) {
          const members = row.student_ids.map(id => byId.get(id)).filter(Boolean) as Student[];
          if (members.length < 2) continue;
          const normalizedName = normalizeNameForDuplicate(members[0].name);
          const pairs: DuplicatePair[] = [];
          for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
              const a = members[i]; const b = members[j];
              pairs.push({
                id: `${a.id}__${b.id}`,
                groupKey: row.group_key,
                className: row.class_name,
                normalizedName,
                studentA: a,
                studentB: b,
              });
            }
          }
          // For >2 members, we emit a single manual-review group (no pairwise explosion in UI table)
          // but keep pairs for count; the table will show the group as one row.
          groups.push({
            groupKey: row.group_key,
            className: row.class_name,
            normalizedName,
            students: members,
            pairs,
          });
        }
        if (groups.length > 0) return groups;
      }
    }
  } catch {
    // fall through to client grouping
  }

  // Client grouping: fetch all students (paginated) and group by normalized name + class
  const students = await getStudents(10000);
  const map = new Map<string, Student[]>();
  for (const s of students) {
    const key = `${normalizeNameForDuplicate(s.name)}|${s.className}`;
    const arr = map.get(key) || [];
    arr.push(s);
    map.set(key, arr);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, members] of map.entries()) {
    if (members.length < 2) continue;
    const [normalizedName, className] = key.split('|');
    const pairs: DuplicatePair[] = [];
    // Sort by createdAt so A is older
    members.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.push({
          id: `${members[i].id}__${members[j].id}`,
          groupKey: key,
          className: members[j].className,
          normalizedName,
          studentA: members[i],
          studentB: members[j],
        });
      }
    }
    groups.push({
      groupKey: key,
      className: members[0].className,
      normalizedName,
      students: members,
      pairs,
    });
  }
  // Sort groups by class then name
  groups.sort((a, b) => a.className.localeCompare(b.className) || a.normalizedName.localeCompare(b.normalizedName));
  return groups;
}

// ── Preview & Merge RPCs ────────────────────────────────────────────────────

export async function previewStudentMerge(canonicalId: string, duplicateId: string): Promise<MergePreview> {
  const { data, error } = await supabase.rpc('preview_student_merge', {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
  });
  if (error) throw new Error(error.message);
  // Supabase may return JSONB as object already
  const raw = data as Record<string, unknown>;
  // Normalize shape: RPC returns jsonb with keys canonical, duplicate, counts, etc.
  return raw as unknown as MergePreview;
}

export async function mergeDuplicateStudents(canonicalId: string, duplicateId: string, reason?: string | null): Promise<MergeResult> {
  // Try canonical named function first, fallback to alias
  let rpcName = 'merge_duplicate_students';
  let result = await supabase.rpc(rpcName, {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
    p_reason: reason ?? null,
  });
  if (result.error && result.error.message?.includes('function') ) {
    rpcName = 'merge_students';
    result = await supabase.rpc(rpcName, {
      p_canonical_id: canonicalId,
      p_duplicate_id: duplicateId,
      p_reason: reason ?? null,
    });
  }
  if (result.error) throw new Error(result.error.message);
  return result.data as unknown as MergeResult;
}

export async function getMergeAudits(limit = 50): Promise<MergeAudit[]> {
  const { data, error } = await supabase
    .from('student_merge_audits')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []) as unknown as MergeAudit[];
}

// Light wrapper for verifying after merge (client side)
export async function verifyMerge(canonicalId: string, duplicateId: string): Promise<{ canonicalExists: boolean; duplicateExists: boolean; duplicateHasNoChildren: boolean }> {
  const { data: can } = await supabase.from('students').select('id').eq('id', canonicalId).maybeSingle();
  const { data: dup } = await supabase.from('students').select('id').eq('id', duplicateId).maybeSingle();
  let duplicateHasNoChildren = true;
  if (dup) {
    const checks = await Promise.all([
      supabase.from('exams').select('id', { count: 'exact', head: true }).eq('studentId', duplicateId),
      supabase.from('attendance').select('id', { count: 'exact', head: true }).eq('studentId', duplicateId),
      supabase.from('homework').select('id', { count: 'exact', head: true }).eq('studentId', duplicateId),
      supabase.from('student_promotions').select('id', { count: 'exact', head: true }).eq('studentId', duplicateId),
      supabase.from('quiz_attempts').select('id', { count: 'exact', head: true }).eq('studentId', duplicateId),
    ]);
    for (const c of checks) {
      if ((c as { count?: number }).count && (c as { count?: number }).count! > 0) {
        duplicateHasNoChildren = false;
        break;
      }
    }
  }
  return {
    canonicalExists: !!can,
    duplicateExists: !!dup,
    duplicateHasNoChildren,
  };
}
