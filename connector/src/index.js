// zkteco-js creates local-time Date objects; parse its device wall-clock in the requested Mogadishu zone.
process.env.TZ = 'Africa/Mogadishu';
import { createClient } from '@supabase/supabase-js';
import { createDeviceAdapter } from './device.js';

const required = ['SUPABASE_URL','SUPABASE_ANON_KEY','CONNECTOR_EMAIL','CONNECTOR_PASSWORD','ERP_API_URL','CONNECTOR_TOKEN','ZK_DEVICE_COMM_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable ${key}`);
const config = {
  url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY,
  email: process.env.CONNECTOR_EMAIL, password: process.env.CONNECTOR_PASSWORD,
  api: process.env.ERP_API_URL.replace(/\/$/, ''), token: process.env.CONNECTOR_TOKEN,
  ip: process.env.ZK_DEVICE_IP || '192.168.1.201', port: Number(process.env.ZK_DEVICE_PORT || 4370),
  serial: process.env.ZK_DEVICE_SERIAL || '2807990625055', commKey: Number(process.env.ZK_DEVICE_COMM_KEY),
  timeoutMs: Number(process.env.ZK_TIMEOUT_MS || 15000), inport: Number(process.env.ZK_DEVICE_INPORT || 0),
};
if (!Number.isInteger(config.commKey) || config.commKey < 0) throw new Error('ZK_DEVICE_COMM_KEY must be confirmed on the device and set as an integer.');
const supabase = createClient(config.url, config.anon, { auth: { persistSession: false, autoRefreshToken: true } });
const device = createDeviceAdapter(config);
const inFlight = new Set();
const dispatchUrl = `${config.api}/api/fingerprint-attendance/connector`;
async function post(body, leaseToken) {
  const payload = leaseToken ? { ...body, leaseToken } : body;
  const r = await fetch(dispatchUrl, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${config.token}`}, body:JSON.stringify(payload), signal:AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`ERP connector endpoint returned HTTP ${r.status}`);
  return r.json();
}
async function processJob(jobId) {
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId) || inFlight.has(jobId)) return;
  inFlight.add(jobId);
  let leaseToken;
  try {
    const claim = await post({ action:'claim', jobId });
    if (!claim.accepted || !claim.leaseToken) return;
    leaseToken = claim.leaseToken;
    await post({ action:'status', jobId, status:'connecting' }, leaseToken);
    await post({ action:'status', jobId, status:'downloading' }, leaseToken);
    const rawResult = await device.readAttendance();
    const logs = Array.isArray(rawResult) ? rawResult : rawResult?.data;
    if (!Array.isArray(logs)) throw new Error('Unsupported attendance response shape; refusing to store records.');
    const result = await post({ action:'records', jobId, serial:config.serial, records:logs }, leaseToken);
    await post({ action:'complete', jobId, ...result }, leaseToken);
  } catch (e) {
    if (leaseToken) await post({ action:'fail', jobId, error:e instanceof Error ? e.message : 'Connector failure' }, leaseToken).catch(() => {});
    console.error(`Fingerprint job ${jobId} failed:`, e);
  } finally { inFlight.delete(jobId); }
}

async function main() {
  const { error } = await supabase.auth.signInWithPassword({ email:config.email, password:config.password });
  if (error) throw new Error(`Dedicated connector identity sign-in failed: ${error.message}`);
  const channel = supabase.channel('fingerprint-import-dispatch', { config:{ private:true } });
  channel.on('postgres_changes', { event:'INSERT', schema:'public', table:'fingerprint_import_jobs' }, (payload) => {
    const row = payload.new;
    if (row?.status === 'queued' && row?.id) void processJob(row.id);
  }).on('postgres_changes', { event:'UPDATE', schema:'public', table:'fingerprint_import_jobs' }, (payload) => {
    const row = payload.new;
    if (row?.status === 'queued' && row?.id) void processJob(row.id);
  }).subscribe((status) => console.log(`Realtime connector ${status}; waiting for an authorized manual job.`));
  const stop = async () => { await supabase.removeChannel(channel); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
