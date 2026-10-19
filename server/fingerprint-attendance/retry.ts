import { createClient } from '@supabase/supabase-js';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export default async function handler(req:any,res:any){
 res.setHeader('Cache-Control','no-store'); if(req.method!=='POST')return res.status(405).json({error:'POST required'});
 try{
  const url=process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL!,anon=process.env.SUPABASE_ANON_KEY||process.env.VITE_SUPABASE_ANON_KEY!,service=process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const auth=createClient(url,anon,{global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user}}=await auth.auth.getUser(token);if(!user)return res.status(401).json({error:'Authentication required.'});
  const {data:p}=await auth.from('profiles').select('role').eq('auth_id',user.id).single();if(p?.role!=='admin')return res.status(403).json({error:'Administrator access required.'});
  const jobId=String((typeof req.body==='string'?JSON.parse(req.body):req.body||{}).jobId||'');if(!/^[0-9a-f-]{36}$/i.test(jobId))return res.status(400).json({error:'Invalid job id.'});
  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});const {data:job,error}=await db.from('fingerprint_import_jobs').select('id,status,last_dispatched_at,retry_count,requested_by,lease_token,lease_expires_at').eq('id',jobId).eq('requested_by',user.id).maybeSingle();if(error)throw error;if(!job)return res.status(404).json({error:'Job not found.'});
  const stale=job.status==='queued'&&Date.now()-Date.parse(job.last_dispatched_at)>MAX_AGE_MS;const active=['running','connecting','downloading','saving'].includes(job.status);const expiredLease=active&&job.lease_expires_at&&Date.parse(job.lease_expires_at)<Date.now();
  if(job.status!=='failed'&&!stale&&!expiredLease)return res.status(409).json({error:'Only failed jobs, expired queued jobs, or jobs with an expired processing lease can be explicitly retried.'});
  let updateQuery=db.from('fingerprint_import_jobs').update({status:'queued',last_dispatched_at:new Date().toISOString(),retry_count:job.retry_count+1,lease_token:null,lease_expires_at:null,completed_at:null,error_message:null,retrieved_count:0,inserted_count:0,duplicate_count:0,rejected_count:0,unmatched_count:0}).eq('id',jobId).eq('status',job.status).eq('retry_count',job.retry_count);if(expiredLease)updateQuery=updateQuery.eq('lease_token',job.lease_token).lte('lease_expires_at',new Date().toISOString());const {data,error:updateError}=await updateQuery.select('id').maybeSingle();if(updateError)throw updateError;if(!data)return res.status(409).json({error:'Job changed concurrently; refresh status.'});
  return res.status(202).json({jobId,status:'queued',message:'Retry queued. The school LAN connector will claim it on its next poll.'});
 }catch(e){console.error('[fingerprint retry]',e);return res.status(500).json({error:'Could not retry fingerprint import.'});}
}
