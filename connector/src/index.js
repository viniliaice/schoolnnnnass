// zkteco-js creates local-time Date objects; parse its device wall-clock in the requested Mogadishu zone.
process.env.TZ = 'Africa/Mogadishu';
import { createClient } from '@supabase/supabase-js';
import { createDeviceAdapter, DeviceConnectionError } from './device.js';

const required = ['SUPABASE_URL','SUPABASE_ANON_KEY','CONNECTOR_EMAIL','CONNECTOR_PASSWORD','ERP_API_URL','CONNECTOR_TOKEN','ZK_DEVICE_SERIAL'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable ${key}`);
const config = {
  url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY,
  email: process.env.CONNECTOR_EMAIL, password: process.env.CONNECTOR_PASSWORD,
  api: process.env.ERP_API_URL.replace(/\/$/, ''), token: process.env.CONNECTOR_TOKEN,
  serial: process.env.ZK_DEVICE_SERIAL,
  timeoutMs: Number(process.env.ZK_TIMEOUT_MS || 15000), inport: Number(process.env.ZK_DEVICE_INPORT || 0),
};
const supabase = createClient(config.url, config.anon, { auth: { persistSession: false, autoRefreshToken: true } });
const inFlight = new Set();
const testInFlight = new Set();
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
    const credentialResult = await post({ action:'get_credential', jobId }, leaseToken);
    if (typeof credentialResult?.credential !== 'string' || !credentialResult.credential) throw new Error('No usable device credential is configured.');
    if (credentialResult.serial !== config.serial || typeof credentialResult.ip !== 'string' || !Number.isInteger(credentialResult.port) || credentialResult.port < 1 || credentialResult.port > 65535) throw new Error('Invalid server-configured device target.');
    const jobDevice = createDeviceAdapter({ ...config, ip:credentialResult.ip, port:credentialResult.port, timeoutMs:credentialResult.timeoutMs });
    const rawResult = await jobDevice.readAttendance(credentialResult.credential);
    const logs = Array.isArray(rawResult) ? rawResult : rawResult?.data;
    if (!Array.isArray(logs)) throw new Error('Unsupported attendance response shape; refusing to store records.');
    const result = await post({ action:'records', jobId, serial:config.serial, records:logs }, leaseToken);
    await post({ action:'complete', jobId, ...result }, leaseToken);
  } catch (e) {
    if (leaseToken) await post({ action:'fail', jobId, error:'Connector could not complete the requested read-only attendance import.' }, leaseToken).catch(() => {});
    console.error(`Fingerprint job ${jobId} failed; diagnostic details suppressed to prevent sensitive-data exposure.`);
  } finally { inFlight.delete(jobId); }
}

async function processDeviceTest(testId) {
  if (typeof testId !== 'string' || !/^[0-9a-f-]{36}$/i.test(testId) || testInFlight.has(testId)) return;
  testInFlight.add(testId);
  try {
    const claimed = await post({ action:'test_claim', testId });
    if (!claimed.accepted) return;
    let result = 'failed';
    try {
      if (claimed.serial !== config.serial || !Number.isInteger(claimed.port) || claimed.port < 1 || claimed.port > 65535 || typeof claimed.ip !== 'string') throw new Error('Invalid configured device target.');
      const testDevice = createDeviceAdapter({ ...config, ip:claimed.ip, port:claimed.port, timeoutMs:claimed.timeoutMs });
      const testResult = await testDevice.testConnection(claimed.credential);
      result = testResult.status;
    } catch (error) {
      result = error instanceof DeviceConnectionError ? error.code : 'failed';
      if (!['address_port_failure','network_failure','timeout','authentication_failure','credential_not_verified','unsupported_protocol'].includes(result)) result = 'failed';
    }
    await post({ action:'test_result', testId, result });
  } catch {
    console.error(`Fingerprint device test ${testId} could not be completed by the connector.`);
  } finally { testInFlight.delete(testId); }
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
  }).on('postgres_changes', { event:'INSERT', schema:'public', table:'fingerprint_device_test_requests' }, (payload) => {
    const row = payload.new;
    if (row?.status === 'queued' && row?.id) void processDeviceTest(row.id);
  }).subscribe((status) => console.log(`Realtime connector ${status}; waiting for an authorized manual job or device test.`));
  const stop = async () => { await supabase.removeChannel(channel); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
