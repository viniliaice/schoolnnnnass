import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { decryptDeviceCredential } from './credential-crypto.js';
const db = () => createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth:{persistSession:false,autoRefreshToken:false}});
function authorized(req:any) { const expected=process.env.FINGERPRINT_CONNECTOR_TOKEN||''; const provided=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); return !!expected&&provided.length===expected.length&&timingSafeEqual(Buffer.from(provided),Buffer.from(expected)); }
const validStates=['connecting','downloading','saving'];
function digest(o:unknown) { return createHash('sha256').update(JSON.stringify(o)).digest('hex'); }
export default async function handler(req:any,res:any) {
 res.setHeader('Cache-Control','no-store'); if(req.method!=='POST')return res.status(405).json({error:'POST required'}); if(!authorized(req))return res.status(401).json({error:'Connector authorization failed'});
 const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{}; const {action,jobId}=body;
 const client=db();
 try {
  if(action==='test_claim'||action==='test_claim_next') {
   let testId=String(body.testId||'');
   if(action==='test_claim_next') {
    const {data:nextTest,error:nextError}=await client.from('fingerprint_device_test_requests').select('id').eq('status','queued').order('requested_at',{ascending:true}).limit(1).maybeSingle();
    if(nextError)throw nextError; if(!nextTest)return res.status(200).json({accepted:false}); testId=nextTest.id;
   }
   if(!/^[0-9a-f-]{36}$/i.test(testId))return res.status(400).json({error:'Invalid test id.'});
   const {data:pending,error:readError}=await client.from('fingerprint_device_test_requests').select('id,status,credential_revision_id').eq('id',testId).eq('status','queued').maybeSingle();
   if(readError)throw readError; if(!pending)return res.status(200).json({accepted:false});
   const {data:claimed,error:claimError}=await client.from('fingerprint_device_test_requests').update({status:'running'}).eq('id',testId).eq('status','queued').select('id').maybeSingle();
   if(claimError)throw claimError; if(!claimed)return res.status(200).json({accepted:false});
   const serial=process.env.ZK_DEVICE_SERIAL||''; const ip=process.env.ZK_DEVICE_IP||''; const port=Number(process.env.ZK_DEVICE_PORT||'');
   if(!serial||!isIP(ip)||!Number.isInteger(port)||port<1||port>65535){await client.from('fingerprint_device_test_requests').update({status:'failed',result_message:'Explicit K40 serial, address, and port must be configured server-side.',tested_at:new Date().toISOString()}).eq('id',testId).eq('status','running');return res.status(200).json({accepted:false});}
   const credentialTable=pending.credential_revision_id?'fingerprint_device_credential_candidates':'fingerprint_device_credentials';
   let credentialQuery=client.from(credentialTable).select('ciphertext_b64,nonce_b64,auth_tag_b64');
   credentialQuery=pending.credential_revision_id?credentialQuery.eq('revision_id',pending.credential_revision_id):credentialQuery.eq('device_serial',serial);
   const {data:stored,error:credentialError}=await credentialQuery.maybeSingle();
   if(credentialError||!stored){await client.from('fingerprint_device_test_requests').update({status:'failed',result_message:'Encrypted device credential is unavailable.',tested_at:new Date().toISOString()}).eq('id',testId).eq('status','running');return res.status(200).json({accepted:false});}
   let credential:string; try { credential=decryptDeviceCredential(stored); } catch { await client.from('fingerprint_device_test_requests').update({status:'failed',result_message:'Credential decryption failed; verify server encryption configuration.',tested_at:new Date().toISOString()}).eq('id',testId).eq('status','running');return res.status(200).json({accepted:false}); }
   return res.status(200).json({accepted:true,testId,credential,serial,ip,port,timeoutMs:Number(process.env.ZK_TIMEOUT_MS||15000)});
  }
  if(action==='test_result') {
   const testId=String(body.testId||''); const result=String(body.result||'');
   const messages:Record<string,string>={success:'Authenticated TCP handshake and read-only device information response succeeded.',address_port_failure:'The configured K40 address refused the TCP connection; verify its address and port.',network_failure:'Could not reach the configured device over TCP.',timeout:'The configured device did not respond before the timeout.',authentication_failure:'The device rejected the communication credential.',credential_not_verified:'The device did not request credential authentication; the saved credential could not be verified.',unsupported_protocol:'The device response did not match the supported ZK TCP protocol.',failed:'Connector could not complete the device test.'};
   if(!/^[0-9a-f-]{36}$/i.test(testId)||!messages[result])return res.status(400).json({error:'Invalid test result.'});
   const {data,error}=await client.rpc('finish_fingerprint_device_test',{p_test_id:testId,p_result:result,p_result_message:messages[result]});
   if(error)throw error; if(!data)return res.status(409).json({error:'Test request is no longer active.'}); return res.status(200).json({ok:true,status:data});
  }
  if(action==='claim_next') {
   const cutoff=new Date(Date.now()-24*60*60*1000).toISOString();
   const {data:queued,error:queuedError}=await client.from('fingerprint_import_jobs').select('id,requested_by,last_dispatched_at,date_from,date_to').eq('status','queued').gt('last_dispatched_at',cutoff).order('requested_at',{ascending:true}).limit(1).maybeSingle();
   if(queuedError)throw queuedError; if(!queued)return res.status(200).json({accepted:false});
   const {data:requester,error:profileError}=await client.from('profiles').select('role').eq('auth_id',queued.requested_by).single();
   if(profileError)throw profileError; if(requester?.role!=='admin')return res.status(200).json({accepted:false});
   const leaseToken=randomUUID(); const leaseExpires=new Date(Date.now()+5*60*1000).toISOString();
   const {data,error}=await client.from('fingerprint_import_jobs').update({status:'running',lease_token:leaseToken,lease_expires_at:leaseExpires}).eq('id',queued.id).eq('requested_by',queued.requested_by).eq('status','queued').gt('last_dispatched_at',cutoff).select('id').maybeSingle();
   if(error)throw error;
   return res.status(200).json({accepted:!!data,jobId:data?.id||null,leaseToken:data?leaseToken:null,dateFrom:queued.date_from,dateTo:queued.date_to});
  }
  if(typeof jobId!=='string'||!/^[0-9a-f-]{36}$/i.test(jobId))return res.status(400).json({error:'Invalid job id'});
  if(action==='claim') { const {data:queued,error:queuedError}=await client.from('fingerprint_import_jobs').select('id,requested_by,last_dispatched_at,date_from,date_to').eq('id',jobId).eq('status','queued').maybeSingle(); if(queuedError)throw queuedError; if(!queued || Date.now()-Date.parse(queued.last_dispatched_at)>24*60*60*1000)return res.status(200).json({accepted:false}); const {data:requester,error:profileError}=await client.from('profiles').select('role').eq('auth_id',queued.requested_by).single(); if(profileError)throw profileError; if(requester?.role!=='admin')return res.status(200).json({accepted:false}); const leaseToken=randomUUID(); const leaseExpires=new Date(Date.now()+5*60*1000).toISOString(); const {data,error}=await client.from('fingerprint_import_jobs').update({status:'running',lease_token:leaseToken,lease_expires_at:leaseExpires}).eq('id',jobId).eq('requested_by',queued.requested_by).eq('status','queued').gt('last_dispatched_at',new Date(Date.now()-24*60*60*1000).toISOString()).select('id').maybeSingle(); if(error)throw error; return res.status(200).json({accepted:!!data,leaseToken:data?leaseToken:null,dateFrom:queued.date_from,dateTo:queued.date_to}); }
  const {data:job,error:readErr}=await client.from('fingerprint_import_jobs').select('id,status,lease_token,lease_expires_at,date_from,date_to').eq('id',jobId).maybeSingle(); if(readErr)throw readErr; if(!job||!['running','connecting','downloading','saving'].includes(job.status)||!body.leaseToken||body.leaseToken!==job.lease_token||Date.parse(job.lease_expires_at||'')<Date.now())return res.status(409).json({error:'Job is absent, unclaimed, expired, or owned by another connector attempt.'});
  if(action==='get_credential') {
   const serial=process.env.ZK_DEVICE_SERIAL||''; const ip=process.env.ZK_DEVICE_IP||''; const port=Number(process.env.ZK_DEVICE_PORT||'');
   if(!serial||!isIP(ip)||!Number.isInteger(port)||port<1||port>65535)return res.status(503).json({error:'Explicit K40 serial, address, and port must be configured server-side.'});
   const {data:stored,error}=await client.from('fingerprint_device_credentials').select('ciphertext_b64,nonce_b64,auth_tag_b64').eq('device_serial',serial).maybeSingle();
   if(error)return res.status(503).json({error:'Encrypted device credential is unavailable.'});
   if(!stored)return res.status(404).json({error:'No device credential is configured.'});
   try { const credential=decryptDeviceCredential(stored); return res.status(200).json({credential,serial,ip,port,timeoutMs:Number(process.env.ZK_TIMEOUT_MS||15000)}); }
   catch { return res.status(503).json({error:'Unable to decrypt the configured device credential.'}); }
  }
  if(action==='status'&&validStates.includes(body.status)) { const order=['running','connecting','downloading','saving']; if(order.indexOf(body.status)<order.indexOf(job.status))return res.status(409).json({error:'Invalid backwards job transition.'}); const {error}=await client.from('fingerprint_import_jobs').update({status:body.status,lease_expires_at:new Date(Date.now()+5*60*1000).toISOString()}).eq('id',jobId).eq('status',job.status).eq('lease_token',body.leaseToken); if(error)throw error; return res.status(200).json({ok:true}); }
  if(action==='records') {
   if(job.status!=='downloading')return res.status(409).json({error:'Attendance payload already received or job is not downloading.'});
   if(body.serial!==(process.env.ZK_DEVICE_SERIAL||'')||!Array.isArray(body.records)||body.records.length>50000)return res.status(400).json({error:'Invalid device payload.'});
   const rows:any[]=[]; let rejected=0;
   const fromTimestamp=job.date_from?Date.parse(`${job.date_from}T00:00:00.000+03:00`):Number.NEGATIVE_INFINITY;
   const toTimestamp=job.date_to?Date.parse(`${job.date_to}T23:59:59.999+03:00`):Number.POSITIVE_INFINITY;
   for(const r of body.records){ const uid=String(r?.user_id??'').trim(); const dt=typeof r?.record_time==='string'?r.record_time:''; const timestamp=Date.parse(dt); if(!uid||uid.length>64||!Number.isFinite(timestamp)){rejected++;continue;} if(timestamp<fromTimestamp||timestamp>toTimestamp)continue;
     const sourceId=r.sn==null?null:String(r.sn); const key=sourceId?`sn:${sourceId}`:digest({uid,record_time:dt,type:r.type??null,state:r.state??null});
     rows.push({device_serial:body.serial,source_record_id:sourceId,fingerprint_user_id:uid,occurred_at:new Date(timestamp).toISOString(),punch_status:r.state==null?null:String(r.state),event_type:r.type==null?null:String(r.type),raw_event:r,dedupe_key:key,import_job_id:jobId,mapping_status:'review'});
   }
   const {data:started,error:startError}=await client.from('fingerprint_import_jobs').update({status:'saving',lease_expires_at:new Date(Date.now()+5*60*1000).toISOString(),retrieved_count:body.records.length,inserted_count:0,duplicate_count:0,rejected_count:rejected,unmatched_count:rows.length}).eq('id',jobId).eq('status','downloading').eq('lease_token',body.leaseToken).select('id').maybeSingle(); if(startError)throw startError; if(!started)return res.status(409).json({error:'Job lease expired before save.'});
   let inserted=0; let skipped=0;
   for(let i=0;i<rows.length;i+=500){const batch=rows.slice(i,i+500); const {data,error}=await client.from('fingerprint_attendance_logs').upsert(batch,{onConflict:'device_serial,dedupe_key',ignoreDuplicates:true}).select('id'); if(error)throw error; inserted+=(data||[]).length; skipped+=batch.length-(data||[]).length;
     // Persist progress after each committed batch so a later batch failure does not lie about earlier writes.
     const {error:progressError}=await client.from('fingerprint_import_jobs').update({status:'saving',lease_expires_at:new Date(Date.now()+5*60*1000).toISOString(),retrieved_count:body.records.length,inserted_count:inserted,duplicate_count:skipped,rejected_count:rejected,unmatched_count:rows.length}).eq('id',jobId).eq('lease_token',body.leaseToken); if(progressError)throw progressError;
   }
   if(rows.length===0){const {error}=await client.from('fingerprint_import_jobs').update({status:'saving',lease_expires_at:new Date(Date.now()+5*60*1000).toISOString(),retrieved_count:body.records.length,inserted_count:0,duplicate_count:0,rejected_count:rejected,unmatched_count:0}).eq('id',jobId).eq('lease_token',body.leaseToken);if(error)throw error;}
   return res.status(200).json({retrieved:body.records.length,inserted,duplicates:skipped,rejected,unmatched:rows.length});
  }
  if(action==='fail'||action==='complete') { if(action==='complete'&&job.status!=='saving')return res.status(409).json({error:'Only saved jobs can complete.'}); const patch=action==='fail'?{status:'failed',error_message:String(body.error||'Connector failure').slice(0,1000),completed_at:new Date().toISOString(),lease_token:null,lease_expires_at:null}:{status:(Number(body.rejected)>0?'partial_failed':'completed'),completed_at:new Date().toISOString(),lease_token:null,lease_expires_at:null}; const {data,error}=await client.from('fingerprint_import_jobs').update(patch).eq('id',jobId).eq('status',job.status).eq('lease_token',body.leaseToken).select('id').maybeSingle(); if(error)throw error; if(!data)return res.status(409).json({error:'Lease expired or job state changed.'}); return res.status(200).json({ok:true}); }
  return res.status(400).json({error:'Unsupported connector action.'});
 } catch {console.error('[fingerprint connector] Operation failed; details suppressed.');return res.status(500).json({error:'Fingerprint connector operation failed.'});}
}
