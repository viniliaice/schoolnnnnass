export { getTeacherExamProgress } from './progress';

import { getUserById } from './profiles';

export async function getSupervisorDashboardData(userId?: string) {
  const supervisor = userId ? await getUserById(userId) : null;
  const assignedClasses = supervisor?.assignedClasses || [];
  return { supervisor, assignedClasses };
}
