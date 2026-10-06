/**
 * GET /api/push/health
 *
 * Dependency-free diagnostic endpoint for the push-notification stack. It
 * deliberately imports nothing from server/lib, so it can still diagnose the
 * runtime when a local module cannot be loaded by the Vercel function builder.
 * Only booleans, lengths, schemes, and actionable validation messages leave
 * this endpoint; no key material or tokens are returned.
 */

interface CryptoReport {
  available: boolean;
  createHash?: boolean;
  createHmac?: boolean;
  hkdf?: boolean;
  createCipheriv?: boolean;
  createECDH?: boolean;
  generateKeyPairSync?: boolean;
  error?: string;
}

interface InlineVapidCheck {
  privateKeyPresent: boolean;
  subjectPresent: boolean;
  privateKeyBytes: number;
  publicKeyBytes: number;
  subjectScheme: 'mailto' | 'https' | 'invalid';
  subjectValid: boolean;
  ok: boolean;
  problems: string[];
}

async function checkNodeCrypto(): Promise<CryptoReport> {
  try {
    const mod: any = await import('node:crypto');
    const report: CryptoReport = {
      available: false,
      createHash: typeof mod.createHash === 'function',
      createHmac: typeof mod.createHmac === 'function',
      hkdf: typeof mod.hkdfSync === 'function' || typeof mod.hkdf === 'function',
      createCipheriv: typeof mod.createCipheriv === 'function',
      createECDH: typeof mod.createECDH === 'function',
      generateKeyPairSync: typeof mod.generateKeyPairSync === 'function',
    };
    report.available =
      Boolean(report.createHash) &&
      Boolean(report.createHmac) &&
      Boolean(report.hkdf) &&
      Boolean(report.createCipheriv) &&
      Boolean(report.createECDH) &&
      Boolean(report.generateKeyPairSync);
    return report;
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkSubject(subject: string): { valid: boolean; scheme: InlineVapidCheck['subjectScheme']; reason?: string } {
  if (!subject) return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT is empty.' };
  if (subject !== subject.trim() || /[\s\u0000-\u001f\u007f]/.test(subject)) {
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must be a bare URI without whitespace.' };
  }
  if (/[\[\]{}<>"'`]/.test(subject) || /\]\s*\(/.test(subject)) {
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must not be a Markdown link or quoted value.' };
  }
  if (/^mailto:/i.test(subject)) {
    const contact = subject.slice(subject.indexOf(':') + 1);
    return contact && !contact.startsWith('//')
      ? { valid: true, scheme: 'mailto' }
      : { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT mailto URI must include a contact.' };
  }
  if (/^https:/i.test(subject)) {
    try {
      const parsed = new URL(subject);
      if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) {
        return { valid: true, scheme: 'https' };
      }
    } catch {
      // Return a safe, stable problem below rather than the URL parser detail.
    }
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must be a valid https URI.' };
  }
  return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must use mailto: or https:.' };
}

/**
 * Duplicates only the small RFC/config checks here on purpose. Tests compare
 * this dependency-free implementation against server/lib/webpush.ts to keep
 * /api/push/health useful even if the server module graph cannot load.
 */
export async function assessVapidConfig(): Promise<InlineVapidCheck> {
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || '';
  const subjectCheck = checkSubject(subject);
  const problems: string[] = [];
  if (!subjectCheck.valid && subjectCheck.reason) problems.push(subjectCheck.reason);

  let privateKeyBytes = 0;
  let publicKeyBytes = 0;
  let raw: Buffer | null = null;
  if (/^[A-Za-z0-9_-]+$/.test(privateKey)) {
    const padded = privateKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (privateKey.length % 4)) % 4);
    raw = Buffer.from(padded, 'base64');
    privateKeyBytes = raw.length;
  }
  if (!raw || raw.length !== 32) {
    problems.push(`VAPID_PRIVATE_KEY must decode to 32 bytes (got ${privateKeyBytes}).`);
  } else {
    try {
      const crypto = await import('node:crypto');
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(raw);
      const point = ecdh.getPublicKey();
      publicKeyBytes = point.length;
      if (point.length !== 65 || point[0] !== 0x04) {
        problems.push('VAPID_PRIVATE_KEY did not derive a valid uncompressed P-256 public key.');
      }
    } catch {
      // Do not include crypto exceptions; some runtimes can mention key input.
      problems.push('VAPID_PRIVATE_KEY is not a valid P-256 scalar.');
    }
  }

  return {
    privateKeyPresent: Boolean(privateKey),
    subjectPresent: Boolean(subject),
    privateKeyBytes,
    publicKeyBytes,
    subjectScheme: subjectCheck.scheme,
    subjectValid: subjectCheck.valid,
    ok: problems.length === 0,
    problems,
  };
}

function envPresence(): Record<string, boolean> {
  return {
    VAPID_PRIVATE_KEY: Boolean(process.env.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: Boolean(process.env.VAPID_SUBJECT),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL),
    SUPABASE_ANON_KEY: Boolean(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY),
  };
}

export default async function handler(req: any, res: any) {
  try {
    if (req?.method && req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const [cryptoReport, vapid] = await Promise.all([checkNodeCrypto(), assessVapidConfig()]);
    const env = envPresence();
    const envComplete = Object.values(env).every(Boolean);
    const runtimeOk = cryptoReport.available;
    const pushReady = runtimeOk && envComplete && vapid.ok;
    const missing = Object.keys(env).filter((name) => !env[name]);

    const verdictParts = [runtimeOk ? 'runtime-ok' : 'runtime-problem'];
    if (envComplete) verdictParts.push('env-complete');
    else verdictParts.push(`env-incomplete: missing ${missing.join(', ')}`);
    if (vapid.ok) verdictParts.push('vapid-valid');
    else verdictParts.push(`VAPID-config-invalid: ${vapid.problems.join('; ')}`);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: pushReady,
      verdict: verdictParts.join(', '),
      runtimeOk,
      pushReady,
      node: process.version,
      nodeMajor: Number(String(process.versions?.node || '').split('.')[0]) || null,
      platform: process.platform,
      region: process.env.VERCEL_REGION || null,
      crypto: cryptoReport,
      env,
      vapid,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Diagnostics themselves must always return readable JSON.
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: false, verdict: 'health-check-failed', node: process.version });
    } catch {
      return undefined;
    }
  }
}
