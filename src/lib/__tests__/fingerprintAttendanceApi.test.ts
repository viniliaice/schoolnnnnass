import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: any = { jobs: [] as any[], logs: [] as any[], tests: [] as any[], role: 'admin', userId: 'auth-admin' };
const leases = new Map<string,string>();
class Query {
  table: string; mode='select'; payload:any; filters:any[]=[]; projection='*'; limitCount?:number;
  constructor(table:string){this.table=table;}
  select(cols='*'){this.projection=cols;return this;}
  insert(row:any){this.mode='insert';this.payload=row;return this;}
  update(row:any){this.mode='update';this.payload=row;return this;}
  upsert(rows:any[],_opts:any){this.mode='upsert';this.payload=rows;return this;}
  eq(k:string,v:any){this.filters.push((r:any)=>r[k]===v);return this;}
  gt(k:string,v:any){this.filters.push((r:any)=>r[k]>v);return this;}
  gte(k:string,v:any){this.filters.push((r:any)=>r[k]>=v);return this;}
  lte(k:string,v:any){this.filters.push((r:any)=>r[k]<=v);return this;}
  order(_k:string,_opts?:any){return this;}
  limit(count:number){this.limitCount=count;return this;}
  single(){return this.resolve(true);}
  maybeSingle(){return this.resolve(false);}
  resolve(single:boolean){const rows=this.exec();return Promise.resolve({data:single?(rows[0]||null):(rows[0]||null),error:null});}
  exec(){
    if(this.table==='profiles')return [{role:state.role}];
    const rows=state[this.table==='fingerprint_import_jobs'?'jobs':this.table==='fingerprint_device_test_requests'?'tests':'logs'];
    if(this.mode==='insert'){rows.push({retry_count:0,requested_at:new Date().toISOString(),last_dispatched_at:new Date().toISOString(),...this.payload});return [];}
    if(this.mode==='upsert'){const out:any[]=[];for(const r of this.payload){if(rows.some((x:any)=>x.device_serial===r.device_serial&&x.dedupe_key===r.dedupe_key))continue;rows.push({...r,id:rows.length+1});out.push({id:rows.length});}return out;}
    let selected=rows.filter((r:any)=>this.filters.every(f=>f(r)));
    if(this.limitCount)selected=selected.slice(0,this.limitCount);
    if(this.mode==='update'){for(const r of selected)Object.assign(r,this.payload);return selected;}
    return selected;
  }
  then(resolve:any,reject:any){return Promise.resolve({data:this.exec(),error:null}).then(resolve,reject);}
}
vi.mock('@supabase/supabase-js',()=>({createClient:(_url:string,key:string)=>({
 auth:{getUser:async()=>({data:{user:key==='anon'?{id:state.userId}:null},error:null})},
 from:(table:string)=>new Query(table),
})}));
import fingerprintRouter from '../../../api/fingerprint-attendance/[action]';
import enqueue from '../../../server/fingerprint-attendance/import';
import connector from '../../../server/fingerprint-attendance/connector';
import status from '../../../server/fingerprint-attendance/status';
import retry from '../../../server/fingerprint-attendance/retry';
import exportFile from '../../../server/fingerprint-attendance/export';

function response(){const res:any={code:200,headers:{},body:null,status(n:number){this.code=n;return this;},setHeader(k:string,v:string){this.headers[k]=v;},json(x:any){this.body=x;return this;},send(x:any){this.body=x;return this;}};return res;}
function req(method:string,body:any={},auth='Bearer valid'){return {method,body,headers:{authorization:auth},query:{jobId:body.jobId}} as any;}
async function connectorCall(action:string,jobId:string,extra:any={}){const res=response();const leaseToken=leases.get(jobId);await connector(req('POST',{action,jobId,...extra,...(action==='claim'?{}:{leaseToken})},'Bearer connector-token'),res);if(action==='claim'&&res.body?.accepted)leases.set(jobId,res.body.leaseToken);return res;}

describe('fingerprint API simulated end-to-end persistence/export',()=>{
 beforeEach(()=>{state.jobs=[];state.logs=[];state.tests=[];leases.clear();state.role='admin';state.userId='auth-admin';process.env.SUPABASE_URL='https://unit.test';process.env.SUPABASE_ANON_KEY='anon';process.env.SUPABASE_SERVICE_ROLE_KEY='service';process.env.FINGERPRINT_CONNECTOR_TOKEN='connector-token';process.env.ZK_DEVICE_SERIAL='2807990625055';});
 it('routes existing action URLs through the shared Vercel function',async()=>{
  const id='00000000-0000-4000-8000-000000000001';
  state.jobs.push({id,requested_by:state.userId,status:'queued',last_dispatched_at:new Date().toISOString()});
  const res=response();await fingerprintRouter({method:'GET',headers:{authorization:'Bearer valid'},query:{action:'status',jobId:id}},res);
  expect(res.code).toBe(200);expect(res.body.id).toBe(id);
  const missing=response();await fingerprintRouter({method:'GET',headers:{authorization:'Bearer valid'},query:{action:'unknown'}},missing);
  expect(missing.code).toBe(404);
 });
 it('rejects non-admin, creates one job, claims it once, stores deduped records, completes and exports actual CSV/XLSX bytes',async()=>{
  state.role='teacher';let res=response();await enqueue(req('POST',{format:'csv'}),res);expect(res.code).toBe(403);expect(state.jobs).toHaveLength(0);
  state.role='admin';res=response();await enqueue(req('POST',{format:'xlsx',from:'2026-03-02',to:'2026-03-02'}),res);expect(res.code).toBe(202);expect(state.jobs).toHaveLength(1);const id=res.body.jobId;
  const nextClaim=response();await connector(req('POST',{action:'claim_next'},'Bearer connector-token'),nextClaim);
  expect(nextClaim.body).toMatchObject({accepted:true,jobId:id,dateFrom:'2026-03-02',dateTo:'2026-03-02'});leases.set(id,nextClaim.body.leaseToken);
  const emptyClaim=response();await connector(req('POST',{action:'claim_next'},'Bearer connector-token'),emptyClaim);expect(emptyClaim.body.accepted).toBe(false);
  await connectorCall('status',id,{status:'connecting'});await connectorCall('status',id,{status:'downloading'});
  const records=[{sn:4,user_id:'staff-9',record_time:'Mon Mar 02 2026 08:15:00 GMT+0300',type:1,state:0},{sn:4,user_id:'staff-9',record_time:'Mon Mar 02 2026 08:15:00 GMT+0300',type:1,state:0},{sn:5,user_id:'staff-10',record_time:'Sun Mar 01 2026 08:15:00 GMT+0300',type:1,state:0},{sn:6,user_id:'staff-11',record_time:'Tue Mar 03 2026 08:15:00 GMT+0300',type:1,state:0}];
  res=await connectorCall('records',id,{serial:'2807990625055',records});expect(res.code).toBe(200);expect(res.body).toMatchObject({retrieved:4,inserted:1,duplicates:1,rejected:0,unmatched:2});
  expect(state.logs[0].occurred_at).toBe('2026-03-02T05:15:00.000Z');expect(state.logs[0].raw_event).toEqual(records[0]);
  await connectorCall('complete',id,{retrieved:4,inserted:1,duplicates:1,rejected:0,unmatched:2});expect(state.jobs[0].status).toBe('completed');
  res=response();await exportFile(req('GET',{jobId:id}),res);expect(res.code).toBe(200);expect(res.headers['Content-Type']).toContain('spreadsheetml');expect(Buffer.isBuffer(res.body)).toBe(true);const xlsx=await import('xlsx');const workbook=xlsx.read(res.body,{type:'buffer'});const sheet=xlsx.utils.sheet_to_json(workbook.Sheets.Attendance,{header:1}) as any[][];expect(sheet).toHaveLength(2);expect(sheet[1][2]).toBe('staff-9');
  state.jobs[0].export_format='csv';res=response();await exportFile(req('GET',{jobId:id}),res);expect(res.code).toBe(200);expect(String(res.body)).toContain('staff-9');expect(String(res.body)).toContain('2026-03-02T05:15:00.000Z');
  state.userId='another-admin';res=response();await exportFile(req('GET',{jobId:id}),res);expect(res.code).toBe(404);
 });
 it('redispatches only an explicit authorized retry and renews queued expiry',async()=>{
  let r=response();await enqueue(req('POST',{format:'csv',from:'2026-03-02',to:'2026-03-02'}),r);const id=r.body.jobId;state.jobs[0].status='failed';state.jobs[0].retry_count=0;
  state.role='teacher';let denied=response();await retry(req('POST',{jobId:id}),denied);expect(denied.code).toBe(403);expect(state.jobs[0].status).toBe('failed');
  state.role='admin';r=response();await retry(req('POST',{jobId:id}),r);expect(r.code).toBe(202);expect(state.jobs[0].status).toBe('queued');expect(state.jobs[0].retry_count).toBe(1);
 });
 it('rejects invalid or reversed import dates',async()=>{
  const missing=response();await enqueue(req('POST',{format:'csv'}),missing);
  expect(missing.code).toBe(400);expect(state.jobs).toHaveLength(0);
  const invalid=response();await enqueue(req('POST',{format:'csv',from:'2026-02-30',to:'2026-03-02'}),invalid);
  expect(invalid.code).toBe(400);expect(state.jobs).toHaveLength(0);
  const reversed=response();await enqueue(req('POST',{format:'csv',from:'2026-03-03',to:'2026-03-02'}),reversed);
  expect(reversed.code).toBe(400);expect(state.jobs).toHaveLength(0);
 });
 it('rejects unauthorized connector requests and counts invalid timestamps without storing them',async()=>{
  state.role='admin';let r=response();await enqueue(req('POST',{format:'csv',from:'2026-03-02',to:'2026-03-02'}),r);const id=r.body.jobId;
  r=response();await connector(req('POST',{action:'claim',jobId:id},'Bearer wrong'),r);expect(r.code).toBe(401);
  await connectorCall('claim',id);await connectorCall('status',id,{status:'connecting'});await connectorCall('status',id,{status:'downloading'});
  r=await connectorCall('records',id,{serial:'2807990625055',records:[{user_id:'x',record_time:'bad-time'}]});expect(r.body).toMatchObject({retrieved:1,inserted:0,duplicates:0,rejected:1,unmatched:0});expect(state.logs).toHaveLength(0);await connectorCall('complete',id,{rejected:1});expect(state.jobs[0].status).toBe('partial_failed');r=response();await exportFile(req('GET',{jobId:id}),r);expect(r.code).toBe(409);
 });
});
