import { generateVapidKeys, type VapidConfig } from './webpush.js';

let developmentVapid: VapidConfig | null = null;

/** Shared server-side VAPID configuration resolver for the existing sender and reminder APIs. */
export function resolveVapidConfig(): VapidConfig {
  if (process.env.NODE_ENV !== 'production' && !process.env.VAPID_PRIVATE_KEY) {
    if (!developmentVapid) {
      const keys = generateVapidKeys();
      developmentVapid = { privateKey: keys.privateKey, subject: 'mailto:dev@localhost' };
    }
    return developmentVapid;
  }
  return {
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    // Do not hide a missing/invalid production subject with a default.
    subject: process.env.VAPID_SUBJECT ?? '',
  };
}
