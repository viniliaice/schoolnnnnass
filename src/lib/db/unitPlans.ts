import { supabase } from '../supabase';
import type { UnitPlan, UnitPlanInput } from '../../types';

function newId(): string {
  return `unit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export async function fetchUnitPlansByTeacher(teacherId: string): Promise<UnitPlan[]> {
  const { data, error } = await supabase
    .from('unit_plans')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('week_number_start', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchAllUnitPlans(): Promise<UnitPlan[]> {
  const { data, error } = await supabase
    .from('unit_plans')
    .select('*')
    .order('week_number_start', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchUnitPlansByClass(className: string): Promise<UnitPlan[]> {
  const { data, error } = await supabase
    .from('unit_plans')
    .select('*')
    .eq('class_name', className)
    .order('week_number_start', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchUnitPlansByClassSubject(className: string, subjectId: string): Promise<UnitPlan[]> {
  const { data, error } = await supabase
    .from('unit_plans')
    .select('*')
    .eq('class_name', className)
    .eq('subject_id', subjectId)
    .order('week_number_start', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchUnitPlanById(id: string): Promise<UnitPlan | null> {
  const { data, error } = await supabase
    .from('unit_plans')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data;
}

export async function createUnitPlan(plan: UnitPlanInput & { teacher_id: string }): Promise<UnitPlan> {
  const id = newId();
  const { data, error } = await supabase
    .from('unit_plans')
    .insert({ id, ...plan })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUnitPlan(id: string, plan: Partial<UnitPlanInput>): Promise<UnitPlan> {
  const { data, error } = await supabase
    .from('unit_plans')
    .update(plan)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteUnitPlan(id: string): Promise<void> {
  const { error } = await supabase.from('unit_plans').delete().eq('id', id);
  if (error) throw error;
}
