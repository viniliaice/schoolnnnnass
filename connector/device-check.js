import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAdapter, DeviceConnectionError, makeCommKey } from './src/device.js';
import { getConnectorEnvStatus, REQUIRED_CONNECTOR_ENV } from './src/env-status.js';
import { filterAttendanceToRange } from './src/attendance-range.js';

const base = { ip: '192.0.2.10', port: 4370, timeoutMs: 1000, inport: 0 };
function fakeZk({ connectCommand = 2005, authCommand = 2000, infoCommand = 2002, readError = null, socketError = null } = {}) {
  const calls = [];
  class FakeZk {
    constructor() {
      this.ztcp = {
        socket: {}, sessionId: 0x1234,
        createSocket: async () => { calls.push('socket'); if (socketError) throw Object.assign(new Error('synthetic socket error'), { code:socketError }); },
        executeCmd: async (command, data) => {
          calls.push(command);
          if (command === 1000) return reply(connectCommand);
          if (command === 1102) { calls.push(Buffer.from(data).toString('hex')); return reply(authCommand); }
          if (command === 50) return reply(infoCommand);
          return reply(2000);
        },
        closeSocket: async () => { calls.push('closeSocket'); },
        disconnect: async () => { calls.push('unsafe-disconnect-unused'); },
      };
    }
    async getAttendances() {
      calls.push('read-attendance');
      if (readError) throw readError;
      return { data: [{ sn: 7, user_id: 'synthetic-user', record_time: 'Mon Mar 02 2026 08:15:00 GMT+0300', state: 0, type: 1 }] };
    }
  }
  return { calls, FakeZk };
}
function reply(code) { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); return b; }

test('connector environment diagnostic reports only set or missing status', () => {
  const env = Object.fromEntries(REQUIRED_CONNECTOR_ENV.map((name) => [name, 'synthetic-test-value']));
  env.CONNECTOR_TOKEN = ' ';
  const status = getConnectorEnvStatus(env);
  assert.deepEqual(Object.keys(status), REQUIRED_CONNECTOR_ENV);
  assert.equal(status.ERP_API_URL, true);
  assert.equal(status.CONNECTOR_TOKEN, false);
  assert.equal(Object.values(status).filter(Boolean).length, REQUIRED_CONNECTOR_ENV.length - 1);
});

test('attendance range filter keeps only records on inclusive Mogadishu dates', () => {
  const records = [
    { record_time: 'Sun Mar 01 2026 23:59:59 GMT+0300' },
    { record_time: 'Mon Mar 02 2026 00:00:00 GMT+0300' },
    { record_time: 'Mon Mar 02 2026 23:59:59 GMT+0300' },
    { record_time: 'Tue Mar 03 2026 00:00:00 GMT+0300' },
    { record_time: 'invalid' },
  ];
  assert.deepEqual(filterAttendanceToRange(records, '2026-03-02', '2026-03-02'), records.slice(1, 3));
  assert.deepEqual(filterAttendanceToRange(records, null, null), records);
  assert.throws(() => filterAttendanceToRange(records, '2026-03-03', '2026-03-02'), /must not follow/);
});

test('CommKey transform matches published legacy MakeKey vector for a synthetic value', () => {
  assert.equal(makeCommKey('1234', 0x1234).toString('hex'), '4136326b');
});
test('read-only test performs TCP connect, CommKey auth, device-info command and disconnect', async () => {
  const f = fakeZk();
  const result = await createDeviceAdapter(base, f.FakeZk).testConnection('1234');
  assert.equal(result.status, 'success');
  assert.equal(result.key_authenticated, true);
  assert.deepEqual(f.calls, ['socket', 1000, 1102, '4136326b', 50, 1001, 'closeSocket']);
});
test('distinguishes a refused configured address or port from an unreachable network', async () => {
  const refused = fakeZk({ socketError:'ECONNREFUSED' });
  await assert.rejects(createDeviceAdapter(base, refused.FakeZk).testConnection('1234'), (e) => e instanceof DeviceConnectionError && e.code === 'address_port_failure');
  const unreachable = fakeZk({ socketError:'EHOSTUNREACH' });
  await assert.rejects(createDeviceAdapter(base, unreachable.FakeZk).testConnection('1234'), (e) => e instanceof DeviceConnectionError && e.code === 'network_failure');
});
test('read-only test distinguishes authentication rejection and always disconnects', async () => {
  const f = fakeZk({ authCommand: 2005 });
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).testConnection('1234'), (e) => e instanceof DeviceConnectionError && e.code === 'authentication_failure');
  assert.deepEqual(f.calls, ['socket', 1000, 1102, '4136326b', 1001, 'closeSocket']);
});
test('does not claim credential verification when the device does not request CommKey auth', async () => {
  const f = fakeZk({ connectCommand: 2000 });
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).testConnection('1234'), (e) => e instanceof DeviceConnectionError && e.code === 'credential_not_verified');
  assert.deepEqual(f.calls, ['socket', 1000, 1001, 'closeSocket']);
});
test('fails closed when no credential is available', async () => {
  const f = fakeZk();
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).testConnection(''), /No device communication credential/);
  assert.deepEqual(f.calls, []);
});
test('attendance read uses authenticated TCP session and disconnects on failure', async () => {
  const f = fakeZk({ readError: new Error('simulated read error') });
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).readAttendance('1234'), /simulated read error/);
  assert.deepEqual(f.calls, ['socket', 1000, 1102, '4136326b', 'read-attendance', 1001, 'closeSocket']);
});
