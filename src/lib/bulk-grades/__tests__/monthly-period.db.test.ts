// Actual migration/RPC behavioral tests. Synthetic data, in-memory PostgreSQL only.
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { createBulkGradesTestDb, extractStatementContaining, readMigration, type PgTestDb } from './pgHarness';
let db: PgTestDb;
const uid='11111111-1111-1111-1111-111111111111';
let seq=0;
const months=['August','September','October','November'];
const record=(month='October', extra:Record<string,unknown>={})=>({studentId:'fictional-1',subjectId:'english',examType:'Homework',assessmentLabel:'HW1',score:4,total:5,entryState:'scored',month,date:`2026-${String(months.indexOf(month)+8).padStart(2,'0')}-02`,termId:'term-2026',...extra});
async function rpc(records:unknown[],key:string,confirm=false){return (await db.query<{result:any}>('SELECT submit_bulk_grades($1::jsonb,$2,$3) result',[JSON.stringify(records),key,confirm])).rows[0].result;}
async function upload(records:unknown[], key=`synthetic-upload-${++seq}`){await rpc(records,key);return rpc(records,key,true);}
async function rows(){return (await db.query('SELECT "studentId","subjectId","assessmentLabel","termId",month,score::text,status FROM exams ORDER BY month,"assessmentLabel"')).rows;}
beforeAll(async()=>{
 db=await createBulkGradesTestDb({includeGradeCorrection:true,includeHalfPoints:true,includeStatusGuard:true});
 await db.exec(`INSERT INTO auth.users VALUES('${uid}'); INSERT INTO profiles(id,name,email,role,auth_id) VALUES('teacher','Synthetic teacher','synthetic@example.invalid','teacher','${uid}');
 INSERT INTO subjects(id,name) VALUES('english','English'),('math','Math');
 INSERT INTO students(id,name,"className") VALUES('fictional-1','Synthetic one','Review class'),('fictional-2','Synthetic two','Review class');
 INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES('a','Review class','english','teacher'),('b','Review class','math','teacher');
 INSERT INTO academic_years(id,name) VALUES('year-2026','2026'),('year-2027','2027');
 INSERT INTO terms(id,name,"academicYearId","startDate","endDate") VALUES('term-2026','Synthetic term','year-2026','2026-08-01','2026-12-31'),('term-2027','Synthetic term','year-2027','2027-08-01','2027-12-31');`);
 await db.exec(`ALTER TABLE students ADD COLUMN status text DEFAULT 'active'; UPDATE terms SET "isCurrent"=true WHERE id='term-2026';`);
 await db.exec(readMigration('20261008b_former_students_roster_filters.sql'));
 // Include ambiguous legacy rows BEFORE migration; do not deduplicate or label them.
 await db.exec(`INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType",month,status,date,"teacherId","termId") VALUES
 ('legacy-1','fictional-1','english','English',4,5,'CA','October','approved','2026-10-02','teacher','term-2026'),
 ('legacy-2','fictional-1','english','English',3,5,'CA','October','approved','2026-10-02','teacher','term-2026');`);
 const beforeMigration=(await db.query('SELECT * FROM exams ORDER BY id')).rows;
 await db.exec(readMigration('20261105_monthly_assessment_identity.sql'));
 expect((await db.query('SELECT * FROM exams ORDER BY id')).rows).toEqual(beforeMigration);
 await db.exec(`ALTER TABLE profiles ADD COLUMN "assignedClasses" jsonb DEFAULT '[]';
 CREATE FUNCTION assert_can_view_student_term_report(text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
 CREATE FUNCTION class_students_for_term(p_class_name text,p_term_id text) RETURNS TABLE(student_id text) LANGUAGE sql AS $$ SELECT id FROM students WHERE "className"=p_class_name $$;`);
 await db.exec(extractStatementContaining(readMigration('20260913_monthly_ca_quiz_weights.sql'),'FUNCTION public.get_monthly_report'));
 await db.exec(readMigration('20261010_monitor_excludes_former_students.sql'));
});
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.setAuthUid(null);await db.exec('DELETE FROM exams; DELETE FROM grade_uploads; DELETE FROM grade_upload_previews;');await db.setAuthUid(uid);});
it('1/8: October approved remains unchanged after November upload',async()=>{
 await upload([record()]); await db.setAuthUid(null);await db.exec("UPDATE exams SET status='approved'");await db.setAuthUid(uid);
 const originalOctober=(await db.query("SELECT * FROM exams WHERE month='October'")).rows;
 const before=await rows(); const preview=await rpc([record('November',{score:5})],'synthetic-preview-01');
 expect(preview.insertCount).toBe(1);expect(preview.updateCount).toBe(0);expect(preview.changes[0].preservedPeriods).toEqual(['October']);
 await rpc([record('November',{score:5})],'synthetic-preview-01',true);
 expect((await db.query("SELECT * FROM exams WHERE month='October'")).rows).toEqual(originalOctober);
 const after=await rows();
 console.info('SYNTHETIC OCTOBER/NOVEMBER EVIDENCE', JSON.stringify({before,after}));
 expect(after).toHaveLength(2);expect(after.find(r=>r.month==='October')).toEqual(before[0]);expect(after.find(r=>r.month==='November')).toMatchObject({score:'5',status:'pending'});
});
it('2: same-month correction remains one record and requires reapproval',async()=>{await upload([record()]);await db.setAuthUid(null);await db.exec("UPDATE exams SET status='approved'");await db.setAuthUid(uid);await upload([record('October',{score:5})]);expect(await rows()).toHaveLength(1);expect((await rows())[0]).toMatchObject({month:'October',score:'5',status:'pending'});});
it.each([{order:months},{order:[...months].reverse()}])('3: preserves upload order %j',async({order})=>{for(const month of order) await upload([record(month)]);expect(await rows()).toHaveLength(4);});
it('4: retries and new-key identical reuploads preserve approval',async()=>{const r=[record('November')],key='synthetic-retry-key';await upload(r,key);await rpc(r,key,true);await db.setAuthUid(null);await db.exec("UPDATE exams SET status='approved'");await db.setAuthUid(uid);const result=await upload(r);expect(result.skippedCount).toBe(1);expect((await rows())[0].status).toBe('approved');expect(await rows()).toHaveLength(1);});
it('5: recurring HW, CPW, Quiz/MT, attendance and discipline labels remain independent',async()=>{for(const month of ['October','November'])await upload([record(month),record(month,{assessmentLabel:'CPW1',examType:'Classwork',total:15}),record(month,{assessmentLabel:'MT',examType:'Quiz',total:20}),record(month,{assessmentLabel:'ATTENDANCE',examType:'Attendance',total:20}),record(month,{assessmentLabel:'AKHLAAQ',examType:'Discipline',total:10})]);expect(await rows()).toHaveLength(10);});
it('6: academic years do not collide',async()=>{await upload([record()]);await upload([record('October',{termId:'term-2027',date:'2027-10-02'})]);expect(await rows()).toHaveLength(2);});
it('7: different students and subjects do not collide',async()=>{await upload([record(),record('October',{studentId:'fictional-2'}),record('October',{subjectId:'math'})]);expect(await rows()).toHaveLength(3);});
it('9: NULL monthly periods rejected and NULL-label term-wide uniqueness protected',async()=>{
 await expect(upload([record('October',{month:null})])).rejects.toThrow();
 const insert=`INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType",month,status,date,"teacherId","termId") VALUES`;
 await db.exec(`${insert}('final-1','fictional-1','english','English',4,5,'Final','October','pending','2026-10-02','teacher','term-2026')`);
 await expect(db.exec(`${insert}('final-2','fictional-1','english','English',5,5,'Final','November','pending','2026-11-02','teacher','term-2026')`)).rejects.toThrow();
});
it('10: late batch write failure rolls back every assessment and upload log',async()=>{
 const r=[record(),record('October',{studentId:'fictional-2'})],key='synthetic-rollback';await rpc(r,key);
 await db.exec(`CREATE FUNCTION synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."studentId"='fictional-2' THEN RAISE EXCEPTION 'Synthetic late failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON exams FOR EACH ROW EXECUTE FUNCTION synthetic_fail();`);
 try {await expect(rpc(r,key,true)).rejects.toThrow('Synthetic late failure');expect(await rows()).toHaveLength(0);expect((await db.query('SELECT * FROM grade_uploads')).rows).toHaveLength(0);}finally{await db.exec('DROP TRIGGER synthetic_fail ON exams; DROP FUNCTION synthetic_fail();');}
});
it('11: preview pins period/payload, rejects mixed or invalid months and detects intervening changes',async()=>{
 const key='synthetic-period-binding';const preview=await rpc([record()],key);expect(preview.period).toMatchObject({month:'October',termId:'term-2026',academicYearId:'year-2026'});
 await expect(rpc([record('November')],key,true)).rejects.toThrow('Validate and review again');
 await expect(rpc([record(),record('November')],'synthetic-mixed')).rejects.toThrow('exactly one');
 await expect(rpc([record('October',{month:'october'})],'synthetic-invalid')).rejects.toThrow();
 await expect(rpc([record('October',{date:'2026-11-02'})],'synthetic-date')).rejects.toThrow('disagree');
 await upload([record()]);await expect(rpc([record()],key,true)).rejects.toThrow('Validate and review again');
});
it('period cannot be changed by UPDATE-by-ID',async()=>{await upload([record()]);await expect(db.exec("UPDATE exams SET month='November'")).rejects.toThrow('cannot be changed');});

it('12: real monthly report and monitor functions keep months and academic years separate',async()=>{
 await upload([record('October'),record('October',{assessmentLabel:'MT',examType:'Quiz',score:10,total:20})]);
 await db.setAuthUid(null);await db.exec("UPDATE exams SET status='approved'");await db.setAuthUid(uid);
 const report=async()=> (await db.query<{r:any}>("SELECT get_monthly_report('fictional-1','term-2026') r")).rows[0].r;
 const octoberBefore=await report();
 await upload([record('November',{score:5}),record('November',{assessmentLabel:'MT',examType:'Quiz',score:20,total:20})]);
 expect(await report()).toEqual(octoberBefore); // pending November cannot alter published October
 await db.setAuthUid(null);await db.exec("UPDATE exams SET status='approved' WHERE month='November'; INSERT INTO auth.users VALUES('33333333-3333-3333-3333-333333333333'); INSERT INTO profiles(id,name,email,role,auth_id) VALUES('admin','Synthetic admin','admin@example.invalid','admin','33333333-3333-3333-3333-333333333333')");await db.setAuthUid('33333333-3333-3333-3333-333333333333');
 const result=await report();expect(result.filter((r:any)=>r.month==='October')).toEqual(octoberBefore);
 expect(result.find((r:any)=>r.month==='November')).toBeDefined();
 const monitor=async(month:string,year='year-2026')=>(await db.query<{homework_entered:number;quiz_entered:number}>("SELECT homework_entered,quiz_entered FROM monitor_marks_entries($1,'term-2026','monthly',$2)",[year,month])).rows;
 expect(await monitor('October')).toEqual([{homework_entered:1,quiz_entered:1},{homework_entered:0,quiz_entered:0}]);
 expect(await monitor('November')).toEqual(await monitor('October'));
 await expect(monitor('October','year-2027')).rejects.toThrow('does not belong');

});

it('older progress widgets do not combine the same month across academic years',async()=>{
 await upload([record()]);
 await upload([record('October',{termId:'term-2027',date:'2027-10-02',studentId:'fictional-2'})]);
 const view=(await db.query<{homeworkEntered:number}>(`SELECT "homeworkEntered" FROM teacher_exam_progress WHERE month='October' AND "subjectId"='english'`)).rows;
 expect(Number(view[0].homeworkEntered)).toBe(1);
 const grid=(await db.query<{r:any}>(`SELECT get_class_student_subject_progress('Review class','October') r`)).rows[0].r;
 expect(grid.find((r:any)=>r.studentId==='fictional-2' && r.subject==='English').totalExamRows).toBe(0);
});
