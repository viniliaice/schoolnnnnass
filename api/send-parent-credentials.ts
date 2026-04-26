type SendPayload = {
  parentName?: string;
  email?: string;
  password?: string;
};

const SOMALI_MESSAGE =
  'Walidka sharafta leh websitekan kala xariir darajadu ardada schoolka ku dhigto, website url https://schoolnnnnass.vercel.app/ ';

function getEmailHtml(email: string, password: string) {
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <p>${SOMALI_MESSAGE}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Password:</strong> ${password}</p>
    </div>
  `;
}

function getEmailText(email: string, password: string) {
  return `${SOMALI_MESSAGE}
Email: ${email}
Password: ${password}`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, password, parentName } = (req.body || {}) as SendPayload;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.CREDENTIALS_EMAIL_FROM || 'School <noreply@schoolnnnnass.vercel.app>';

  if (!resendKey) {
    return res.status(500).json({
      error: 'Missing RESEND_API_KEY. Set it in Vercel project environment variables.',
    });
  }

  const subject = parentName
    ? `Parent Credentials - ${parentName}`
    : 'Parent Credentials';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject,
      text: getEmailText(email, password),
      html: getEmailHtml(email, password),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return res.status(502).json({ error: `Resend error: ${errText}` });
  }

  return res.status(200).json({ ok: true });
}
