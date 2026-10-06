/**
 * GET /api/push/health
 *
 * Dependency-free diagnostic endpoint for the push-notification stack. It
 * deliberately imports NOTHING from server/lib, so it can still answer if a
 * route's module resolution is broken. It validates the VAPID material rather
 * than treating the mere presence of environment variables as health.
 *
 * SECURITY: this endpoint reports environment-variable names, booleans, byte
 * counts and validation problems only. It never returns any key material.
 * Always answers 200 with JSON when the handler itself can run.
 */

interface CryptoReport {
  available: boolean;
  createHash?: boolean;
  createHmac?: boolean;
  hkdf?: boolean;
  createCipheriv?: boolean;
  generateKeyPairSync?: boolean;
  error?: string;
}

export type HealthSubjectScheme = 'mailto' | 'https' | 'invalid';

export interface HealthVapidAssessment {
  privateKeyPresent: boolean;
  subjectPresent: boolean;
  privateKeyBytes: number;
  publicKeyBytes: number | null;
  subjectScheme: HealthSubjectScheme;
  subjectValid: boolean;
  ok: boolean;
  problems: string[];
}

function decodeBase64UrlStrict(input: unknown): Buffer | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(input)) return null;
  const unpadded = input.replace(/=+$/, '');
  if (unpadded.length === 0 && input.length > 0) return null;
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function assessSubject(subject: unknown): { valid: boolean; scheme: HealthSubjectScheme; reason?: string } {
  const value = typeof subject === 'string' ? subject.trim() : '';
  const invalid = (reason: string) => ({ valid: false, scheme: 'invalid' as const, reason });
  if (!value) return invalid('VAPID_SUBJECT is empty. Set it to a bare mailto: or https: URI.');
  if (/[\s\[\]()<>'"`]/.test(value)) {
    return invalid('VAPID_SUBJECT must be a bare URI, not Markdown, bracketed, quoted, or whitespace-padded text.');
  }
  if (/^mailto:/i.test(value)) {
    if (value.slice(value.indexOf(':') + 1).length === 0) {
      return invalid('VAPID_SUBJECT mailto: URI must include a contact address.');
    }
    return { valid: true, scheme: 'mailto' };
  }
  if (/^https:/i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        return invalid('VAPID_SUBJECT must be a valid https: contact URI without credentials.');
      }
      return { valid: true, scheme: 'https' };
    } catch {
      return invalid('VAPID_SUBJECT must be a valid https: contact URI.');
    }
  }
  return invalid('VAPID_SUBJECT must use the mailto: or https: URI scheme.');
}

/** Inline equivalent of server/lib/webpush.validateVapidConfig for a healthy diagnostic route. */
export async function assessVapidConfig(): Promise<HealthVapidAssessment> {
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || '';
  const problems: string[] = [];
  const keyBytes = decodeBase64UrlStrict(privateKey);
  const privateKeyBytes = keyBytes?.length ?? 0;
  let publicKeyBytes: number | null = null;

  if (!keyBytes || privateKeyBytes !== 32) {
    problems.push(`VAPID_PRIVATE_KEY must decode to 32 bytes (currently ${privateKeyBytes}).`);
  } else {
    try {
      const mod: any = await import('node:crypto');
      const ecdh = mod.createECDH('prime256v1');
      ecdh.setPrivateKey(keyBytes);
      const point = ecdh.getPublicKey();
      publicKeyBytes = point.length;
      if (point.length !== 65 || point[0] !== 0x04) {
        problems.push('VAPID_PRIVATE_KEY does not derive a valid 65-byte P-256 public point.');
      }
    } catch {
      problems.push('VAPID_PRIVATE_KEY is not a valid P-256 scalar.');
    }
  }

  const subjectCheck = assessSubject(subject);
  if (!subjectCheck.valid && subjectCheck.reason) problems.push(subjectCheck.reason);

  return {
    privateKeyPresent: Boolean(process.env.VAPID_PRIVATE_KEY),
    subjectPresent: Boolean(process.env.VAPID_SUBJECT),
    privateKeyBytes,
    publicKeyBytes,
    subjectScheme: subjectCheck.scheme,
    subjectValid: subjectCheck.valid,
    ok: problems.length === 0,
    problems,
  };
}

async function checkNodeCrypto(): Promise<CryptoReport> {
  try {
    // Dynamic import: if the builtin were unavailable this is REPORTED rather
    // than becoming a load-time crash of the whole function.
    const mod: any = await import('node:crypto');
    const report: CryptoReport = {
      available: false,
      createHash: typeof mod.createHash === 'function',
      createHmac: typeof mod.createHmac === 'function',
      hkdf: typeof mod.hkdfSync === 'function' || typeof mod.hkdf === 'function',
      createCipheriv: typeof mod.createCipheriv === 'function',
      generateKeyPairSync: typeof mod.generateKeyPairSync === 'function',
    };
    report.available =
      Boolean(report.createHash) &&
      Boolean(report.createHmac) &&
      Boolean(report.hkdf) &&
      Boolean(report.createCipheriv) &&
      Boolean(report.generateKeyPairSync);
    return report;
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
    const missing = Object.keys(env).filter((name) => !env[name]);
    const envComplete = missing.length === 0;
    const pushReady = cryptoReport.available && envComplete && vapid.ok;

    let verdict: string;
    if (!cryptoReport.available) {
      verdict = 'runtime-problem: node:crypto is not usable in this function';
    } else if (!envComplete) {
      verdict = `runtime-ok, env-incomplete: missing ${missing.join(', ')}`;
    } else if (!vapid.ok) {
      verdict = `runtime-ok, env-complete, VAPID-config-invalid: ${vapid.problems.join('; ')}`;
    } else {
      verdict = 'runtime-ok, env-complete, vapid-valid';
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: pushReady,
      verdict,
      runtimeOk: cryptoReport.available,
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
  } catch (err) {
    // Guaranteed readable response: never let diagnostics become the outage.
    const message = err instanceof Error ? err.message : String(err);
    try {
      console.error('[push/health] diagnostics failed:', message);
    } catch {
      /* ignore */
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: false, verdict: 'health-check-failed', error: 'Health check failed.', node: process.version });
    } catch {
      return undefined;
    }
  }
}
