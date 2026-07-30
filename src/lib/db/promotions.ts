import { useState, useEffect } from 'react';
import { StudentPromotion, PromoteResult, getNextClass } from '../../types';
import { supabase } from '../supabase';

export { getNextClass };

export async function getPromotionHistory(academicYearId?: string): Promise<StudentPromotion[]> {
  let query = supabase
    .from('student_promotions')
    .select('*')
    .order('createdAt', { ascending: false });
  if (academicYearId) {
    query = query.eq('academicYearId', academicYearId);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as StudentPromotion[];
}

export async function promoteStudents(
  fromClass: string,
  toClass: string,
  academicYearId?: string
): Promise<PromoteResult[]> {
  const { data, error } = await supabase.rpc('promote_students', {
    from_class: fromClass,
    to_class: toClass,
    academic_year_id: academicYearId ?? null,
  });
  if (error) throw error;
  return (data || []) as PromoteResult[];
}

export interface PromoteAllResult {
  fromClass: string;
  toClass: string | 'Graduated';
  count: number;
}

export interface PromoteAllOutcome {
  promoted: PromoteAllResult[];
  failed: string[];
}

export async function promoteAllClasses(academicYearId?: string): Promise<PromoteAllOutcome> {
  // Guard: prevent re-running without undo
  if (academicYearId) {
    const { count, error: countError } = await supabase
      .from('student_promotions')
      .select('*', { count: 'exact', head: true })
      .eq('academicYearId', academicYearId);
    if (!countError && count && count > 0) {
      throw new Error(`Promotions already exist for this academic year (${count} records). Undo before re-running.`);
    }
  }

  const { data: students, error } = await supabase
    .from('students')
    .select('className');
  if (error) throw error;
  const classNames = [...new Set((students || []).map(s => s.className).filter(Boolean))] as string[];
  classNames.sort((a, b) => {
    const rank = (cn: string): number => {
      const m = cn.match(/^(Grade|Year)\s+(\d+)/i);
      if (m) return parseInt(m[2], 10);
      if (/^Foundation/i.test(cn)) return 0;
      if (/^KG-/i.test(cn)) return -1;
      return -999;
    };
    return rank(b) - rank(a);
  });

  const promoted: PromoteAllResult[] = [];
  const failed: string[] = [];

  for (const fromClass of classNames) {
    const next = getNextClass(fromClass);
    if (next === null && !fromClass.startsWith('Grade 12') && !fromClass.startsWith('Year 12')) continue;
    const toClass = next ?? 'Graduated';

    try {
      const result = await promoteStudents(fromClass, toClass, academicYearId);
      if (result.length > 0) {
        promoted.push({ fromClass, toClass, count: result.length });
      }
    } catch {
      failed.push(fromClass);
    }
  }

  return { promoted, failed };
}

export async function undoPromotion(promotionIds: string[]): Promise<number> {
  if (promotionIds.length === 0) return 0;

  const { data: rows, error: fetchError } = await supabase
    .from('student_promotions')
    .select('"studentId", "fromClass"')
    .in('id', promotionIds)
    .order('createdAt', { ascending: true });
  if (fetchError) throw fetchError;
  if (!rows || rows.length === 0) return 0;

  // Deduplicate by studentId — keep only the earliest fromClass
  // (prevents race condition when chained records exist for the same student)
  const seen = new Set<string>();
  const unique = (rows as { studentId: string; fromClass: string }[]).filter(r => {
    if (seen.has(r.studentId)) return false;
    seen.add(r.studentId);
    return true;
  });

  const updates = unique.map(r =>
    supabase.from('students').update({ className: r.fromClass }).eq('id', r.studentId)
  );
  const results = await Promise.all(updates);
  const errors = results.filter(r => r.error);
  if (errors.length > 0) throw errors[0].error;

  const { error: deleteError } = await supabase
    .from('student_promotions')
    .delete()
    .in('id', promotionIds);
  if (deleteError) throw deleteError;

  return unique.length;
}

export function usePromotionHistory(academicYearId?: string) {
  const [history, setHistory] = useState<StudentPromotion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getPromotionHistory(academicYearId)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [academicYearId]);

  return { history, loading, refetch: () => getPromotionHistory(academicYearId).then(setHistory) };
}
