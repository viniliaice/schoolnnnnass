#!/usr/bin/env node
// Full 282-group dry-run report for duplicate students.
// Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY or SUPABASE_URL/KEY.
// Run: node scripts/run-duplicate-dry-run.mjs [--json out.json]

import fs from 'node:fs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase env: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or SUPABASE_URL/KEY)');
  console.error('This script is intended to run against a real DB with the 282 duplicate groups.');
  console.error('For local PGlite tests, run: npm run test -- duplicateMerge');
  // Produce a placeholder report explaining the limitation
  const placeholder = {
    generatedAt: new Date().toISOString(),
    note: 'No live DB connection — placeholder report. Run with real Supabase env to get 282-group analysis.',
    totalGroups: 282,
    expectedCases: {
      axmed: { canonical: 'student-1774882609050-bqws0b', duplicate: 'student-1788799266378-r64ffp', expectedExamsAfter: '0 + 0 (no history)' },
      abshir: { canonical: 'student-1774350713663-0puj2e', duplicate: 'student-1788799266371-5mxvk1', expectedExamsAfter: '1 + 55 = 56' },
    },
    categories: {
      autoMergeable: 'Groups where 1 assigned + 1 unassigned, same name+class, no exam/attendance/quiz/release/report conflicts, enrollment open same class or canonical open only',
      examConflict: '2 known groups (to be identified by dry-run) — blocked due to same (subjectId, examType, assessmentLabel, termId) in both',
      enrollmentConflict: '282 overlaps — groups where open enrollments differ in class or academicYearId, handled via consolidate_duplicate_open or blocked if mismatch',
      otherConflict: 'Attendance same date, quiz same quizId, release same UTC date, report same term+examId',
      blocked: 'Any group not meeting 1 assigned +1 unassigned, or name/class mismatch, or multiple open enrollments',
    },
    instructions: 'Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-duplicate-dry-run.mjs --json report.json',
  };
  const outPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json')+1] : 'duplicate-dry-run-placeholder.json';
  fs.writeFileSync(outPath, JSON.stringify(placeholder, null, 2));
  console.log(`Wrote placeholder report to ${outPath}`);
  process.exit(0);
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('Listing duplicate groups...');
const { data: groups, error } = await supabase.rpc('list_duplicate_students');
if (error) {
  console.error('list_duplicate_students error', error);
  process.exit(1);
}
console.log(`Found ${groups.length} duplicate groups`);

let report = {
  generatedAt: new Date().toISOString(),
  totalGroups: groups.length,
  autoMergeable: [],
  examConflict: [],
  enrollmentConflict: [],
  otherConflict: [],
  blocked: [],
  details: [],
};

for (const g of groups) {
  const members = g.members || [];
  const assigned = members.filter(m => m.parentId);
  const unassigned = members.filter(m => !m.parentId);
  if (assigned.length !== 1 || unassigned.length !== 1) {
    report.blocked.push({ group: g, reason: `assigned=${assigned.length} unassigned=${unassigned.length}` });
    continue;
  }
  const canonical = assigned[0];
  const duplicate = unassigned[0];
  const { data: dry, error: dryErr } = await supabase.rpc('merge_duplicate_student', {
    p_canonical_id: canonical.id,
    p_duplicate_id: duplicate.id,
    p_dry_run: true,
  });
  if (dryErr) {
    console.error(`Dry-run error for ${canonical.id} / ${duplicate.id}`, dryErr);
    report.blocked.push({ group: g, canonical, duplicate, error: dryErr.message });
    continue;
  }
  const entry = { group: g, canonical, duplicate, dryRun: dry };
  report.details.push(entry);
  if (dry.can_merge) {
    report.autoMergeable.push(entry);
  } else {
    const conflicts = dry.conflicts || [];
    const hasExam = conflicts.some(c => c.type === 'EXAM_CONFLICT');
    const hasEnrollment = conflicts.some(c => c.type === 'enrollment_conflict');
    const hasOther = conflicts.some(c => ['ATTENDANCE_CONFLICT','QUIZ_CONFLICT','RELEASE_CONFLICT','REPORT_COMMENT_CONFLICT'].includes(c.type));
    if (hasExam) report.examConflict.push(entry);
    else if (hasEnrollment) report.enrollmentConflict.push(entry);
    else if (hasOther) report.otherConflict.push(entry);
    else report.blocked.push(entry);
  }
}

console.log(`\n=== Dry-run summary ===`);
console.log(`Total: ${report.totalGroups}`);
console.log(`Auto-mergeable: ${report.autoMergeable.length}`);
console.log(`Exam conflict: ${report.examConflict.length}`);
console.log(`Enrollment conflict: ${report.enrollmentConflict.length}`);
console.log(`Other conflict: ${report.otherConflict.length}`);
console.log(`Blocked/other: ${report.blocked.length}`);

const outJson = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json')+1] : null;
if (outJson) {
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${outJson}`);
} else {
  fs.writeFileSync('duplicate-dry-run-report.json', JSON.stringify(report, null, 2));
  console.log('Full report written to duplicate-dry-run-report.json');
}

// Also write markdown summary
let md = `# Duplicate Students Dry-Run Report\n\nGenerated: ${report.generatedAt}\n\n- Total groups: ${report.totalGroups}\n- Auto-mergeable: ${report.autoMergeable.length}\n- Exam conflict: ${report.examConflict.length}\n- Enrollment conflict: ${report.enrollmentConflict.length}\n- Other conflict: ${report.otherConflict.length}\n- Blocked: ${report.blocked.length}\n\n## Known cases\n\n- Axmed: canonical student-1774882609050-bqws0b, duplicate student-1788799266378-r64ffp — expected mergeable, enrollment_action consolidate_duplicate_open\n- Abshir: canonical student-1774350713663-0puj2e, duplicate student-1788799266371-5mxvk1 — expected 1+55=56 exams after merge\n\n## Auto-mergeable samples\n\n`;
for (const e of report.autoMergeable.slice(0,10)) {
  md += `- ${e.canonical.id} <- ${e.duplicate.id} (${e.group.display_name} ${e.group.display_class}) enrollment=${e.dryRun.enrollment_action?.type} exams=${e.dryRun.before_counts?.exams?.canonical}+${e.dryRun.before_counts?.exams?.duplicate}\n`;
}
md += `\n## Exam conflicts\n\n`;
for (const e of report.examConflict) {
  md += `- ${e.canonical.id} <- ${e.duplicate.id} conflicts=${JSON.stringify(e.dryRun.conflicts).slice(0,500)}\n`;
}
fs.writeFileSync('DUPLICATE_DRY_RUN_REPORT.md', md);
console.log('Markdown report written to DUPLICATE_DRY_RUN_REPORT.md');
