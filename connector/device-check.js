import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAdapter } from './src/device.js';

const base = { ip: '192.168.1.201', port: 4370, timeoutMs: 1000, inport: 0, commKey: 0 };
function fakeZk(overrides = {}) {
  const calls = [];
  const connect = overrides.connect || (async () => {});
  const read = overrides.read || (async () => ({ data: [{ sn: 1, user_id: 'u7', record_time: 'Mon Mar 02 2026 08:15:00 GMT+0300', state: 0, type: 1 }] }));
  class FakeZk {
    constructor(){this.ztcp={createSocket:async()=>{calls.push('socket');},connect:async()=>{calls.push('connect');return connect();},disconnect:async()=>{calls.push('disconnect');}};}
    async getAttendances() { calls.push('read'); return read(); }
  }
  return { calls, FakeZk };
}
test('verified-key opt-in, requested-only retrieval and finally disconnect', async () => {
  process.env.ZK_COMM_KEY_ZERO_CONFIRMED = 'true';
  const f = fakeZk();
  const records = await createDeviceAdapter(base, f.FakeZk).readAttendance();
  assert.equal(records[0].record_time, 'Mon Mar 02 2026 08:15:00 GMT+0300');
  assert.deepEqual(f.calls, ['socket', 'connect', 'read', 'disconnect']);
  delete process.env.ZK_COMM_KEY_ZERO_CONFIRMED;
});
test('fails closed without physical key confirmation and never opens socket', async () => {
  delete process.env.ZK_COMM_KEY_ZERO_CONFIRMED;
  const f = fakeZk();
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).readAttendance(), /cannot set a communication key/);
  assert.deepEqual(f.calls, []);
});
test('disconnects after attendance retrieval failure', async () => {
  process.env.ZK_COMM_KEY_ZERO_CONFIRMED = 'true';
  const f = fakeZk({ read: async () => { throw new Error('simulated read failure'); } });
  await assert.rejects(createDeviceAdapter(base, f.FakeZk).readAttendance(), /simulated read failure/);
  assert.deepEqual(f.calls, ['socket', 'connect', 'read', 'disconnect']);
  delete process.env.ZK_COMM_KEY_ZERO_CONFIRMED;
});
