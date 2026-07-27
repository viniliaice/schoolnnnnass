import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRole } from '../../context/RoleContext';
import type { UnitPlanInput } from '../../types';
import * as unitPlansDb from '../db/unitPlans';

export function useUnitPlans() {
  const { session } = useRole();
  const isSupervisor = session?.role === 'supervisor';
  const isAdmin = session?.role === 'admin';

  return useQuery({
    queryKey: ['unitPlans', session?.userId],
    queryFn: () => {
      if (!session?.userId) return [];
      if (isSupervisor || isAdmin) return unitPlansDb.fetchAllUnitPlans();
      return unitPlansDb.fetchUnitPlansByTeacher(session.userId);
    },
    enabled: !!session?.userId,
  });
}

export function useUnitPlansByClass(className: string | null) {
  return useQuery({
    queryKey: ['unitPlans', 'class', className],
    queryFn: () => {
      if (!className) return [];
      return unitPlansDb.fetchUnitPlansByClass(className);
    },
    enabled: !!className,
  });
}

export function useUnitPlansByClassSubject(className: string | null, subjectId: string | null) {
  return useQuery({
    queryKey: ['unitPlans', 'classSubject', className, subjectId],
    queryFn: () => {
      if (!className || !subjectId) return [];
      return unitPlansDb.fetchUnitPlansByClassSubject(className, subjectId);
    },
    enabled: !!className && !!subjectId,
  });
}

export function useUnitPlan(id: string | null) {
  return useQuery({
    queryKey: ['unitPlan', id],
    queryFn: () => {
      if (!id) return null;
      return unitPlansDb.fetchUnitPlanById(id);
    },
    enabled: !!id,
  });
}

export function useCreateUnitPlan() {
  const queryClient = useQueryClient();
  const { session } = useRole();

  return useMutation({
    mutationFn: (input: UnitPlanInput) => {
      if (!session?.userId) throw new Error('Not authenticated');
      return unitPlansDb.createUnitPlan({ ...input, teacher_id: session.userId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unitPlans'] });
    },
  });
}

export function useUpdateUnitPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<UnitPlanInput> }) =>
      unitPlansDb.updateUnitPlan(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unitPlans'] });
      queryClient.invalidateQueries({ queryKey: ['unitPlan'] });
    },
  });
}

export function useDeleteUnitPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => unitPlansDb.deleteUnitPlan(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unitPlans'] });
    },
  });
}
