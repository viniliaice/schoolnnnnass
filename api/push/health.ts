/**
 * GET /api/push/health
 *
 * Dependency-free diagnostic endpoint for the push-notification stack.
 *
 * It deliberately imports NOTHING from server/lib (or any other local module),
 * so it cannot be affected by the module-resolution problem that made the
 * notification routes return Vercel's opaque FUNCTION_INVOCATION_FAILED page.
 * If this route answers, then the Node runtime, the api/ routing and the
 * function packaging are all healthy — which separates "runtime problem" from
 * "missing environment variable" for the other routes.
 *
 * SECURITY: only the PRESENCE of environment variables is reported (booleans).
 * No value is ever read into the response, and the VAPID private key is never
 * derived or echoed here.
 *
 * Always answers 200 with JSON, even when checks fail, so a browser or curl
 * gets a readable diagnosis instead of a platform error page.
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
    // Required by /api/push/vapid-public-key
    VAPID_PRIVATE_KEY: Boolean(process.env.VAPID_PRIVATE_KEY),
    VAPID_SUBJECT: Boolean(process.env.VAPID_SUBJECT),
    // Required by /api/notifications/send
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

    const cryptoReport = await checkNodeCrypto();
    const env = envPresence();

    const pushReady =
      cryptoReport.available &&
      env.VAPID_PRIVATE_KEY &&
      env.VAPID_SUBJECT &&
      env.SUPABASE_SERVICE_ROLE_KEY &&
      env.SUPABASE_URL &&
      env.SUPABASE_ANON_KEY;

    const missing = Object.keys(env).filter((name) => !env[name]);

    let verdict: string;
    if (!cryptoReport.available) {
      verdict = 'runtime-problem: node:crypto is not usable in this function';
    } else if (!pushReady) {
      verdict = `runtime-ok, env-incomplete: missing ${missing.join(', ')}`;
    } else {
      verdict = 'runtime-ok, env-complete: push endpoints are configured';
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: cryptoReport.available && pushReady,
      verdict,
      runtimeOk: cryptoReport.available,
      pushReady,
      node: process.version,
      nodeMajor: Number(String(process.versions?.node || '').split('.')[0]) || null,
      platform: process.platform,
      region: process.env.VERCEL_REGION || null,
      crypto: cryptoReport,
      env,
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
      return res.status(200).json({ ok: false, verdict: 'health-check-failed', error: message, node: process.version });
    } catch {
      return undefined;
    }
  }
}
