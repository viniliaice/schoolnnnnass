// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushMocks } = vi.hoisted(() => ({
  pushMocks: {
    pushSupported: vi.fn(() => true),
    currentPermission: vi.fn(() => 'granted'),
    enablePush: vi.fn(),
    getPushSubscriptionState: vi.fn(),
    resyncPushSubscription: vi.fn(),
  },
}));
vi.mock('../../../lib/pwa/pushClient', () => pushMocks);
vi.mock('../../../context/RoleContext', () => ({ useRole: () => ({ user: { id: 'teacher-1' } }) }));
vi.mock('../../../context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import { EnableNotificationsCard } from '../EnableNotificationsCard';

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
let previousActEnvironment: unknown;

beforeEach(() => {
  previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('mbk-notifications-dismissed-at', String(Date.now()));
  pushMocks.pushSupported.mockReturnValue(true);
  pushMocks.currentPermission.mockReturnValue('granted');
  pushMocks.getPushSubscriptionState.mockResolvedValue({
    supported: true,
    permission: 'granted',
    hasBrowserSubscription: true,
    browserKeyMatchesServer: false,
    endpointHost: 'push.example.test',
    endpointLooksSynthetic: false,
  });
  pushMocks.resyncPushSubscription.mockResolvedValue({ ok: true, action: 'resubscribed' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container.remove();
  if (previousActEnvironment === undefined) delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe('EnableNotificationsCard VAPID-key repair', () => {
  it('shows the repair panel even during the Not Now cooldown', async () => {
    await act(async () => {
      root?.render(<EnableNotificationsCard subscribed />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Notifications need to be re-registered on this device');
    expect(container.textContent).toContain('Fix notifications');
    expect(container.textContent).not.toContain('Not Now');
  });

  it('offers repair when the server has an active row but this browser has no registration', async () => {
    pushMocks.getPushSubscriptionState.mockResolvedValue({
      supported: true,
      permission: 'granted',
      hasBrowserSubscription: false,
      browserKeyMatchesServer: null,
      endpointHost: null,
      endpointLooksSynthetic: false,
    });
    await act(async () => {
      root?.render(<EnableNotificationsCard subscribed />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('browser registration is missing');
    expect(container.textContent).toContain('Fix notifications');
  });

  it('calls the resync path from the Fix notifications button', async () => {
    await act(async () => {
      root?.render(<EnableNotificationsCard subscribed />);
      await Promise.resolve();
    });
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('Fix notifications'));
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(pushMocks.resyncPushSubscription).toHaveBeenCalledWith('teacher-1');
  });
});
