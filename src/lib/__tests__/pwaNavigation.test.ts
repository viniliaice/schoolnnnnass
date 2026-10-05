// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { onNavigationRequest, requestNavigation, sanitizeAppPath } from '../pwa/navigationBus';
import { timeAgo } from '../../utils/timeAgo';

describe('sanitizeAppPath (notification deep links)', () => {
  it('accepts known in-app routes', () => {
    expect(sanitizeAppPath('/teacher/lesson-plans')).toBe('/teacher/lesson-plans');
    expect(sanitizeAppPath('/teacher/notifications')).toBe('/teacher/notifications');
    expect(sanitizeAppPath('/dashboard')).toBe('/dashboard');
    expect(sanitizeAppPath('/admin/teacher-notifications')).toBe('/admin/teacher-notifications');
  });

  it('maps the bare root to the dashboard', () => {
    expect(sanitizeAppPath('/')).toBe('/dashboard');
  });

  it('rejects unknown, external and absolute targets', () => {
    expect(sanitizeAppPath('/evil-route')).toBeNull();
    expect(sanitizeAppPath('https://evil.example/phish')).toBeNull();
    expect(sanitizeAppPath('//evil.example')).toBeNull();
    expect(sanitizeAppPath('javascript:alert(1)')).toBeNull();
    expect(sanitizeAppPath(null)).toBeNull();
  });

  it('accepts same-origin absolute URLs', () => {
    expect(sanitizeAppPath(`${window.location.origin}/teacher/announcements`)).toBe('/teacher/announcements');
  });
});

describe('navigation bus', () => {
  it('delivers sanitized paths to listeners and drops unsafe ones', () => {
    const seen: string[] = [];
    const off = onNavigationRequest((p) => seen.push(p));
    requestNavigation('/teacher/announcements');
    requestNavigation('https://evil.example/x');
    expect(seen).toEqual(['/teacher/announcements']);
    off();
    requestNavigation('/teacher/announcements');
    expect(seen).toEqual(['/teacher/announcements']);
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime();
  it('formats relative times', () => {
    expect(timeAgo(new Date(now - 30 * 1000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 10 * 60000).toISOString(), now)).toBe('10 minutes ago');
    expect(timeAgo(new Date(now - 26 * 3600000).toISOString(), now)).toBe('Yesterday');
    expect(timeAgo(new Date(now - 3 * 86400000).toISOString(), now)).toBe('3 days ago');
  });
});
