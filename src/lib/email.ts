export async function sendParentCredentialsEmail(payload: {
  parentName: string;
  email: string;
  password: string;
}) {
  const res = await fetch('/api/send-parent-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || 'Failed to send parent credentials email');
  }

  return res.json();
}
