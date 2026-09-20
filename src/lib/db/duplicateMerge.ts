import { supabase } from '../supabase';

export interface DuplicateGroupMember {
  id: string;
  name: string;
  className: string;
  parentId: string | null;
}

export interface DuplicateGroup {
  name_key: string;
  class_key: string;
  display_name: string;
  display_class: string;
  total: number;
  assigned_count: number;
  unassigned_count: number;
  members: DuplicateGroupMember[];
}

export interface MergeDependentCounts {
  canonical: number;
  duplicate: number;
}

export interface MergeBeforeCounts {
  exams: MergeDependentCounts;
  attendance: MergeDependentCounts;
  homework: MergeDependentCounts;
  enrollments: MergeDependentCounts;
  promotions: MergeDependentCounts;
  quiz_attempts: MergeDependentCounts;
  authorized_pickup_students: MergeDependentCounts;
  release_log: MergeDependentCounts;
  report_comments: MergeDependentCounts;
}

export interface MergeResult {
  can_merge: boolean;
  canonical_student_id: string;
  duplicate_student_id: string;
  student_name: string;
  class_name: string;
  canonical_parent_id?: string | null;
  duplicate_parent_id?: string | null;
  dependent_counts?: MergeBeforeCounts;
  before_counts?: MergeBeforeCounts;
  after_counts?: MergeBeforeCounts;
  actions?: Record<string, number>;
  enrollment_action?: Record<string, any>;
  conflicts?: any[];
  reason?: string;
  audit_id?: string;
  dry_run: boolean;
}

export interface DuplicateDetails {
  canonical: { id: string; name: string; className: string; parentId: string | null };
  duplicate: { id: string; name: string; className: string; parentId: string | null };
  counts: {
    canonical: Record<string, number>;
    duplicate: Record<string, number>;
  };
  dry_run: MergeResult;
}

export async function listDuplicateStudents(): Promise<DuplicateGroup[]> {
  const { data, error } = await supabase.rpc('list_duplicate_students');
  if (error) throw new Error(error.message);
  return (data as DuplicateGroup[]) || [];
}

export async function getDuplicateStudentDetails(canonicalId: string, duplicateId: string): Promise<DuplicateDetails> {
  const { data, error } = await supabase.rpc('get_duplicate_student_details', {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
  });
  if (error) throw new Error(error.message);
  return data as DuplicateDetails;
}

export async function mergeDuplicateStudent(
  canonicalId: string,
  duplicateId: string,
  dryRun: boolean = true,
  reason?: string | null,
  source: string = 'admin_ui'
): Promise<MergeResult> {
  const { data, error } = await supabase.rpc('merge_duplicate_student', {
    p_canonical_id: canonicalId,
    p_duplicate_id: duplicateId,
    p_dry_run: dryRun,
    p_reason: reason ?? null,
    p_source: source,
  });
  if (error) throw new Error(error.message);
  return data as MergeResult;
}

export interface DryRunReport {
  totalGroups: number;
  autoMergeable: number;
  examConflict: number;
  enrollmentConflict: number;
  otherConflict: number;
  blocked: number;
  details: MergeResult[];
  groups: DuplicateGroup[];
}

export async function runFullDuplicateDryRun(): Promise<DryRunReport> {
  const groups = await listDuplicateStudents();
  const details: MergeResult[] = [];
  let autoMergeable = 0;
  let examConflict = 0;
  let enrollmentConflict = 0;
  let otherConflict = 0;
  let blocked = 0;

  for (const g of groups) {
    // Expect exactly 2 members, one assigned, one unassigned
    const assigned = g.members.filter(m => m.parentId);
    const unassigned = g.members.filter(m => !m.parentId);
    if (assigned.length !== 1 || unassigned.length !== 1) {
      // Not the targeted pattern, count as blocked
      blocked++;
      continue;
    }
    const canonical = assigned[0];
    const duplicate = unassigned[0];
    try {
      const res = await mergeDuplicateStudent(canonical.id, duplicate.id, true, 'dry-run full scan', 'dry_run_report');
      details.push(res);
      if (res.can_merge) {
        autoMergeable++;
      } else {
        const hasExam = res.conflicts?.some((c: any) => c.type === 'EXAM_CONFLICT');
        const hasEnrollment = res.conflicts?.some((c: any) => c.type === 'enrollment_conflict' || c.type === 'multiple_open_enrollments');
        if (hasExam) examConflict++;
        else if (hasEnrollment) enrollmentConflict++;
        else {
          otherConflict++;
        }
        blocked++;
      }
    } catch (e) {
      // Treat error as blocked
      blocked++;
      details.push({
        can_merge: false,
        canonical_student_id: canonical.id,
        duplicate_student_id: duplicate.id,
        student_name: g.display_name,
        class_name: g.display_class,
        conflicts: [{ type: 'error', message: e instanceof Error ? e.message : String(e) }],
        dry_run: true,
      } as MergeResult);
    }
  }

  return {
    totalGroups: groups.length,
    autoMergeable,
    examConflict,
    enrollmentConflict,
    otherConflict,
    blocked,
    details,
    groups,
  };
}
