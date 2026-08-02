// Soomaali-first string map for the /gate screen (design review: Soomaali
// UI with English toggle; safety screen in the staff's language).
//
// NOTE: strings were drafted from the school's bilingual docs. A native
// speaker pass was explicitly skipped in the eng review (TODOS.md records the
// decision) — adjust here if any label reads oddly.

export type GateLang = 'so' | 'en';

export interface GateStrings {
  title: string;
  subtitle: string;
  displayHint: string;
  partialHint: string;
  clear: string;
  scan: string;
  stopScan: string;
  check: string;
  checking: string;
  found: string;
  notFound: string;
  notFoundHint: string;
  tryAgain: string;
  audited: string;
  students: string;
  grade: string;
  transport: string;
  phone: string;
  family: string;
  back: string;
  cameraStarting: string;
  cameraDenied: string;
  cameraUnsupported: string;
  scanPrompt: string;
  error: string;
  errorHint: string;
  emptyPrompt: string;
  release: string;
  releasing: string;
  released: string;
  releaseFailed: string;
  releasedAt: string;
}

const SO: GateStrings = {
  title: 'Iridda Dugsiga',
  subtitle: 'Aqoonsiga qoyska — MBK',
  displayHint: 'Ku qor ama iska xeroor',
  partialHint: 'Lambar qoyska waa 4 xarood',
  clear: 'Nadiifi',
  scan: 'Xeroor',
  stopScan: 'Joji',
  check: 'Hubi',
  checking: 'Hubsiga…',
  found: 'Waa la helay',
  notFound: 'MA LA HELIN',
  notFoundHint: 'Hubi lambarka qoyska oo isku day mar kale',
  tryAgain: 'Isku day mar kale',
  audited: 'Waa la diiwaan geliyay',
  students: 'Ardayda',
  grade: 'Fasalka',
  transport: 'Gaadiid',
  phone: 'Talefoon',
  family: 'Qoys',
  back: 'Ku noqo',
  cameraStarting: 'Furitaanka kamarada…',
  cameraDenied: 'Kamarada lama oggolayn — isticmaal kiiboodhka',
  cameraUnsupported: 'Kamarada kuma shaqeyso browser-kan',
  scanPrompt: 'Xeroor QR-ka kaadhka qoyska',
  error: 'Cilad dhacday',
  errorHint: 'Isku day mar kale',
  emptyPrompt: 'Scan ama ku qor MBK-####',
  release: 'Sii Day',
  releasing: 'Sii dayn…',
  released: 'Waa la siiyay',
  releaseFailed: 'Cilad — mar kale isku day',
  releasedAt: 'Waqtiga la siiyay',
};

const EN: GateStrings = {
  title: 'School Gate',
  subtitle: 'Family ID — MBK',
  displayHint: 'Type or scan',
  partialHint: 'Family IDs are 4 digits',
  clear: 'Clear',
  scan: 'Scan',
  stopScan: 'Stop',
  check: 'Check',
  checking: 'Checking…',
  found: 'Found',
  notFound: 'NOT FOUND',
  notFoundHint: 'Check the family ID and try again',
  tryAgain: 'Try again',
  audited: 'Logged to audit',
  students: 'Students',
  grade: 'Grade',
  transport: 'Transport',
  phone: 'Phone',
  family: 'Family',
  back: 'Back',
  cameraStarting: 'Starting camera…',
  cameraDenied: 'Camera not allowed — use the keypad',
  cameraUnsupported: 'Camera unsupported in this browser',
  scanPrompt: 'Scan the family card QR',
  error: 'Something went wrong',
  errorHint: 'Try again',
  emptyPrompt: 'Scan or type MBK-####',
  release: 'Release',
  releasing: 'Releasing…',
  released: 'Released',
  releaseFailed: 'Failed — try again',
  releasedAt: 'Released at',
};

export const GATE_STRINGS: Record<GateLang, GateStrings> = { so: SO, en: EN };

export function gateT(lang: GateLang): GateStrings {
  return GATE_STRINGS[lang];
}

/** Localized transport badge: 'WALKER' → 'Lug'/'Walker', '9' → 'Bas 9'/'Bus 9'. */
export function gateTransportLabel(lang: GateLang, transport: string | null | undefined): string {
  if (!transport) return '—';
  if (transport === 'WALKER') return lang === 'so' ? 'Lug' : 'Walker';
  if (transport === 'CAR') return lang === 'so' ? 'Gaari' : 'Car';
  if (/^\d+$/.test(transport)) return lang === 'so' ? `Bas ${transport}` : `Bus ${transport}`;
  return transport;
}
