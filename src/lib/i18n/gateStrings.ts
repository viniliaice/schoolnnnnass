// Soomaali-first string map for the /gate screen (design review: Soomaali
// UI with English toggle; safety screen in the staff's language).
//
// NOTE: strings were drafted from the school's bilingual docs. A native
// speaker pass was explicitly skipped in the eng review (TODOS.md records the
// decision) — adjust here if any label reads oddly.

import { normalizeTransport } from '../transport';

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
  // Authorized pickup people ("drivers") — Add Driver at the gate.
  authorizedTitle: string;
  noDrivers: string;
  addDriver: string;
  driverName: string;
  driverPhone: string;
  relationship: string;
  relationshipPlaceholder: string;
  studentsForDriver: string;
  takePhoto: string;
  retakePhoto: string;
  saveDriver: string;
  saving: string;
  cancel: string;
  photoRequired: string;
  selectStudentError: string;
  driverFieldsRequired: string;
  noDriver: string;
  selectDriver: string;
  releaseTo: string;
  saveDriverFailed: string;
  driverSavedFor: string;
  // De-dupe: this phone already belongs to an existing driver.
  existingDriver: string;
  attachHint: string;
  attachToExisting: string;
  createSeparateDriver: string;
  // Transport eligibility (walking / driver / bus) at the gate.
  notEligible: string;
  driverNotAssigned: string;
  changeDriver: string;
  removeDriver: string;
  searchDriver: string;
  assignDriver: string;
  noDriversMatch: string;
  releaseAllFor: string;
  studentsAssigned: string;
  bulkReleased: string;
  releaseFailedBulk: string;
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
  authorizedTitle: 'Dareewalada la oggol yahay',
  noDrivers: 'Wali ma jiraan dareewallo la ogolaaday',
  addDriver: 'Ku dar dareewale',
  driverName: 'Magac',
  driverPhone: 'Lambarka taleefanka',
  relationship: 'Xiriir / meesha uu kaxeeyo',
  relationshipPlaceholder: 'Tusaale: Awoowe — guriga buu kaxeeyaa',
  studentsForDriver: 'Kee ayuu qaadanayaa?',
  takePhoto: 'Sawir qaado',
  retakePhoto: 'Mar kale qaado',
  saveDriver: 'Kaydi dareewalaha',
  saving: 'Kaydinta…',
  cancel: 'Ka noqo',
  photoRequired: 'Sawir ayaa lagama maarmaan ah',
  selectStudentError: 'Ugu yaraan hal arday dooro',
  driverFieldsRequired: 'Magac iyo taleefan ayaa lagama maarmaan ah',
  noDriver: 'Dareewale ma jiro',
  selectDriver: 'Dooro dareewalaha',
  releaseTo: 'Ku sii day',
  saveDriverFailed: 'Kaydinta dareewalaha ayaa fashilantay',
  driverSavedFor: 'Lagu daray qoyska',
  existingDriver: 'Lambarkan waxaa hore u leh dareewale jira',
  attachHint: 'Ardayda la doortay ku dar dareewalahan hore u jira, halkii aad mid cusub abuuri lahayd',
  attachToExisting: 'Ku dar',
  createSeparateDriver: 'Abuur dareewale cusub',
  notEligible: 'Kuma jiro Iridda Dugsiga',
  driverNotAssigned: 'Dareewale looma qorin',
  changeDriver: 'Beddel dareewale',
  removeDriver: 'Ka saar dareewale',
  searchDriver: 'Raadi dareewale…',
  assignDriver: 'Dooro dareewale',
  noDriversMatch: 'Dareewale la raadiyay lama helin',
  releaseAllFor: 'Ku sii day dhammaan',
  studentsAssigned: 'arday ayaa loo qoray',
  bulkReleased: 'waa la siiyay',
  releaseFailedBulk: 'waa fashilantay',
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
  authorizedTitle: 'Authorized pickups',
  noDrivers: 'No authorized drivers yet',
  addDriver: 'Add driver',
  driverName: 'Name',
  driverPhone: 'Phone number',
  relationship: 'Relationship / where they take the child',
  relationshipPlaceholder: 'e.g. Grandfather — takes to home',
  studentsForDriver: 'Who are they picking up?',
  takePhoto: 'Take photo',
  retakePhoto: 'Retake',
  saveDriver: 'Save driver',
  saving: 'Saving…',
  cancel: 'Cancel',
  photoRequired: 'Photo is required',
  selectStudentError: 'Select at least one student',
  driverFieldsRequired: 'Name and phone number are required',
  noDriver: 'No driver',
  selectDriver: 'Select driver',
  releaseTo: 'Release to',
  saveDriverFailed: 'Could not save driver',
  driverSavedFor: 'Added to family',
  existingDriver: 'This phone already belongs to an existing driver',
  attachHint: 'Attach the selected students to this driver instead of creating a duplicate',
  attachToExisting: 'Attach to',
  createSeparateDriver: 'Create separate driver',
  notEligible: 'Not eligible for Dismissal Gate',
  driverNotAssigned: 'Driver not assigned',
  changeDriver: 'Change driver',
  removeDriver: 'Remove driver',
  searchDriver: 'Search driver…',
  assignDriver: 'Assign driver',
  noDriversMatch: 'No drivers match your search',
  releaseAllFor: 'Release all for',
  studentsAssigned: 'students assigned',
  bulkReleased: 'released',
  releaseFailedBulk: 'release failed',
};

export const GATE_STRINGS: Record<GateLang, GateStrings> = { so: SO, en: EN };

export function gateT(lang: GateLang): GateStrings {
  return GATE_STRINGS[lang];
}

/** Localized transport badge: 'WALKER' → 'Lug'/'Walker', 'DRIVER' → 'Dareewale'/'Driver', '9' → 'Bas 9'/'Bus 9'. */
export function gateTransportLabel(lang: GateLang, transport: string | null | undefined): string {
  // Empty transport is WALKER at the gate too, so dismissal never shows '—'
  // for a child who simply walks home.
  const value = normalizeTransport(transport);
  if (value === 'WALKER') return lang === 'so' ? 'Lug' : 'Walker';
  if (value === 'CAR') return lang === 'so' ? 'Gaari' : 'Car';
  if (value === 'DRIVER') return lang === 'so' ? 'Dareewale' : 'Driver';
  if (/^\d+$/.test(value)) return lang === 'so' ? `Bas ${value}` : `Bus ${value}`;
  return value;
}
