// The MBK Parent Portal privacy policy — ONE source of truth, TWO outputs.
//
// WHY: the policy URL goes into Google Play Console, so the page has to work
// (a) as a real page of this website for anyone who opens /privacy-policy, and
// (b) without JavaScript at all. The website is a single-file SPA, so a
// React-only page would only exist while the bundle runs.
//
// This module holds the content once and renders it twice:
//   * PrivacyPolicyPage.tsx renders it inside the app (public, no sign-in);
//   * renderPrivacyPolicyHtml() produces a standalone HTML file, which
//     vite.config.ts emits to dist/privacy-policy.html and
//     dist/privacy-policy/index.html at build time (both URL forms work).
//
// Nothing here may import React or the app: the Vite config imports this file
// in Node to generate the static page.
//
// ACCURACY RULE: every statement below must match what the application
// actually does. Do not add data categories, providers, contact addresses or
// deletion features that the code does not have.

export const PRIVACY_POLICY_PATH = '/privacy-policy';
export const PRIVACY_POLICY_LAST_UPDATED = '23 September 2026';
export const PRIVACY_POLICY_TITLE = 'Privacy Policy';
export const SITE_URL = 'https://schoolnnnnass.vercel.app';

/** Contact details the school publishes for portal and privacy questions. */
export const PRIVACY_CONTACT_EMAIL = 'lettersper3@gmail.com';
export const PRIVACY_CONTACT_PHONE = '+252 63 485 6606';
/** Same number in dialable form (tel: links take digits and a leading +). */
export const PRIVACY_CONTACT_PHONE_TEL = '+252634856606';

/** SEO strings, shared by the standalone HTML head and the in-app page. */
export const PRIVACY_POLICY_PAGE_TITLE = `${PRIVACY_POLICY_TITLE} — MBK Parent Portal | MBK International School`;
export const PRIVACY_POLICY_DESCRIPTION =
  'Privacy Policy for the MBK Parent Portal (MBK International School): what information the portal handles, how it is used, which services process it, how it is protected, and how to contact the school.';
export const PRIVACY_POLICY_URL = `${SITE_URL}${PRIVACY_POLICY_PATH}`;

export type PolicyInline =
  | { kind: 'text'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'link'; value: string; href: string };

export type PolicyBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'dl'; items: Array<{ term: string; text: string }> };

export interface PolicySection {
  id: string;
  title: string;
  blocks: PolicyBlock[];
}

/**
 * Minimal inline markup, shared by both renderers:
 *   **bold**          → <strong>
 *   [label](href)     → <a href="href">
 * Everything else is plain text and is escaped on output.
 */
export function parseInline(text: string): PolicyInline[] {
  const parts: PolicyInline[] = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      parts.push({ kind: 'strong', value: match[1] });
    } else {
      parts.push({ kind: 'link', value: match[2], href: match[3] });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return parts;
}

export const PRIVACY_POLICY_SECTIONS: PolicySection[] = [
  {
    id: 'introduction',
    title: 'Introduction',
    blocks: [
      {
        kind: 'p',
        text: "The MBK Parent Portal is a school service provided by MBK International School. Parents and guardians sign in to follow their children's schooling — attendance, homework, examination results, quizzes, weekly learning activities and messages with the school. School staff (administrators, teachers, supervisors and office staff) use the same platform to keep those school records up to date.",
      },
      {
        kind: 'p',
        text: 'The portal exists to support the school’s educational work. This policy explains the information the portal handles in order to provide that service, and how that information is protected. It applies to the mobile application and to the website.',
      },
    ],
  },
  {
    id: 'who-we-are',
    title: 'Who We Are',
    blocks: [
      {
        kind: 'p',
        text: 'MBK International School ("MBK", "the school", "we") operates the MBK Parent Portal for its own pupils, parents, guardians and staff. The school is responsible for the pupil records held in the portal.',
      },
      {
        kind: 'ul',
        items: [
          '**School / service operator:** MBK International School',
          '**Service:** MBK Parent Portal (mobile application and website)',
          `**Website:** [schoolnnnnass.vercel.app](${SITE_URL})`,
          `**Privacy contact:** [${PRIVACY_CONTACT_EMAIL}](mailto:${PRIVACY_CONTACT_EMAIL}) · [${PRIVACY_CONTACT_PHONE}](tel:${PRIVACY_CONTACT_PHONE_TEL})`,
        ],
      },
      {
        kind: 'p',
        text: 'The portal and the mobile app were built for the school by Eng. Akso, the developer credited in the application. Questions about a family’s records are handled by the school — see [Contact Us](#contact).',
      },
    ],
  },
  {
    id: 'information-we-collect',
    title: 'Information We Collect',
    blocks: [
      {
        kind: 'p',
        text: 'The portal collects the information the school needs to run the parent portal and the related school records. The categories below are the categories actually handled by the application.',
      },
      { kind: 'h3', text: 'Account and sign-in information' },
      {
        kind: 'ul',
        items: [
          'Name, email address and role (for example, parent, teacher, supervisor or administrator).',
          'Phone numbers that the school records for you (for example, the parent phone number kept with your family’s school records).',
          'Account identifiers used to link your sign-in to your school profile.',
          'Authentication and session information (the sign-in session that keeps you logged in).',
        ],
      },
      {
        kind: 'p',
        text: 'Accounts are created by the school. When the school creates a parent account, sign-in details may be delivered to the parent by email or another channel the school uses. Sign-in and password handling are provided by our authentication service.',
      },
      { kind: 'h3', text: 'Student and school records' },
      {
        kind: 'ul',
        items: [
          'Student name, class/grade, school student ID, and other identifiers the school keeps on the pupil’s record.',
          'The relationship between a parent/guardian account and the students linked to it.',
          'Attendance records (for example present, absent or late, with optional notes).',
          'Homework records (subject, title, description, due date and status).',
          'Examination results, reports and the school’s academic record for the pupil, including class moves and enrolment history.',
          'Quiz attempts and results, and the learning activities the school shares with families.',
          'Pickup records: the family/pickup identifier, the persons authorized to collect a student (name, phone number and, where the school has recorded one, a photograph), and records of students released at the gate.',
        ],
      },
      { kind: 'h3', text: 'Communication' },
      {
        kind: 'ul',
        items: [
          'Messages between parents/guardians and school staff, including sender, recipient, subject, message body and timestamps.',
          'Class announcements sent by the school to families.',
          'Whether a message has been read.',
        ],
      },
      { kind: 'h3', text: 'Learning activity' },
      {
        kind: 'ul',
        items: [
          'Learning progress information shown for a child, such as completed lesson activities, quiz attempts and results, and any points or streaks that the app displays as part of learning activities.',
        ],
      },
      { kind: 'h3', text: 'Notifications' },
      {
        kind: 'ul',
        items: [
          'If you use the mobile app, a push notification token (issued through the app’s notification infrastructure) and the device information needed to deliver notifications to that device.',
        ],
      },
      { kind: 'h3', text: 'Technical and service information' },
      {
        kind: 'ul',
        items: [
          'Ordinary technical information recorded by the services that host and operate the portal — such as IP address, request and device/browser information, and timestamps — kept in service logs for security, reliability, troubleshooting and abuse prevention.',
        ],
      },
      {
        kind: 'note',
        text: '**What the Parent Portal does not do.** The parent experience of the portal does not request access to your device’s camera, microphone, location, contacts or photo library, and it does not collect advertising identifiers or health information. The portal contains no advertising, and the school does not sell personal information. The school does keep the administrative details described under [Parent/Guardian Information](#parent-information) — including a payment reference number used for school fee administration — but the portal does not process payments.',
      },
    ],
  },
  {
    id: 'how-we-use',
    title: 'How We Use Information',
    blocks: [
      { kind: 'p', text: 'The portal uses the information described above in order to:' },
      {
        kind: 'ul',
        items: [
          'create accounts and sign users in (authentication);',
          'provide the parent portal and its features to families and staff;',
          'show a parent or guardian the students linked to their account;',
          'display examination results, reports and academic history for those students;',
          'display attendance and homework information;',
          'deliver quizzes and learning activities, and record learning progress;',
          'provide parent–teacher and parent–school communication, including class announcements;',
          'support gate and pickup verification, including family/pickup identifiers and release records;',
          'deliver notifications to families that use the mobile app;',
          'keep the service secure, prevent misuse and abuse, and enforce access rules;',
          'troubleshoot problems and maintain and improve the service.',
        ],
      },
      {
        kind: 'p',
        text: 'The portal does not use family information for advertising or for selling data, and it does not profile families for marketing purposes.',
      },
    ],
  },
  {
    id: 'student-information',
    title: 'Student and Children’s Information',
    blocks: [
      {
        kind: 'p',
        text: 'The portal is intended for school-related use. It is used by parents and guardians, and by teachers, supervisors and other authorized school staff, to manage the school’s educational records.',
      },
      {
        kind: 'ul',
        items: [
          'Student information is processed as part of providing school services to the pupil.',
          'Academic, attendance, homework and learning information is associated with the pupil’s school record.',
          'Student records are linked to a parent or guardian account by the school, so that families can see their own children’s information.',
          'Access is restricted by the school’s database access rules, so that a parent or guardian account can reach only the students linked to it, and staff see only what their role allows.',
          'The portal contains no advertising, and the school does not sell student information.',
        ],
      },
    ],
  },
  {
    id: 'parent-information',
    title: 'Parent/Guardian Information',
    blocks: [
      {
        kind: 'p',
        text: 'The school creates parent and guardian accounts. The information on those accounts — name, email address, phone numbers recorded by the school, and the link to the parent’s children — is used to authenticate the parent, to display the correct children and records, to send school communications, and to support pickup verification at the school gate.',
      },
      {
        kind: 'p',
        text: 'The school’s records for a parent or guardian also include the family details the school keeps for administration: the phone numbers and the area or neighbourhood information recorded for the family, and a payment reference number used for school fee administration. These details sit in the school’s records and are used for school administration only.',
      },
      {
        kind: 'p',
        text: 'If your contact details change, please tell the school office so the school’s records, including your portal account, can be updated.',
      },
    ],
  },
  {
    id: 'how-we-share',
    title: 'How We Share Information',
    blocks: [
      { kind: 'p', text: 'Information is not sold, and it is not shared for advertising. It is handled in these situations:' },
      {
        kind: 'ul',
        items: [
          '**With the school.** School staff use the portal to manage the school’s records, so staff see the information their role requires (for example, a teacher sees the classes they teach).',
          '**With the service providers needed to run the portal.** The infrastructure providers listed below process information on the school’s behalf so that the portal can function — for example, to authenticate users, store the database, host the website, send account emails and deliver mobile notifications. Each provider receives only what its part of the service requires.',
          '**Where the school is required or permitted to disclose it.** Information may be disclosed where required by law, by a lawful request, or where necessary to protect the safety and rights of a pupil, the school or others, or to investigate misuse of the service.',
        ],
      },
    ],
  },
  {
    id: 'service-providers',
    title: 'Service Providers',
    blocks: [
      { kind: 'p', text: 'The portal is built on the following services, which process information in order to provide the service:' },
      {
        kind: 'dl',
        items: [
          {
            term: 'Supabase',
            text: 'Authentication, database and backend functions. Account sign-in, school records, messages, results and learning data are stored in the school’s Supabase project, with database access rules that restrict what each signed-in user can read.',
          },
          {
            term: 'Vercel',
            text: 'Hosting for the portal website and for the serverless function that sends account emails. As with any web host, standard server logs are created in the course of operating the service.',
          },
          {
            term: 'Resend',
            text: 'Email delivery. When the school creates an account for a parent, the sign-in details may be delivered to the parent’s email address through this email service.',
          },
          {
            term: 'Google (Firebase Cloud Messaging) and Expo',
            text: 'Mobile app notification infrastructure. Where notifications are enabled in the mobile app, the push service delivers the notification to the registered device. Google Play also distributes the app.',
          },
          {
            term: 'Google (Gemini API)',
            text: 'The school’s internal lesson-plan review feature sends lesson-plan text written by teachers to Google’s Gemini API to produce a review for supervisors. This is a staff-facing feature; it is not used to analyse parent, guardian or pupil portal information.',
          },
        ],
      },
      {
        kind: 'p',
        text: 'These providers operate their own security and privacy programmes, and the school relies on them to protect the information they process on the school’s behalf.',
      },
    ],
  },
  {
    id: 'security',
    title: 'Data Security',
    blocks: [
      { kind: 'p', text: 'Reasonable technical and organisational measures are used to protect the information in the portal:' },
      {
        kind: 'ul',
        items: [
          'the portal is served over encrypted HTTPS/TLS connections;',
          'sign-in is handled by the authentication provider, and sessions are required to reach portal data;',
          'database access rules (row-level security) are enforced on the server, so requests can return only the records a signed-in user is entitled to;',
          'sensitive operations (such as creating accounts and generating pickup identifiers) are restricted to authorized staff roles;',
          'staff access follows the user’s role, and administrative access is limited;',
          'credentials and API keys for the school’s services are held in the hosting environment’s configuration rather than in the application code.',
        ],
      },
      {
        kind: 'p',
        text: 'No system can be guaranteed to be free of risk. The school works to protect the information it holds, but it cannot promise that every risk can be eliminated.',
      },
    ],
  },
  {
    id: 'retention',
    title: 'Data Retention',
    blocks: [
      {
        kind: 'p',
        text: 'Information is kept for as long as it is needed for the purposes described in this policy. In practice this includes:',
      },
      {
        kind: 'ul',
        items: [
          'providing the parent portal and other school services;',
          'maintaining the pupil’s academic record and school history;',
          'meeting the school’s record-keeping and legal obligations;',
          'resolving disputes and responding to questions about school records;',
          'security, audit and abuse-prevention purposes.',
        ],
      },
      {
        kind: 'p',
        text: 'The exact retention period depends on the type of record and the school’s own record-keeping requirements, and may differ from record to record. Where the school is required to keep an academic record for a longer period, that requirement applies. If you have a question about a specific record, please contact the school — see [Contact Us](#contact).',
      },
    ],
  },
  {
    id: 'deletion',
    title: 'Account and Data Deletion',
    blocks: [
      {
        kind: 'p',
        text: 'The portal does not currently include a self-service "delete my account" control. Accounts are created and administered by the school, so account and data deletion requests are handled by the school.',
      },
      {
        kind: 'ul',
        items: [
          '**How to ask.** Send a request to the school by email or by phone — see [Contact Us](#contact). Signed-in parents and guardians can also send a request from the **Messages** section of the portal.',
          '**What happens next.** The school office will confirm the request, explain what can be removed and what must be kept, and carry out the change on the school’s records.',
          '**Limits.** Some information — in particular academic records the school must keep — may need to be retained even after an account is closed. Where that is the case, the school will explain which records are kept and why.',
        ],
      },
    ],
  },
  {
    id: 'rights',
    title: 'Your Privacy Rights',
    blocks: [
      {
        kind: 'p',
        text: 'Parents and guardians can ask the school about the information held about them or their children, and can ask for information to be corrected, updated or, where appropriate, deleted. Because the portal holds school records, requests are handled by the school and are considered together with the school’s record-keeping obligations and the requirements of the school’s own policies.',
      },
      {
        kind: 'p',
        text: `To make a request, contact the school by email at [${PRIVACY_CONTACT_EMAIL}](mailto:${PRIVACY_CONTACT_EMAIL}) or by phone on [${PRIVACY_CONTACT_PHONE}](tel:${PRIVACY_CONTACT_PHONE_TEL}), or use the **Messages** section of the portal if you can sign in. The school will explain what it can do in your situation.`,
      },
    ],
  },
  {
    id: 'cookies',
    title: 'Cookies and Local Storage',
    blocks: [
      {
        kind: 'p',
        text: 'The portal does not use advertising or tracking cookies. To keep you signed in and to remember your display preferences, the portal stores a small amount of information in your browser’s local storage:',
      },
      {
        kind: 'ul',
        items: [
          'your authenticated session, managed by the authentication service so that you are not asked to sign in on every page;',
          'your appearance preferences (the chosen theme and light/dark mode) so the portal looks the way you set it.',
        ],
      },
      {
        kind: 'p',
        text: 'Signing out clears the session. You can also clear this information at any time through your browser settings.',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Push Notifications',
    blocks: [
      {
        kind: 'p',
        text: 'If you use the mobile app and enable notifications, the app registers a push notification token for your device. That token, together with the device information needed to route the notification, is used only to deliver school notifications to you — for example announcements, results or messages from the school.',
      },
      {
        kind: 'p',
        text: 'You can stop notifications at any time in your device’s settings. The portal website itself does not request permission to send push notifications.',
      },
    ],
  },
  {
    id: 'children',
    title: 'Children’s Privacy and Families',
    blocks: [
      {
        kind: 'p',
        text: 'The MBK Parent Portal is a school service, and it is used by adults — parents and guardians on behalf of their children, and school staff in the course of their work. Children do not create accounts in the parent portal; accounts are created by the school for the families it serves.',
      },
      {
        kind: 'p',
        text: 'Information about a pupil is handled as part of the school’s educational records. Parents and guardians who have questions about their child’s information, or who want to exercise a choice about it, should contact the school office — see [Contact Us](#contact).',
      },
    ],
  },
  {
    id: 'international',
    title: 'International Data Processing',
    blocks: [
      {
        kind: 'p',
        text: 'MBK International School operates in Somaliland. The portal’s infrastructure providers are international cloud services, so information may be stored and processed on servers outside Somaliland — for example in data centres in the United States or the European Union — depending on the provider’s infrastructure. The providers process the information on the school’s behalf, under their own security and privacy programmes.',
      },
    ],
  },
  {
    id: 'changes',
    title: 'Changes to This Privacy Policy',
    blocks: [
      {
        kind: 'p',
        text: 'This policy may be updated when the portal changes or when the school’s practices change. The "Last updated" date at the top of this page shows when it was last revised. Where a change is significant, the school will make it known through the portal.',
      },
    ],
  },
  {
    id: 'contact',
    title: 'Contact Us',
    blocks: [
      { kind: 'p', text: 'Questions about this policy, or about the information the school holds about your family, can be raised:' },
      {
        kind: 'ul',
        items: [
          `**By email:** [${PRIVACY_CONTACT_EMAIL}](mailto:${PRIVACY_CONTACT_EMAIL})`,
          `**By phone:** [${PRIVACY_CONTACT_PHONE}](tel:${PRIVACY_CONTACT_PHONE_TEL})`,
          '**In the portal.** Parents and guardians who can sign in can also use the **Messages** section to send a message to the school. Messages are handled by school staff, and replies arrive in the same place.',
          '**At the school.** Families who prefer to speak to someone in person should contact the MBK International School office.',
        ],
      },
      {
        kind: 'p',
        text: 'Please include your name, your child’s name and class where relevant, and what you would like the school to do, so that the office can help quickly.',
      },
    ],
  },
];

/** True for every URL form that must serve the public policy page. */
export function isPrivacyPolicyPath(pathname: string): boolean {
  const path = (pathname || '').toLowerCase();
  return (
    path === '/privacy-policy' ||
    path === '/privacy-policy/' ||
    path === '/privacy-policy/index.html' ||
    path === '#/privacy-policy'
  );
}

/**
 * Browser-only, hook-free: when the app is loaded directly at the policy path
 * (for example on a host that serves the SPA shell instead of the static file)
 * the tab title and description must still match the standalone page. Called
 * once from main.tsx, so the standalone <head> stays the single source. No-op
 * on other paths and in Node (vite.config.ts imports this module at build time).
 */
export function applyPrivacyPolicyMetadata(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!isPrivacyPolicyPath(window.location.pathname)) return;

  document.title = PRIVACY_POLICY_PAGE_TITLE;

  const existing = document.head.querySelector('meta[name="description"]');
  if (existing) {
    existing.setAttribute('content', PRIVACY_POLICY_DESCRIPTION);
    return;
  }
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'description');
  meta.setAttribute('content', PRIVACY_POLICY_DESCRIPTION);
  document.head.appendChild(meta);
}

// ── Standalone HTML output (no JavaScript, no app bundle) ────────────────────

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Renders the shared inline markup to HTML, escaping everything else. */
export function renderInlineHtml(text: string): string {
  return parseInline(text)
    .map(part => {
      if (part.kind === 'strong') return `<strong>${escapeHtml(part.value)}</strong>`;
      if (part.kind === 'link') return `<a href="${escapeHtml(part.href)}">${escapeHtml(part.value)}</a>`;
      return escapeHtml(part.value);
    })
    .join('');
}

const POLICY_CSS = `
:root{--page-gradient:linear-gradient(160deg,#eef2ff 0%,#ffffff 45%,#f0fdfa 100%);--surface:#fff;--surface-soft:#f8fafc;--text:#0f172a;--muted:#475569;--muted-soft:#64748b;--accent:#4f46e5;--gold:#a87f24;--border:#e2e8f0;--shadow:0 18px 45px rgba(15,23,42,.08);--heading-font:"Cinzel","Cormorant Garamond",Georgia,"Times New Roman",serif;--body-font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--page-gradient:radial-gradient(circle at 18% 0%,rgba(200,162,74,.11),transparent 32rem),linear-gradient(135deg,#080b10 0%,#0b0f14 48%,#111827 100%);--surface:#111827;--surface-soft:#172033;--text:#f5f5f4;--muted:#b8bcc8;--muted-soft:#9aa1af;--accent:#e6c96a;--gold:#c8a24a;--border:rgba(200,162,74,.22);--shadow:0 18px 55px rgba(0,0,0,.42)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page-gradient);background-attachment:fixed;color:var(--text);font-family:var(--body-font);font-size:17px;line-height:1.65}
.skip-link{position:absolute;left:-9999px;padding:.6rem 1rem;background:var(--surface);color:var(--accent);border-radius:0 0 .75rem 0;font-weight:700}
.skip-link:focus{left:0;z-index:10}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}a:hover{text-decoration-thickness:2px}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.wrap{width:100%;max-width:62rem;margin:0 auto;padding:1.25rem 1rem 3rem}
header.site{display:flex;flex-wrap:wrap;align-items:center;gap:.9rem;padding:1.1rem 1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:1rem;box-shadow:var(--shadow)}
header.site img{width:56px;height:56px;object-fit:contain;flex:none}
.site-name{font-family:var(--heading-font);font-size:1.05rem;font-weight:700;letter-spacing:.02em;margin:0}
.site-sub{margin:.15rem 0 0;color:var(--muted-soft);font-size:.85rem;letter-spacing:.08em;text-transform:uppercase}
main{margin-top:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:1rem;box-shadow:var(--shadow);padding:1.5rem 1.25rem 2rem}
h1{font-family:var(--heading-font);font-size:clamp(1.6rem,5vw,2.15rem);line-height:1.25;margin:0 0 .5rem}
h1:after{content:"";display:block;width:5.5rem;height:1px;margin-top:.6rem;background:linear-gradient(90deg,transparent,var(--gold),transparent)}
.meta{margin:.9rem 0 0;color:var(--muted);font-size:.95rem}
.lede{color:var(--muted)}
h2{font-size:1.2rem;line-height:1.35;margin:2.1rem 0 .6rem;border-top:1px solid var(--border)}
h2:first-of-type{border-top:0}
h3{font-size:1rem;margin:1.3rem 0 .35rem}
p{margin:.65rem 0}ul{margin:.6rem 0;padding-left:1.25rem}li{margin:.35rem 0}
.note{background:var(--surface-soft);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:.75rem;padding:.85rem 1rem;margin:1rem 0}
.contents{background:var(--surface-soft);border:1px solid var(--border);border-radius:.75rem;padding:1rem 1.1rem;margin:1.4rem 0 0}
.contents h2{font-size:.85rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted-soft);border:0;margin:0 0 .4rem}
.contents ol{margin:0;padding-left:1.3rem;columns:2;column-gap:1.5rem;font-size:.95rem}
@media (max-width:34rem){.contents ol{columns:1}}
.contents li{margin:.2rem 0;break-inside:avoid}
dt{font-weight:700;margin-top:.8rem}dd{margin:.15rem 0 0;color:var(--muted)}
footer.site{margin-top:1.5rem;text-align:center;color:var(--muted-soft);font-size:.9rem}
footer.site p{margin:.35rem 0}
footer.site .credit{font-family:"Dancing Script",cursive;font-size:1.05rem}
@media (min-width:48rem){.wrap{padding:2.25rem 1.5rem 4rem}main{padding:2.25rem 2.5rem 3rem}}
@media print{body{background:#fff;color:#000;font-size:12pt}.skip-link,.contents{display:none}main,header.site{box-shadow:none;border:0;padding:0}}
`.trim();

function blockToHtml(block: PolicyBlock): string {
  switch (block.kind) {
    case 'h3':
      return `        <h3>${renderInlineHtml(block.text)}</h3>`;
    case 'p':
      return `        <p>${renderInlineHtml(block.text)}</p>`;
    case 'ul':
      return ['        <ul>', ...block.items.map(item => `          <li>${renderInlineHtml(item)}</li>`), '        </ul>'].join('\n');
    case 'note':
      return `        <div class="note"><p>${renderInlineHtml(block.text)}</p></div>`;
    case 'dl':
      return [
        '        <dl>',
        ...block.items.flatMap(item => [
          `          <dt>${renderInlineHtml(item.term)}</dt>`,
          `          <dd>${renderInlineHtml(item.text)}</dd>`,
        ]),
        '        </dl>',
      ].join('\n');
  }
}

/**
 * The complete public page. Emitted by the Vite config to both
 * dist/privacy-policy.html and dist/privacy-policy/index.html, and also served
 * by the SPA at /privacy-policy (see App.tsx).
 */
export function renderPrivacyPolicyHtml(): string {
  const contents = PRIVACY_POLICY_SECTIONS.map(
    (section, index) => `            <li><a href="#${section.id}">${escapeHtml(section.title)}</a></li>`,
  ).join('\n');

  const sections = PRIVACY_POLICY_SECTIONS.map(
    (section, index) => `        <h2 id="${section.id}">${index + 1}. ${escapeHtml(section.title)}</h2>
${section.blocks.map(blockToHtml).join('\n')}`,
  ).join('\n\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${PRIVACY_POLICY_PAGE_TITLE}</title>
    <meta name="description" content="${PRIVACY_POLICY_DESCRIPTION}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${PRIVACY_POLICY_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="MBK International School" />
    <meta property="og:title" content="${PRIVACY_POLICY_PAGE_TITLE}" />
    <meta property="og:description" content="${PRIVACY_POLICY_DESCRIPTION}" />
    <meta property="og:url" content="${PRIVACY_POLICY_URL}" />
    <meta property="og:image" content="${SITE_URL}/logo.png" />
    <meta name="twitter:card" content="summary" />
    <meta name="color-scheme" content="light dark" />
    <link rel="icon" type="image/png" href="/logo.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <style>
${POLICY_CSS}
    </style>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>

    <div class="wrap">
      <header class="site">
        <img src="/logo.png" alt="MBK International School logo" width="56" height="56" />
        <div>
          <p class="site-name">MBK International School</p>
          <p class="site-sub">MBK Parent Portal</p>
        </div>
      </header>

      <main id="main">
        <h1>${PRIVACY_POLICY_TITLE}</h1>
        <p class="meta"><strong>Last updated:</strong> ${escapeHtml(PRIVACY_POLICY_LAST_UPDATED)}</p>
        <p class="meta"><strong>Applies to:</strong> the MBK Parent Portal mobile application and the MBK International School Parent Portal website.</p>
        <p class="lede">
          This policy describes what information the MBK Parent Portal handles, why it is handled, who processes it, and
          the choices available to parents, guardians and pupils' families. It is written to match how the portal
          actually works.
        </p>

        <nav class="contents" aria-labelledby="contents-heading">
          <h2 id="contents-heading">Contents</h2>
          <ol>
${contents}
          </ol>
        </nav>

${sections}
      </main>

      <footer class="site">
        <p><a href="${SITE_URL}">MBK Parent Portal</a> · <a href="${PRIVACY_POLICY_PATH}">Privacy Policy</a></p>
        <p class="credit">MBK International School · Made by <strong>Eng. Akso</strong></p>
      </footer>
    </div>
  </body>
</html>
`;
}
