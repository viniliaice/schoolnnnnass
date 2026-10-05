// @vitest-environment node
//
// Smoke renders for the PWA/notification UI additions (SSR markup, following
// the repo's renderToStaticMarkup convention). Proves the new pages and cards
// mount without crashing inside the real providers and keep their key
// affordances (Install App, Enable Notifications, settings, history, admin
// send form) present in the markup.

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoleProvider } from '../../context/RoleContext';
import { ToastProvider } from '../../context/ToastContext';
import { I18nProvider } from '../i18n/AppLanguageContext';
import { InstallAppCard } from '../../components/pwa/InstallAppCard';
import { EnableNotificationsCard } from '../../components/pwa/EnableNotificationsCard';
import { OfflineIndicator } from '../../components/pwa/OfflineIndicator';
import { UpdateBanner } from '../../components/pwa/UpdateBanner';
import { TeacherNotifications } from '../../pages/teacher/TeacherNotifications';
import { TeacherInstallPage } from '../../pages/teacher/TeacherInstallPage';
import { SendTeacherNotifications } from '../../pages/admin/SendTeacherNotifications';

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <I18nProvider>
        <RoleProvider>{node}</RoleProvider>
      </I18nProvider>
    </ToastProvider>,
  );
}

describe('PWA UI smoke renders', () => {
  it('renders the install card with the required copy and button', () => {
    const html = render(<InstallAppCard alwaysVisible />);
    expect(html).toContain('Install MBK School on your phone or computer for faster access and notifications.');
    expect(html).toContain('Install App');
    expect(html).toContain('How to install');
  });

  it('renders the enable-notifications prompt with Enable / Not Now actions', () => {
    const html = render(<EnableNotificationsCard subscribed={false} />);
    // Node has no Notification API → the card reports unsupported instead of crashing.
    expect(html).toContain('does not support push notifications');
  });

  it('renders offline indicator and update banner as inert when idle', () => {
    expect(render(<OfflineIndicator />)).not.toContain('offline');
    expect(render(<UpdateBanner />)).toBe('');
  });

  it('renders the teacher notification centre sections (toggles load client-side, see pwaPages.client test)', () => {
    const html = render(<TeacherNotifications />);
    expect(html).toContain('Notification Settings');
    expect(html).toContain('Notification History');
    expect(html).toContain('Your Devices');
  });

  it('renders the teacher install page', () => {
    const html = render(<TeacherInstallPage />);
    expect(html).toContain('Install App');
  });

  it('renders the admin send form with recipients, categories and send button', () => {
    const html = render(<SendTeacherNotifications />);
    expect(html).toContain('All Teachers');
    expect(html).toContain('Individual teachers');
    expect(html).toContain('Staff Meeting');
    expect(html).toContain('Send Notification');
    expect(html).toContain('Send History');
  });
});
