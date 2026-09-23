// @vitest-environment jsdom
//
// The privacy policy must be reachable WITHOUT an account: its URL is
// registered in Google Play Console, so a signed-out visitor (or a reviewer)
// opening /privacy-policy must see the policy — never the sign-in form.
//
// App.tsx renders the public policy page before the auth gate; this test
// mounts the whole app at that path to prove the routing decision holds.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// App imports the admin/print modules that pull in @react-pdf/renderer; the
// browser-only download link is replaced the same way the parent workflow test
// does it (partial mock — the rest of the module stays real).
vi.mock('@react-pdf/renderer', async importOriginal => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return {
    ...actual,
    PDFDownloadLink: ({ children }: { children: unknown }) => (
      <button type="button" data-testid="family-card-download">
        {typeof children === 'function' ? 'Download / print my card' : (children as string)}
      </button>
    ),
  };
});

import App from '../../App';
import { applyPrivacyPolicyMetadata, PRIVACY_POLICY_PAGE_TITLE } from '../../legal/privacyPolicy';

const mounted: HTMLElement[] = [];

async function mountAppAt(path: string) {
  window.history.pushState({}, '', path);
  const host = document.createElement('div');
  document.body.appendChild(host);
  mounted.push(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<App />);
  });
  return host;
}

afterEach(() => {
  for (const host of mounted.splice(0)) host.remove();
  window.history.pushState({}, '', '/');
});

describe('/privacy-policy is a public route', () => {
  it('renders the policy for a signed-out visitor instead of the sign-in screen', async () => {
    const host = await mountAppAt('/privacy-policy');

    // The policy itself …
    expect(host.querySelector('#deletion')).not.toBeNull();
    expect(host.querySelector('#contact')).not.toBeNull();
    expect(host.textContent).toContain('MBK International School');
    expect(host.textContent).toContain('MBK Parent Portal');

    // … and no login wall: no credential fields, no sign-in call to action.
    expect(host.querySelector('input[type="email"]')).toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('renders the same page for the trailing-slash form', async () => {
    const host = await mountAppAt('/privacy-policy/');
    expect(host.querySelector('#information-we-collect')).not.toBeNull();
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('sets a policy-specific tab title in the browser, and leaves other pages alone', () => {
    window.history.pushState({}, '', '/privacy-policy');
    document.title = 'MBK International School';
    applyPrivacyPolicyMetadata();
    expect(document.title).toBe(PRIVACY_POLICY_PAGE_TITLE);

    document.title = 'MBK International School';
    window.history.pushState({}, '', '/dashboard');
    applyPrivacyPolicyMetadata();
    expect(document.title).toBe('MBK International School');
  });
});
