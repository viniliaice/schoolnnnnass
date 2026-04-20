export { getTeacherExamProgress } from './progress';

import { getUserById as legacyGetUserById } from '../database';
import { User } from '../../types';

export async function getUserById(id: string): Promise<User | undefined> {
  return legacyGetUserById(id);
}

export async function getSupervisorDashboardData(userId?: string) {
  const supervisor = userId ? await getUserById(userId) : undefined;
  const assignedClasses = supervisor?.assignedClasses || [];
  return { supervisor, assignedClasses };
}

// Note: only supervisor-related wrappers are exported here to keep the
// incremental migration scoped. The legacy `src/lib/database.ts` remains
// the source of truth and is not re-exported broadly from this file.
