// INVESTIGATION REVIEW COPY ONLY. In-memory PostgreSQL; no network/client credentials.
// Reuses shipped migration harness; does not modify or deploy production functions.
import { extractStatementContaining } from '../bulk-grades/__tests__/pgHarness';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDuplicateBatchTestDb, seedProfile, seedStudent, seedEnrollment, readMigration, type PgDuplicateDb } from './pgDuplicateBatchHarness';
let db: PgDuplicateDb;
const uid = 'bbbbbbbb-0000-4000-8000-000000000001';
const resolution = (exams: unknown[] = []) => ({
  profile_resolution: {name:'canonical',class_name:'canonical',gov_id:'canonical',parent_id:'canonical',parent_phone:'canonical',transport:'canonical'},
  enrollment_resolution:{action:'consolidate',keep:'canonical'},
  exam_resolution:exams,attendance_resolution:[],quiz_resolution:[],release_resolution:[],report_comment_resolution:[],
});
beforeEach(async () => {
 db = await createDuplicateBatchTestDb();
 await seedProfile(db,'admin','admin','Synthetic admin',uid);
 await seedProfile(db,'parent','parent');
 await seedProfile(db,'teacher','teacher');
 await db.setAuthUid(uid);
 await db.exec(`INSERT INTO academic_years(id,name) VALUES('year','Synthetic year');
 INSERT INTO terms(id,name,"academicYearId","startDate","endDate") VALUES('term','Synthetic term','year','2026-08-01','2026-12-31');
 INSERT INTO subjects(id,name) VALUES('english','ENGLISH');
 ALTER TABLE exams ADD COLUMN "teacherId" text DEFAULT 'teacher';
 ALTER TABLE exams ADD COLUMN "entryState" text DEFAULT 'scored';
 ALTER TABLE profiles ADD COLUMN "assignedClasses" jsonb DEFAULT '[]';
 CREATE TABLE class_subjects(id text,"teacherId" text,"className" text,"subjectId" text);
 INSERT INTO class_subjects VALUES('assignment','teacher','Review class','english');
 CREATE FUNCTION class_students_for_term(p_class_name text,p_term_id text) RETURNS TABLE(student_id text)
 LANGUAGE sql STABLE AS $$
 WITH term AS(SELECT "startDate" sd,"endDate" ed FROM terms WHERE id=p_term_id),
 placed AS(SELECT DISTINCT e."studentId" sid FROM student_enrollments e,term t
 WHERE e."className"=p_class_name AND e."effectiveFrom"<=t.ed AND coalesce(e."effectiveTo",DATE '9999-12-31')>=t.sd)
 SELECT sid FROM placed UNION SELECT s.id FROM students s,term t WHERE s."className"=p_class_name AND NOT EXISTS(
 SELECT 1 FROM student_enrollments e WHERE e."studentId"=s.id AND e."effectiveFrom"<=t.ed AND coalesce(e."effectiveTo",DATE '9999-12-31')>=t.sd) $$;`);
 await db.exec(readMigration('20260919c_marks_monitor_homework_ca_tile.sql'));
 await db.exec(`ALTER TABLE terms ADD COLUMN months text[] DEFAULT '{}';
 ALTER TABLE exams ADD COLUMN "parentId" text;
 ALTER TABLE exams ADD COLUMN "uploadedBy" text;
 CREATE TABLE grade_uploads(id text PRIMARY KEY, "uploadedBy" text, payload_hash text, status text, result jsonb);
 CREATE UNIQUE INDEX exams_bulk_assessment_identity_unique ON exams("studentId","subjectId","examType","assessmentLabel","termId") WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL;`);
 await db.exec(extractStatementContaining(readMigration('20260911_half_point_scores.sql'),'FUNCTION public.submit_bulk_grades'));
 await db.exec(`CREATE FUNCTION enforce_exam_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
 CREATE TRIGGER enforce_exam_status_guard_trg BEFORE INSERT OR UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION enforce_exam_status_guard();`);
 await db.exec(readMigration('20261105000000_fix_monthly_assessment_identity.sql'));
 for(const id of ['keeper','old']) {
  await seedStudent(db,{id,name:'Synthetic same candidate',className:'Review class',parentId:id==='keeper'?'parent':null});
  await seedEnrollment(db,{id:`enrollment-${id}`,studentId:id,className:'Review class',academicYearId:'year',effectiveFrom:'2026-08-01'});
 }
});
afterEach(async()=>{await db?.close();});
async function mark(id:string,student:string,type:string,month='September',term='term') {
 await db.query(`INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,date,"createdAt")
 VALUES($1,$2,'english','ENGLISH',10,20,$3,'same-label',$4,$5,'2026-09-15','2026-10-10T10:00:00Z')`,[id,student,type,term,month]);
}
async function merge(exams:unknown[]=[]){return db.rpc('merge_duplicate_students_resolved',{p_canonical_id:'keeper',p_duplicate_id:'old',p_resolution:resolution(exams),p_reason:'Isolated synthetic review only'});}
async function monitor(){return (await db.query<Record<string,any>>(`SELECT expected_students,entered_students,homework_entered,classwork_entered,quiz_entered,percentage FROM monitor_marks_entries('year','term','monthly','September')`)).rows[0];}
it('month-aware merge preview and resolved merge preserve October and November',async()=>{
 await mark('october','keeper','Quiz','October');
 await mark('november','old','Quiz','November');
 const conflicts:any=await db.rpc('get_merge_conflicts',{p_canonical_id:'keeper',p_duplicate_id:'old'});
 expect(conflicts.exams).toHaveLength(0);
 await merge();
 expect((await db.query(`SELECT id,month,"studentId" FROM exams ORDER BY id`)).rows).toEqual([
 {id:'november',month:'November',studentId:'keeper'},{id:'october',month:'October',studentId:'keeper'}]);
});
it('cross-month losing-row resolution is rejected before it can delete an exam',async()=>{
 await mark('october','keeper','Quiz','October');await mark('november','old','Quiz','November');
 await expect(merge([{canonical_exam_id:'october',duplicate_exam_id:'november',keep:'duplicate'}])).rejects.toThrow();
 expect((await db.query(`SELECT * FROM exams`)).rows).toHaveLength(2);
});
