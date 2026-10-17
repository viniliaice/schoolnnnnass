import connector from '../../server/fingerprint-attendance/connector.js';
import exportFile from '../../server/fingerprint-attendance/export.js';
import enqueue from '../../server/fingerprint-attendance/import.js';
import retry from '../../server/fingerprint-attendance/retry.js';
import status from '../../server/fingerprint-attendance/status.js';

const handlers: Record<string, (req: any, res: any) => unknown> = {
  connector,
  export: exportFile,
  import: enqueue,
  retry,
  status,
};

/**
 * Share one Vercel Serverless Function across the fingerprint attendance routes
 * to stay within the Hobby plan's per-deployment function limit.
 * Existing URLs remain /api/fingerprint-attendance/{action}.
 */
export default function handler(req: any, res: any) {
  const routeAction = req.query?.action;
  const action = Array.isArray(routeAction) ? routeAction[0] : routeAction;
  const routeHandler = typeof action === 'string' ? handlers[action] : undefined;
  if (!routeHandler) return res.status(404).json({ error: 'Fingerprint attendance route not found.' });
  return routeHandler(req, res);
}
