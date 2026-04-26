export function normalizeSomaliPhoneToWa(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('252')) return digits;
  if (digits.startsWith('0')) return `252${digits.slice(1)}`;
  return digits;
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
