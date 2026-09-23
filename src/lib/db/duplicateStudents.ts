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

// ── Guided resolution types ────────────────────────────────────────────────

export type ProfileFieldChoice = 'canonical' | 'duplicate' | 'remove';
export type HistoryKeepChoice = 'canonical' | 'duplicate';

export interface ProfileResolution {
  name?: ProfileFieldChoice;
  govId?: ProfileFieldChoice; // gov_id
  parentId?: ProfileFieldChoice; // parent
  parentPhone?: ProfileFieldChoice;
  transport?: ProfileFieldChoice;
  className?: ProfileFieldChoice; // class_name
  // allow aliases for camel/snake compat
  gov_id?: ProfileFieldChoice;
  parent_id?: ProfileFieldChoice;
  parent_phone?: ProfileFieldChoice;
  class_name?: ProfileFieldChoice;
}

export interface EnrollmentResolution {
  action: 'consolidate' | 'transfer' | 'preserve_history';
  keep?: 'canonical' | 'duplicate';
}

export interface ExamResolutionEntry {
  canonical_exam_id: string;
  duplicate_exam_id: string;
  keep: HistoryKeepChoice;
  // aliases
  canonicalExamId?: string;
  duplicateExamId?: string;
  canId?: string;
  dupId?: string;
}

export interface HistoryResolutionEntry {
  canonical_id: string;
  duplicate_id: string;
  keep: HistoryKeepChoice;
  // aliases
  canonicalId?: string;
  duplicateId?: string;
}

export interface MergeResolution {
  profile_resolution?: ProfileResolution;
  profileResolution?: ProfileResolution;
  exam_resolution?: ExamResolutionEntry[];
  examResolution?: ExamResolutionEntry[];
  attendance_resolution?: HistoryResolutionEntry[];
  attendanceResolution?: HistoryResolutionEntry[];
  quiz_resolution?: HistoryResolutionEntry[];
  quizResolution?: HistoryResolutionEntry[];
  release_resolution?: HistoryResolutionEntry[];
  releaseResolution?: HistoryResolutionEntry[];
  report_comment_resolution?: HistoryResolutionEntry[];
  reportCommentResolution?: HistoryResolutionEntry[];
  enrollment_resolution?: EnrollmentResolution;
  enrollmentResolution?: EnrollmentResolution;
}

export interface ExamConflict {
  identity: { subjectId: string | null; examType: string; assessmentLabel: string | null; termId: string | null; subject?: string };
  canonical: { id: string; score: number | null; total: number; status: string; createdAt: string; date: string; subjectId: string | null; examType: string; assessmentLabel: string | null; termId: string | null };
  duplicate: { id: string; score: number | null; total: number; status: string; createdAt: string; date: string; subjectId: string | null; examType: string; assessmentLabel: string | null; termId: string | null };
  identical?: boolean;
}

export interface MergeConflicts {
  profile: {
    govIdConflict: boolean;
    parentConflict: boolean;
    nameConflict: boolean;
    classConflict: boolean;
    transportConflict: boolean;
    phoneConflict: boolean;
    canonical: { id: string; name: string; className: string; govId: string | null; parentId: string | null; parentPhone: string | null; transport: string | null; familyId: string | null };
    duplicate: { id: string; name: string; className: string; govId: string | null; parentId: string | null; parentPhone: string | null; transport: string | null; familyId: string | null };
  };
  exams: ExamConflict[];
  attendance: Array<{ identity: { date: string }; canonical: { id: string; status: string; date: string }; duplicate: { id: string; status: string; date: string } }>;
  quizAttempts: Array<{ identity: { quizId: string }; canonical: { id: string; quizId: string }; duplicate: { id: string; quizId: string } }>;
  releaseLogs: Array<{ identity: { day: string }; canonical: { id: string; createdAt: string }; duplicate: { id: string; createdAt: string } }>;
  reportComments: Array<{ identity: { termId: string }; canonical: { id: string; termId: string }; duplicate: { id: string; termId: string } }>;
  enrollments: {
    canonicalOpen: { id: string; className: string; academicYearId: string | null; effectiveFrom: string } | null;
    duplicateOpen: { id: string; className: string; academicYearId: string | null; effectiveFrom: string } | null;
    canonicalHistory: number;
    duplicateHistory: number;
  };
  counts: { exams: number; attendance: number; quizAttempts: number; releaseLogs: number; reportComments: number };
}

export interface MergeChecklist {
  identityResolved: boolean;
  keepSelected: boolean;
  govIdResolved: boolean;
  parentResolved: boolean;
  profileResolved: boolean;
  enrollmentResolved: boolean;
  examsResolved: boolean;
  attendanceResolved: boolean;
  quizResolved: boolean;
  releaseResolved: boolean;
  reportResolved: boolean;
  allFieldsValid: boolean;
  noDuplicateGovId: boolean;
  noUnresolved: boolean;
  adminConfirmed: boolean;
  canMerge: boolean;
  blockedReasons: string[];
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

// ── Detailed conflict loader (lazy) ────────────────────────────────────────
export async function getMergeConflicts(canonicalId: string, duplicateId: string): Promise<MergeConflicts> {
  const { data, error } = await supabase.rpc('get_merge_conflicts', {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
  });
  if (error) throw new Error(error.message);
  return data as unknown as MergeConflicts;
}

// ── Guided merge with explicit resolution (transactional) ──────────────────
export async function mergeWithResolution(
  canonicalId: string,
  duplicateId: string,
  resolution: MergeResolution,
  reason?: string | null
): Promise<MergeResult & { resolution?: MergeResolution }> {
  // Try new RPC first
  let result = await supabase.rpc('merge_duplicate_students_resolved', {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
    p_resolution: resolution as unknown as Record<string, unknown>,
    p_reason: reason ?? null,
  });
  if (result.error && result.error.message?.includes('function')) {
    result = await supabase.rpc('merge_with_resolution', {
      p_canonical_id: canonicalId,
      p_duplicate_id: duplicateId,
      p_resolution: resolution as unknown as Record<string, unknown>,
      p_reason: reason ?? null,
    });
  }
  if (result.error) throw new Error(result.error.message);
  return result.data as unknown as MergeResult;
}

// ── Checklist helper ───────────────────────────────────────────────────────
export function buildMergeChecklist(
  preview: MergePreview | null,
  conflicts: MergeConflicts | null,
  keepSelection: 'A' | 'B' | null,
  profileRes: ProfileResolution | null,
  examRes: ExamResolutionEntry[],
  attRes: HistoryResolutionEntry[],
  quizRes: HistoryResolutionEntry[],
  relRes: HistoryResolutionEntry[],
  repRes: HistoryResolutionEntry[],
  enrRes: EnrollmentResolution | null,
  adminConfirmed: boolean,
  reason: string
): MergeChecklist {
  const blocked: string[] = [];
  if (!preview) blocked.push('preview_missing');
  const govConflict = preview?.conflicts.govConflict ?? false;
  const bothParents = preview?.conflicts.bothHaveParents ?? false;
  const sameGov = preview?.conflicts.sameGov ?? false;
  // Profile checks: gov, parent must be explicitly resolved if conflicting
  const govNeeds = govConflict || (conflicts?.profile.govIdConflict ?? false);
  const parentNeeds = bothParents || (conflicts?.profile.parentConflict ?? false);
  const govResolved = !govNeeds || !!(profileRes && (profileRes.govId || profileRes.gov_id));
  const parentResolved = !parentNeeds || !!(profileRes && (profileRes.parentId || profileRes.parent_id));
  const profileResolved = govResolved && parentResolved && !!profileRes;
  // Enrollment
  const enrollNeeds = preview ? (preview.enrollment.canMerge === false && preview.blockedReasons.includes('enrollment_conflict')) : false;
  const enrollmentResolved = !enrollNeeds || !!enrRes;
  // Exams etc
  const examsTotal = conflicts?.counts.exams ?? preview?.conflicts.examConflicts ?? 0;
  const attTotal = conflicts?.counts.attendance ?? preview?.conflicts.attendanceConflicts ?? 0;
  const quizTotal = conflicts?.counts.quizAttempts ?? preview?.conflicts.quizConflicts ?? 0;
  const relTotal = conflicts?.counts.releaseLogs ?? preview?.conflicts.releaseConflicts ?? 0;
  const repTotal = conflicts?.counts.reportComments ?? 0;
  const examsResolved = examsTotal === 0 || examRes.length === examsTotal;
  const attResolved = attTotal === 0 || attRes.length === attTotal;
  const quizResolved = quizTotal === 0 || quizRes.length === quizTotal;
  const relResolved = relTotal === 0 || relRes.length === relTotal;
  const repResolved = repTotal === 0 || repRes.length === repTotal;

  if (!keepSelection) blocked.push('keep_not_selected');
  if (govNeeds && !govResolved) blocked.push('gov_id_unresolved');
  if (parentNeeds && !parentResolved) blocked.push('parent_unresolved');
  if (!profileResolved) blocked.push('profile_unresolved');
  if (!enrollmentResolved) blocked.push('enrollment_unresolved');
  if (!examsResolved) blocked.push('exams_unresolved');
  if (!attResolved) blocked.push('attendance_unresolved');
  if (!quizResolved) blocked.push('quiz_unresolved');
  if (!relResolved) blocked.push('release_unresolved');
  if (!repResolved) blocked.push('report_unresolved');
  if (!adminConfirmed) blocked.push('not_confirmed');
  if (!reason.trim() && (govConflict || bothParents || examsTotal>0)) blocked.push('reason_required');

  const canMerge = blocked.length===0 && (preview?.canMerge || (examsTotal>0 || govNeeds || parentNeeds) ? profileResolved && examsResolved : true); // simplified: if resolvable, require resolution
  // More accurate: if preview says blocked due to resolvable conflicts but resolution provided, canMerge true
  const isResolvableBlocked = !!preview && !preview.canMerge && (preview.conflicts.examConflicts>0 || govConflict || bothParents);
  const finalCanMerge = blocked.length===0 && (!!preview?.canMerge || !!isResolvableBlocked);
  return {
    identityResolved: !!keepSelection,
    keepSelected: !!keepSelection,
    govIdResolved: govResolved,
    parentResolved: parentResolved,
    profileResolved,
    enrollmentResolved,
    examsResolved,
    attendanceResolved: attResolved,
    quizResolved,
    releaseResolved: relResolved,
    reportResolved: repResolved,
    allFieldsValid: !!keepSelection && !!profileRes,
    noDuplicateGovId: true, // validated server-side
    noUnresolved: blocked.length===0,
    adminConfirmed,
    canMerge: finalCanMerge,
    blockedReasons: blocked,
  };
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

// ── SAFE BATCH MERGE ("Merge All Safe Duplicates") ─────────────────────────
//
// Client wrappers ONLY. Every eligibility decision — which pair is safe, which
// record is the keeper, which fields survive, when to refuse — is made by the
// SECURITY DEFINER RPCs in supabase/migrations/20260925_safe_duplicate_batch.sql
// and re-made at execution time. Nothing in this file computes, filters, or
// overrides that verdict; the functions below transport requests and normalize
// the server's own JSON for rendering.

export type SafeBatchSeverity = 'blocked' | 'review';

export interface SafeBatchChunkConfig {
  default: number;
  min: number;
  max: number;
  atomicPerChunk: boolean;
}

export interface SafeBatchPolicy {
  policyId: string;
  version: number;
  nameEn: string;
  nameAr: string;
  keeperRuleEn: string;
  keeperRuleAr: string;
  keeperRule?: string;
  confirmPhrase: string;
  chunkSize: SafeBatchChunkConfig;
  requiredConditions?: string[];
  fieldResolutions?: Record<string, string>;
  exclusionCodes?: Record<string, string>;
  exclusionDescriptions?: Record<string, string>;
  blockedCodes?: string[];
  reuses?: string[];
  invariants: string[];
}

export interface SafeBatchStudentSide {
  id: string;
  name: string | null;
  className: string | null;
  govId: string | null;
  parentId: string | null;
  parentName: string | null;
  parentPhone: string | null;
  transport: string | null;
  familyId: string | null;
  createdAt: string | null;
}

export interface SafeBatchHistoryCounts {
  exams: { keeper: number; removed: number; conflicts: number };
  attendance: { keeper: number; removed: number; conflicts: number };
  homework: { keeper: number; removed: number };
  promotions: { keeper: number; removed: number };
  quizAttempts: { keeper: number; removed: number; conflicts: number };
  authorizedPickups: { keeper: number; removed: number };
  releaseLogs: { keeper: number; removed: number; conflicts: number };
  reportComments: { keeper: number; removed: number; conflicts: number };
  enrollments: { keeperOpen: number; removedOpen: number; keeperHistory: number; removedHistory: number };
  unhandledChildRows?: number;
  unhandledChildTables?: string[];
}

export interface SafeBatchPairEvaluation {
  pairKey: string;
  groupKey: string;
  groupSize: number;
  keeperId: string;
  removedId: string;
  studentName: string | null;
  className: string | null;
  eligible: boolean;
  severity: SafeBatchSeverity | null;
  exclusionCodes: string[];
  eligibilityCodes: string[];
  keeperIsParentAssigned: boolean;
  keeper: SafeBatchStudentSide;
  removed: SafeBatchStudentSide;
  parentName?: string | null;
  resolution: {
    summary: { govId: string; parentPhone: string; transport: string; enrollment: string };
    mergeResolution: MergeResolution;
  };
  enrollmentAction: 'consolidate' | 'transfer' | 'preserve_history' | null;
  history: SafeBatchHistoryCounts;
  fingerprint: string | null;
  evaluatedAt: string;
}

export interface SafeBatchExcludedRow {
  pairKey: string;
  keeperId: string;
  removedId: string;
  studentName: string | null;
  className: string | null;
  severity: SafeBatchSeverity;
  exclusionCodes: string[];
  exclusionReasons?: string[];
  reason?: string;
  codes?: string[];
  keeper?: SafeBatchStudentSide;
  removed?: SafeBatchStudentSide;
}

export interface SafeBatchSummary {
  candidatePairs: number;
  safeCount: number;
  excludedCount: number;
  blockedCount: number;
  needsReviewCount: number;
  studentsToMerge: number;
  recordsToRemove: number;
  studentIdsPreserved: number;
}

export interface SafeBatchReport {
  policy: SafeBatchPolicy;
  summary: SafeBatchSummary;
  exclusionReasons: Record<string, number>;
  rows: SafeBatchPairEvaluation[];
  excludedRows: SafeBatchExcludedRow[];
  paging: { limit: number; offset: number; includeExcluded: boolean };
  generatedAt: string;
  timings: { evaluateMs?: number; previewMs?: number };
}

export interface SafeBatchConfirmation {
  id: string;
  textEn: string;
  textAr: string;
}

export interface SafeBatchPreview extends SafeBatchReport {
  dryRun: boolean;
  writesPerformed: number;
  batchId: string;
  previewToken: string;
  ready: { studentsToMerge: number; recordsToBeRemoved: number; studentIdsPreserved: number };
  chunkPlan: { chunkSize: number; chunks: number; atomicPerChunk: boolean; strategy?: string };
  confirmations?: SafeBatchConfirmation[];
  assertions: Record<string, boolean>;
  confirmPhrase: string;
}

/** The advisory reviewed list the UI sends back. It can only NARROW the batch:
 *  the server recomputes eligibility and refuses anything it does not consider
 *  safe, including pairs the client invents. */
export interface SafeBatchReviewedPair {
  keeperId: string;
  removedId: string;
  fingerprint?: string | null;
  pairKey?: string;
}

export interface SafeBatchMergedEntry {
  pairKey: string;
  keeperId: string;
  removedId: string;
  studentName: string | null;
  className: string | null;
  auditId: string | null;
  preservedStudentId: string;
  removedStudentId: string;
  enrollmentAction: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface SafeBatchSkippedEntry {
  pairKey: string;
  keeperId?: string;
  removedId?: string;
  studentName?: string | null;
  className?: string | null;
  reason: string;
  codes: string[];
}

export interface SafeBatchBlockedEntry extends SafeBatchSkippedEntry {
  severity?: SafeBatchSeverity | null;
  exclusionCodes?: string[];
}

export interface SafeBatchChunkResult {
  batchId: string;
  adminId: string;
  policy: string;
  policyDetail?: SafeBatchPolicy;
  chunkSize: number;
  atomicChunk: boolean;
  committed: boolean;
  merged: SafeBatchMergedEntry[];
  skipped: SafeBatchSkippedEntry[];
  blocked: SafeBatchBlockedEntry[];
  failed: unknown[];
  totals: {
    eligibleAtStart: number;
    examined: number;
    merged: number;
    skipped: number;
    blocked: number;
    failed: number;
    remaining: number;
  };
  invariants?: string[];
  durationMs: number;
  startedAt?: string;
  completedAt?: string;
}

export async function getSafeDuplicateBatch(options?: {
  limit?: number;
  offset?: number;
  includeExcluded?: boolean;
}): Promise<SafeBatchReport> {
  const { data, error } = await supabase.rpc('get_safe_duplicate_batch', {
    p_limit: options?.limit ?? 200,
    p_offset: options?.offset ?? 0,
    p_include_excluded: options?.includeExcluded ?? true,
  });
  if (error) throw new Error(error.message);
  return data as unknown as SafeBatchReport;
}

export async function previewSafeDuplicateBatch(limit = 500): Promise<SafeBatchPreview> {
  const { data, error } = await supabase.rpc('preview_safe_duplicate_batch', { p_limit: limit });
  if (error) throw new Error(error.message);
  return data as unknown as SafeBatchPreview;
}

/** Maps the server's own preview rows into the advisory list it accepts back.
 *  Pure transport — the fingerprint is what the administrator actually saw. */
export function reviewedPairsFromPreview(preview: SafeBatchPreview | null): SafeBatchReviewedPair[] {
  if (!preview || !Array.isArray(preview.rows)) return [];
  return preview.rows.map((row) => ({
    keeperId: row.keeperId,
    removedId: row.removedId,
    fingerprint: row.fingerprint ?? null,
    pairKey: row.pairKey,
  }));
}

/** Runs ONE chunk. The server recomputes eligibility, locks, revalidates the
 *  fingerprint, merges through the individual merge RPC and audits each pair. */
export async function runSafeDuplicateBatchChunk(args: {
  reviewedPairs: SafeBatchReviewedPair[];
  chunkSize?: number;
  confirmPhrase: string;
  reason?: string | null;
  batchId?: string | null;
}): Promise<SafeBatchChunkResult> {
  const { data, error } = await supabase.rpc('merge_safe_duplicate_batch', {
    p_pairs: args.reviewedPairs as unknown as Record<string, unknown>[],
    p_chunk_size: args.chunkSize ?? 25,
    p_confirm_phrase: args.confirmPhrase,
    p_reason: args.reason ?? null,
    p_batch_id: args.batchId ?? null,
  });
  if (error) throw new Error(error.message);
  return data as unknown as SafeBatchChunkResult;
}
