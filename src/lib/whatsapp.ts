export function normalizeSomaliPhoneToWa(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('252')) return digits;
  if (digits.startsWith('0')) return `252${digits.slice(1)}`;
  // Already local without 0, e.g. 634... -> add 252
  if (digits.length >= 7 && digits.length <= 9) return `252${digits}`;
  return digits;
}

export function formatInternationalPhone(phone: string): string {
  const digits = normalizeSomaliPhoneToWa(phone);
  if (!digits) return '';
  // Expected Somalia format: +252 XX XXX XXXX
  // Digits = 252 + 9 digits (e.g. 252634506719 -> 252 63 450 6719)
  if (digits.length < 10) return `+${digits}`;
  const country = digits.slice(0, 3);
  const rest = digits.slice(3);
  // Try to format as 2-3-4 if 9 digits remain
  if (rest.length === 9) {
    return `+${country} ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  if (rest.length === 8) {
    return `+${country} ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  if (rest.length === 7) {
    return `+${country} ${rest.slice(0, 2)} ${rest.slice(2)}`;
  }
  // fallback grouped by 3
  const groups = rest.match(/.{1,3}/g) || [];
  return `+${country} ${groups.join(' ')}`;
}

export function isValidPhone(phone: string): boolean {
  const digits = normalizeSomaliPhoneToWa(phone);
  // Somalia numbers: 252 + 6/61/62/63 etc + 7-8 digits → at least 11 digits total (252 + 8/9)
  // Accept 10-12 digits after normalization as valid enough
  return digits.length >= 10 && digits.length <= 13;
}

export function buildWhatsAppLink(phone: string, message: string): string {
  const digits = normalizeSomaliPhoneToWa(phone);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function buildReportWhatsAppMessage(params: {
  studentName: string;
  className: string;
  academicYear: string;
  termName: string;
  reportType: string;
  month?: string;
  average: string;
}): string {
  const monthPart = params.month ? `${params.month} ` : '';
  return (
    `Assalamu Alaikum,\n\n` +
    `Please find attached the ${monthPart}${params.reportType} Academic Report for ${params.studentName}, ${params.className}.\n\n` +
    `Academic Year: ${params.academicYear}\n` +
    `Term: ${params.termName}\n` +
    `${params.reportType} Average: ${params.average}\n\n` +
    `MBK International School\n` +
    `Dr. Abdishakuur Secondary College`
  );
}

export function buildParentCredentialWhatsAppLink(params: {
  phone: string;
  email: string;
  password: string;
}) {
  const phone = normalizeSomaliPhoneToWa(params.phone);
  const message =
    'Walidka sharafta leh websitekan kala xariir darajadu ardada schoolka ku dhigto, website url https://schoolnnnnass.vercel.app/ \n' +
    `Email: ${params.email}\n` +
    `Password: ${params.password}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}
