/**
 * Hand-off for opening a specific lesson plan in the Lesson Plan Review page.
 *
 * The app's navigation is path-based with no router or query strings, so a
 * "View" action on another page cannot address a plan through the URL. This
 * tiny module is that hand-off: the sender parks the plan id, navigates to
 * the review route, and the review page consumes (and clears) it on mount —
 * selecting the plan and aligning its week selector with the plan's stored
 * week. Nothing persists: a consumed or abandoned link is simply gone.
 *
 * `teacherName` is a display fallback: a revision_requested plan is not part
 * of the review page's week list (where the name normally comes from), so
 * the sender passes the name it already has.
 */

export interface LessonPlanDeepLink {
  planId: string;
  teacherName?: string;
}

let pendingLink: LessonPlanDeepLink | null = null;

/** Park a plan for the review page to open on its next mount. */
export function setPendingLessonPlanReview(planId: string, teacherName?: string): void {
  pendingLink = { planId, teacherName };
}

/** Take (and clear) the parked plan id. Returns null when nothing is pending. */
export function takePendingLessonPlanReview(): LessonPlanDeepLink | null {
  const link = pendingLink;
  pendingLink = null;
  return link;
}
