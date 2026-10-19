// zkteco-js creates local-time Date objects; parse its device wall-clock in the requested Mogadishu zone.
process.env.TZ = 'Africa/Mogadishu';
import { createDeviceAdapter, DeviceConnectionError } from './device.js';
import { getConnectorEnvStatus, REQUIRED_CONNECTOR_ENV } from './env-status.js';
import { filterAttendanceToRange } from './attendance-range.js';

const envStatus = getConnectorEnvStatus();
for (const key of REQUIRED_CONNECTOR_ENV) if (!envStatus[key]) throw new Error(`Missing required environment variable ${key}`);
const config = {
  api: process.env.ERP_API_URL.replace(/\/$/, ''), token: process.env.CONNECTOR_TOKEN,
  serial: process.env.ZK_DEVICE_SERIAL,
  timeoutMs: Number(process.env.ZK_TIMEOUT_MS || 15000), inport: Number(process.env.ZK_DEVICE_INPORT || 0),
};
const dispatchUrl = `${config.api}/api/fingerprint-attendance/connector`;
async function post(body, leaseToken) {
  const payload = leaseToken ? { ...body, leaseToken } : body;
  const r = await fetch(dispatchUrl, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${config.token}`}, body:JSON.stringify(payload), signal:AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`ERP connector endpoint returned HTTP ${r.status}`);
  return r.json();
}
async function processJob(claim) {
  const { jobId, leaseToken, dateFrom, dateTo } = claim;
  if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/i.test(jobId) || !leaseToken) return;
  try {
    await post({ action:'status', jobId, status:'connecting' }, leaseToken);
    await post({ action:'status', jobId, status:'downloading' }, leaseToken);
    const credentialResult = await post({ action:'get_credential', jobId }, leaseToken);
    if (typeof credentialResult?.credential !== 'string' || !credentialResult.credential) throw new Error('No usable device credential is configured.');
    if (credentialResult.serial !== config.serial || typeof credentialResult.ip !== 'string' || !Number.isInteger(credentialResult.port) || credentialResult.port < 1 || credentialResult.port > 65535) throw new Error('Invalid server-configured device target.');
    const jobDevice = createDeviceAdapter({ ...config, ip:credentialResult.ip, port:credentialResult.port, timeoutMs:credentialResult.timeoutMs });
    const rawResult = await jobDevice.readAttendance(credentialResult.credential);
    const deviceRecords = Array.isArray(rawResult) ? rawResult : rawResult?.data;
    if (!Array.isArray(deviceRecords)) throw new Error('Unsupported attendance response shape; refusing to store records.');
    const logs = filterAttendanceToRange(deviceRecords, dateFrom, dateTo);
    const result = await post({ action:'records', jobId, serial:config.serial, records:logs }, leaseToken);
    await post({ action:'complete', jobId, ...result }, leaseToken);
  } catch {
    await post({ action:'fail', jobId, error:'Connector could not complete the requested read-only attendance import.' }, leaseToken).catch(() => {});
    console.error(`Fingerprint job ${jobId} failed; diagnostic details suppressed to prevent sensitive-data exposure.`);
  }
}

async function processDeviceTest(claim) {
  const { testId, credential, serial, ip, port, timeoutMs } = claim;
  if (typeof testId !== 'string' || !/^[0-9a-f-]{36}$/i.test(testId) || !claim.accepted) return;
  try {
    let result = 'failed';
    try {
      if (serial !== config.serial || !Number.isInteger(port) || port < 1 || port > 65535 || typeof ip !== 'string') throw new Error('Invalid server-configured device target.');
      const testDevice = createDeviceAdapter({ ...config, ip, port, timeoutMs });
      const testResult = await testDevice.testConnection(credential);
      result = testResult.status;
    } catch (error) {
      result = error instanceof DeviceConnectionError ? error.code : 'failed';
      if (!['address_port_failure','network_failure','timeout','authentication_failure','credential_not_verified','unsupported_protocol'].includes(result)) result = 'failed';
    }
    await post({ action:'test_result', testId, result });
  } catch {
    console.error(`Fingerprint device test ${testId} could not be completed by the connector.`);
  }
}

let polling = false;
async function pollForWork() {
  if (polling) return;
  polling = true;
  try {
    const job = await post({ action:'claim_next' });
    if (job.accepted) await processJob(job);
    else {
      const test = await post({ action:'test_claim_next' });
      if (test.accepted) await processDeviceTest(test);
    }
  } catch {
    console.error('Connector could not check for queued work; diagnostic details suppressed.');
  } finally {
    polling = false;
    setTimeout(() => void pollForWork(), 10000);
  }
}

console.log('Connector started; checking for authorized manual requests every 10 seconds.');
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
void pollForWork();
