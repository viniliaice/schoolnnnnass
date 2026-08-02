#!/usr/bin/env node
// Create office-role accounts for MBK gate staff via the Supabase Admin API.
//
// Usage:
//   SUPABASE_URL="https://xxx.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="sb_secret_..." \
//   node scripts/create-office-accounts.mjs
//
// The script is idempotent: existing users are left untouched (skipped).
//
// Manual alternative (no script):
//   1. Supabase Dashboard → Authentication → Users → Add user (email+password)
//      for each of: umal@mbk.example, maxamed@mbk.example, abdurahman@mbk.example
//   2. SQL editor — for each new auth user, insert its profile row:
//        insert into public.profiles (id, name, email, password, role, auth_id)
//        values ('office-<n>', '<Full Name>', '<email>', '<temp>', 'office',
//                '<auth-user-uuid>');
//      (Profiles RLS is SELECT-only for non-admins, so an admin session must
//      run the INSERT, or run it with the service role.)
//   3. Share initial passwords securely (school admin hands them out);
//      users should change them on first login.

const STAFF = [
  { name: 'Umal Kharye Xuseen', email: 'umal@mbk.example', phone: '' },
  { name: 'Maxamed Aden', email: 'maxamed@mbk.example', phone: '' },
  { name: 'Abdurahman Aw Nuux', email: 'abdurahman@mbk.example', phone: '' },
];

// Default initial password — override with OFFICE_INITIAL_PASSWORD env.
const INITIAL_PASSWORD = process.env.OFFICE_INITIAL_PASSWORD ?? 'MBK-office-2026!';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function main() {
  let created = 0;
  let skipped = 0;

  for (const staff of STAFF) {
    // 1. Create the auth user (Admin API — bypasses signup).
    const authRes = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: staff.email,
        password: INITIAL_PASSWORD,
        email_confirm: true,
      }),
    });

    let authUserId;
    if (authRes.status === 409) {
      // User already exists — find their id so we can still upsert the profile.
      const listRes = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      const list = await listRes.json();
      const existing = list.users?.find(u => u.email === staff.email);
      if (!existing) {
        console.error(`  ${staff.email}: exists per API but not found in list — skipping`);
        skipped += 1;
        continue;
      }
      authUserId = existing.id;
      skipped += 1;
      console.log(`  ${staff.email}: auth user already exists (skipping auth create)`);
    } else if (authRes.ok) {
      const data = await authRes.json();
      authUserId = data.id;
    } else {
      const body = await authRes.text();
      console.error(`  ${staff.email}: auth create failed (${authRes.status}) ${body}`);
      process.exitCode = 1;
      continue;
    }

    // 2. Upsert the profiles row with role='office' (service role bypasses RLS).
    const profileRes = await fetch(`${url}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: `office-${staff.email.split('@')[0]}`,
        name: staff.name,
        email: staff.email,
        password: INITIAL_PASSWORD,
        role: 'office',
        auth_id: authUserId,
      }),
    });

    if (!profileRes.ok) {
      const body = await profileRes.text();
      console.error(`  ${staff.email}: profile insert failed (${profileRes.status}) ${body}`);
      process.exitCode = 1;
      continue;
    }
    created += 1;
    console.log(`  ${staff.email}: profile upserted with role='office' (auth_id=${authUserId})`);
  }

  console.log(`\nDone: ${created} profile(s) upserted, ${skipped} already existed.`);
  console.log('Next: share initial passwords securely; gate staff log in and use /gate.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
