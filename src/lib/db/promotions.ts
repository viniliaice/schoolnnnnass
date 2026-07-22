import { useState, useEffect } from 'react';
import { StudentPromotion, PromoteResult, getNextClass, type Student } from '../../types';
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

export async function undoPromotion(promotionIds: string[]): Promise<number> {
  if (promotionIds.length === 0) return 0;

  const { data: rows, error: fetchError } = await supabase
    .from('student_promotions')
    .select('"studentId", "fromClass"')
    .in('id', promotionIds);
  if (fetchError) throw fetchError;
  if (!rows || rows.length === 0) return 0;

  const updates = (rows as { studentId: string; fromClass: string }[]).map(r =>
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

  return rows.length;
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
