// Guards the PUBLIC privacy-policy page.
//
// WHY THIS EXISTS: this URL is registered in Google Play Console
// (Store listing → Privacy policy), so it has to be a real, public,
// login-free page that keeps matching what the app actually does.
//
// The policy has ONE content source (src/legal/privacyPolicy.ts) and TWO
// outputs, and both are covered here:
//   * the in-app page (PrivacyPolicyPage) that /privacy-policy renders when the
//     SPA handles the path;
//   * the standalone HTML file emitted to dist/privacy-policy/index.html, which
//     is what a host serves (and what still works with JavaScript disabled).
//
// These assertions keep three classes of regression out of the shipped page:
//   1. it stops being a real standalone page (script tags, missing metadata,
//      broken in-page anchors, unescaped markup);
//   2. it drifts into placeholders or promises the app cannot keep (invented
//      contact addresses, "100% secure", self-service deletion that does not
//      exist, legal-compliance claims the school has not established);
//   3. the in-app links to it break.

import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PRIVACY_POLICY_LAST_UPDATED,
  PRIVACY_POLICY_SECTIONS,
  PRIVACY_POLICY_URL,
  isPrivacyPolicyPath,
  renderInlineHtml,
  renderPrivacyPolicyHtml,
} from '../../legal/privacyPolicy';
import { PrivacyPolicyPage } from '../../pages/legal/PrivacyPolicyPage';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const requiredSectionIds = [
  'introduction',
  'who-we-are',
  'information-we-collect',
  'how-we-use',
  'student-information',
  'parent-information',
  'how-we-share',
  'service-providers',
  'security',
  'retention',
  'deletion',
  'rights',
  'cookies',
  'notifications',
  'children',
  'international',
  'changes',
  'contact',
];

/** Every word of the policy, as plain text (used for content assertions). */
const policyText = [
  ...PRIVACY_POLICY_SECTIONS.map(section => section.title),
  ...PRIVACY_POLICY_SECTIONS.flatMap(section =>
    section.blocks.flatMap(block => {
      if (block.kind === 'ul') return block.items;
      if (block.kind === 'dl') return block.items.map(item => `${item.term} ${item.text}`);
      return [block.text];
    }),
  ),
].join('\n');

const html = renderPrivacyPolicyHtml();
const pageMarkup = renderToStaticMarkup(PrivacyPolicyPage());

describe('privacy policy content', () => {
  it('covers the required sections, in order', () => {
    expect(PRIVACY_POLICY_SECTIONS.map(section => section.id)).toEqual(requiredSectionIds);
    for (const section of PRIVACY_POLICY_SECTIONS) {
      expect(section.blocks.length, `section ${section.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('states both identities and the revision date', () => {
    expect(policyText).toContain('MBK International School');
    expect(policyText).toContain('MBK Parent Portal');
    expect(PRIVACY_POLICY_LAST_UPDATED).toBe('23 September 2026');
    expect(policyText).toContain('Last updated');
  });

  it('contains no placeholders or invented contact details', () => {
    for (const banned of [
      /\bTODO\b/,
      /\bTBD\b/,
      /\[INSERT/i,
      /\[COMPANY/i,
      /example\.com/i,
      /privacy@(?!schoolnnnnass)/i,
      /lorem ipsum/i,
      /\bXXX\b/,
    ]) {
      expect(policyText, `placeholder found: ${banned}`).not.toMatch(banned);
    }
  });

  it('makes no promise or legal claim the school has not established', () => {
    for (const overclaim of [
      /military[- ]grade/i,
      /100% secure/i,
      /completely (anonymous|secure)/i,
      /zero risk/i,
      /we never share/i,
      /fully compliant with/i,
      /\bCOPPA\b/,
      /\bGDPR\b/,
    ]) {
      expect(policyText, `unsupported claim: ${overclaim}`).not.toMatch(overclaim);
    }
  });

  it('publishes the school’s real contact details (never an invented mailbox)', () => {
    expect(policyText).toContain('lettersper3@gmail.com');
    expect(policyText).toContain('+252 63 485 6606');
    expect(html).toContain('href="mailto:lettersper3@gmail.com"');
    expect(html).toContain('href="tel:+252634856606"');
    // The no-reply credential sender is NOT a contact address and must not appear.
    expect(policyText).not.toContain('noreply@');
  });

  it('describes deletion truthfully (no self-service control today)', () => {
    expect(policyText).toMatch(/does not currently include a self-service/i);
    expect(policyText).not.toMatch(/delete your account (from|in) the app/i);
    expect(policyText).not.toMatch(/tap .{0,20}delete account/i);
    // The only contact route offered is one that actually exists.
    expect(policyText).toContain('Messages');
    expect(policyText).toMatch(/school office/i);
  });

  it('names the services and data the app actually uses', () => {
    for (const fact of [
      'Supabase', // authentication + database + backend functions
      'Vercel', // hosting + the serverless email function
      'Resend', // account-credential email delivery
      'Firebase Cloud Messaging',
      'Expo',
      'Gemini', // staff lesson-plan review
      'row-level', // RLS described in plain words
    ]) {
      expect(policyText.toLowerCase(), `missing: ${fact}`).toContain(fact.toLowerCase());
    }
    expect(policyText).toMatch(/does not sell personal information/i);
    expect(policyText).toContain('no advertising');
    // Categories the app does NOT handle must never be claimed.
    expect(policyText).toMatch(/does not request\s+access to your device’s camera/i);
    // …and categories the school DOES record must be disclosed, not denied.
    expect(policyText).toMatch(/payment reference number/i);
    expect(policyText).not.toMatch(/does not collect[^.]*financial/i);
  });

  it('escapes inline markup instead of trusting it', () => {
    expect(renderInlineHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(renderInlineHtml('**bold** and [link](https://example.org)')).toBe(
      '<strong>bold</strong> and <a href="https://example.org">link</a>',
    );
  });
});

describe('standalone HTML output (dist/privacy-policy/index.html)', () => {
  it('is a self-contained page that works without JavaScript', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<meta[^>]+name="viewport"/i);
    expect(html).toMatch(/<meta[^>]+name="description"[^>]+content="[^"]{40,}"/i);
    expect(html).toMatch(/<title>[^<]*Privacy Policy[^<]*<\/title>/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\/src\/main\.tsx/);
  });

  it('is discoverable: canonical URL and link-preview tags point at the deployed policy', () => {
    expect(html).toContain(`<link rel="canonical" href="${PRIVACY_POLICY_URL}" />`);
    expect(html).toMatch(/<meta property="og:title" content="[^"]*Privacy Policy[^"]*"/);
    expect(html).toMatch(/<meta property="og:description" content="[^"]{40,}"/);
    expect(html).toMatch(/<meta property="og:url" content="https:\/\/[^"]+\/privacy-policy"/);
    expect(html).toMatch(/<meta property="og:image" content="https:\/\/[^"]+\/logo\.png"/);
  });

  it('carries every section and no broken in-page links', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
    for (const id of requiredSectionIds) {
      expect(ids.has(id), `missing section #${id}`).toBe(true);
    }
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(ids.has(anchor), `#${anchor} has no matching id`).toBe(true);
    }
  });

  it('references only files that exist in public/', () => {
    for (const ref of [...html.matchAll(/src="(\/[^"]+)"/g)].map(match => match[1])) {
      expect(existsSync(new URL(`../../../public${ref}`, import.meta.url)), `${ref} is missing`).toBe(true);
    }
  });
});

describe('in-app page', () => {
  it('renders the policy with every section and the school identity', () => {
    for (const id of requiredSectionIds) {
      expect(pageMarkup, `missing #${id}`).toContain(`id="${id}"`);
    }
    expect(pageMarkup).toContain('MBK International School');
    expect(pageMarkup).toContain('MBK Parent Portal');
    expect(pageMarkup).toContain(PRIVACY_POLICY_LAST_UPDATED);
  });

  it('never shows a sign-in wall or credential fields', () => {
    // The policy text talks ABOUT sign-in, so assert on controls instead:
    // no inputs, no password field, no "Sign In" call to action.
    expect(pageMarkup).not.toMatch(/<input/i);
    expect(pageMarkup).not.toMatch(/type="password"/i);
    expect(pageMarkup).not.toMatch(/>\s*Sign In\s*</i);
  });

  it('recognises every URL form that must open the public page', () => {
    for (const path of ['/privacy-policy', '/privacy-policy/', '/privacy-policy/index.html', '/privacy-policy']) {
      expect(isPrivacyPolicyPath(path), path).toBe(true);
    }
    for (const path of ['/', '/dashboard', '/privacy', '/privacy-policys', '']) {
      expect(isPrivacyPolicyPath(path), path).toBe(false);
    }
  });
});

describe('entry points that link to the policy', () => {
  it('links it from the public sign-in footer', () => {
    expect(read('../../components/landing/LoginPage.tsx')).toContain('href="/privacy-policy"');
  });

  it('links it from the parent app and the staff shell footers', () => {
    expect(read('../../components/layout/ParentAppShell.tsx')).toContain('href="/privacy-policy"');
    expect(read('../../components/layout/DashboardLayout.tsx')).toContain('href="/privacy-policy"');
    expect(read('../../pages/parent/MorePage.tsx')).toContain('href="/privacy-policy"');
  });

  it('ships the static page under both URL forms a host might resolve', () => {
    const config = read('../../../vite.config.ts');
    expect(config).toContain('"privacy-policy.html"');
    expect(config).toContain('"privacy-policy/index.html"');
  });
});
