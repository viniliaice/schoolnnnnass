// "Teacher comments" block for parent report tabs.
//
// Report comments (report_comments table) used to be hard to find — the
// midterm page fetched them and never rendered them. Every report tab now
// shows the term's teacher (and principal) comments in the same simple card.

import { MessageSquareText } from 'lucide-react';

export interface ReportCommentLike {
  teacherComment?: string | null;
  principalComment?: string | null;
}

export function TeacherCommentsCard({ comments }: { comments: ReportCommentLike[] }) {
  const teacher = comments.map(c => c.teacherComment?.trim()).filter((c): c is string => Boolean(c));
  const principal = comments.map(c => c.principalComment?.trim()).filter((c): c is string => Boolean(c));
  if (teacher.length === 0 && principal.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5" data-testid="teacher-comments">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
        <MessageSquareText className="h-4 w-4 text-indigo-600" aria-hidden="true" />
        Teacher comments
      </h3>
      <ul className="mt-3 space-y-2">
        {teacher.map((comment, i) => (
          <li key={`t-${i}`} className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm leading-relaxed text-slate-700">
            {comment}
          </li>
        ))}
        {principal.map((comment, i) => (
          <li key={`p-${i}`} className="rounded-xl bg-indigo-50 px-3.5 py-2.5 text-sm leading-relaxed text-indigo-800">
            <span className="font-semibold">Principal: </span>
            {comment}
          </li>
        ))}
      </ul>
    </div>
  );
}
