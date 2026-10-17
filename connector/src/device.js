import ZKLib from 'zkteco-js';

/** Replaceable adapter, deliberately exposes no write or biometric-template methods. */
export function createDeviceAdapter(config, ZK = ZKLib) {
  return {
    async readAttendance() {
      // Source review of 1.7.2: constructor arg #5 is maxChunk, not commKey.
      if (config.commKey !== 0 || process.env.ZK_COMM_KEY_ZERO_CONFIRMED !== 'true') {
        throw new Error('Device access blocked: zkteco-js 1.7.2 cannot set a communication key. Verify the K40 key and replace this adapter before use.');
      }
      const zk = new ZK(config.ip, config.port, config.timeoutMs, config.inport);
      let connectionAttempted = false;
      try {
        // Avoid zkteco-js createSocket()'s automatic UDP fallback on TCP ECONNREFUSED.
        // This uses the reviewed TCP transport internals and public read-only getAttendances().
        zk.connectionType = 'tcp';
        connectionAttempted = true;
        await withTimeout(zk.ztcp.createSocket(), config.timeoutMs, 'K40 TCP socket creation timed out');
        await withTimeout(zk.ztcp.connect(), config.timeoutMs, 'K40 TCP connection timed out');
        const result = await withTimeout(zk.getAttendances(), config.timeoutMs, 'K40 attendance read timed out');
        if (!Array.isArray(result?.data)) throw new Error('Unexpected zkteco-js attendance response shape.');
        return result.data;
      } finally {
        if (connectionAttempted) await withTimeout(zk.ztcp.disconnect(), 5000, 'K40 TCP disconnect timed out').catch(() => {});
      }
    },
  };
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
