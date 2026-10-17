import ZKLib from 'zkteco-js';

const CMD = { CONNECT: 1000, EXIT: 1001, AUTH: 1102, GET_FREE_SIZES: 50, ACK_OK: 2000, ACK_UNAUTH: 2005, ACK_DATA: 2002 };

export class DeviceConnectionError extends Error {
  constructor(code, message) { super(message); this.name = 'DeviceConnectionError'; this.code = code; }
}

/** Legacy ZK CommKey MakeKey transform, ported from the published pyzk implementation. */
export function makeCommKey(key, sessionId, ticks = 50) {
  if (!/^\d{1,10}$/.test(String(key))) throw new DeviceConnectionError('unsupported_protocol', 'This device protocol requires a numeric communication key.');
  let transformed = 0;
  const numericKey = Number(key) >>> 0;
  for (let bit = 0; bit < 32; bit++) transformed = ((transformed << 1) | ((numericKey >>> bit) & 1)) >>> 0;
  transformed = (transformed + (Number(sessionId) >>> 0)) >>> 0;
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(transformed, 0);
  bytes[0] ^= 0x5a; bytes[1] ^= 0x4b; bytes[2] ^= 0x53; bytes[3] ^= 0x4f;
  const swapped = Buffer.alloc(4);
  swapped.writeUInt16LE(bytes.readUInt16LE(2), 0);
  swapped.writeUInt16LE(bytes.readUInt16LE(0), 2);
  const tick = ticks & 0xff;
  swapped[0] ^= tick; swapped[1] ^= tick; swapped[2] = tick; swapped[3] ^= tick;
  return swapped;
}

/** Read-only TCP adapter. Uses the reviewed legacy CMD_AUTH handshake and never calls device-write commands. */
export function createDeviceAdapter(config, ZK = ZKLib) {
  async function openAuthenticatedSession(credential) {
    if (typeof credential !== 'string' || !credential) throw new DeviceConnectionError('credential_missing', 'No device communication credential is configured.');
    const zk = new ZK(config.ip, config.port, config.timeoutMs, config.inport);
    zk.connectionType = 'tcp';
    try {
      await withTimeout(zk.ztcp.createSocket(), config.timeoutMs, 'K40 TCP connection timed out');
      const connectReply = await withTimeout(zk.ztcp.executeCmd(CMD.CONNECT, Buffer.alloc(0)), config.timeoutMs, 'K40 handshake timed out');
      const connectCommand = responseCommand(connectReply);
      let keyAuthenticated = false;
      if (connectCommand === CMD.ACK_UNAUTH) {
        const authData = makeCommKey(credential, zk.ztcp.sessionId);
        const authReply = await withTimeout(zk.ztcp.executeCmd(CMD.AUTH, authData), config.timeoutMs, 'K40 authentication timed out');
        const authCommand = responseCommand(authReply);
        if (authCommand === CMD.ACK_UNAUTH) throw new DeviceConnectionError('authentication_failure', 'K40 rejected the communication credential.');
        if (authCommand !== CMD.ACK_OK) throw new DeviceConnectionError('unsupported_protocol', `K40 returned an unexpected authentication response (${authCommand}).`);
        keyAuthenticated = true;
      } else if (connectCommand !== CMD.ACK_OK) {
        throw new DeviceConnectionError('unsupported_protocol', `K40 returned an unexpected connect response (${connectCommand}).`);
      }
      return { zk, keyAuthenticated };
    } catch (error) {
      await safelyDisconnect(zk);
      if (error instanceof DeviceConnectionError) throw error;
      const code = error?.code;
      if (code === 'ETIMEDOUT' || /timed out|TIMEOUT/i.test(error?.message || '')) throw new DeviceConnectionError('timeout', 'Timed out waiting for the K40 response.');
      if (code === 'ECONNREFUSED') throw new DeviceConnectionError('address_port_failure', 'The configured K40 address refused the TCP connection; verify the device address and port.');
      if (['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL'].includes(code)) throw new DeviceConnectionError('network_failure', 'The configured K40 address is not reachable from the LAN connector.');
      throw new DeviceConnectionError('unsupported_protocol', 'The K40 did not complete the supported legacy TCP handshake.');
    }
  }

  return {
    async testConnection(credential) {
      let session;
      try {
        session = await openAuthenticatedSession(credential);
        if (!session.keyAuthenticated) throw new DeviceConnectionError('credential_not_verified', 'Device did not request CommKey authentication; saved credential was not verified.');
        const info = await withTimeout(session.zk.ztcp.executeCmd(CMD.GET_FREE_SIZES, Buffer.alloc(0)), config.timeoutMs, 'K40 read-only information request timed out');
        const command = responseCommand(info);
        if (![CMD.ACK_OK, CMD.ACK_DATA].includes(command)) throw new DeviceConnectionError('unsupported_protocol', `K40 rejected the read-only information request (${command}).`);
        return {
          status: 'success',
          key_authenticated: session.keyAuthenticated,
          message: session.keyAuthenticated
            ? 'Authenticated TCP handshake and read-only device information response succeeded.'
            : 'TCP handshake and read-only device information response succeeded; the device did not request CommKey authentication.',
        };
      } finally { if (session?.zk) await safelyDisconnect(session.zk); }
    },
    async readAttendance(credential) {
      const session = await openAuthenticatedSession(credential);
      try {
        const result = await withTimeout(session.zk.getAttendances(), config.timeoutMs, 'K40 attendance read timed out');
        if (!Array.isArray(result?.data)) throw new DeviceConnectionError('unsupported_protocol', 'Unexpected attendance response shape.');
        return result.data;
      } finally { await safelyDisconnect(session.zk); }
    },
  };
}

function responseCommand(reply) {
  if (!Buffer.isBuffer(reply) || reply.length < 2) throw new DeviceConnectionError('unsupported_protocol', 'K40 returned a malformed protocol response.');
  return reply.readUInt16LE(0);
}
async function safelyDisconnect(zk) {
  if (!zk?.ztcp?.socket) return;
  // Avoid zkteco-js disconnect(), which logs raw exception objects. Send CMD_EXIT and close silently.
  await withTimeout(zk.ztcp.executeCmd(CMD.EXIT, Buffer.alloc(0)), 1500, 'K40 exit timed out').catch(() => {});
  await withTimeout(zk.ztcp.closeSocket(), 2500, 'K40 socket close timed out').catch(() => {});
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
