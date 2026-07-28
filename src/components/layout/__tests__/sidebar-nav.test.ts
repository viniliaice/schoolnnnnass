import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { navGroups, type NavItem } from '../navConfig';
import type { Role } from '../../../types';

const ROLES: Role[] = ['admin', 'teacher', 'supervisor', 'parent'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(path.resolve(__dirname, '../../../App.tsx'), 'utf8');

function itemsFor(role: Role): NavItem[] {
  return navGroups[role].flatMap(group => group.items);
}

/** Routes handled by the `switch` inside a given role's branch of App.tsx. */
function routesFor(role: Role): Set<string> {
  const block = new RegExp(
    `session\\.role === '${role}'\\) \\{\\s*switch \\(currentPath\\) \\{([\\s\\S]*?)\\n\\s*\\}\\s*\\n`
  ).exec(appSource);
  if (!block) throw new Error(`No route block found for role: ${role}`);
  return new Set(Array.from(block[1].matchAll(/case '([^']+)'/g), match => match[1]));
}

describe('sidebar navigation config', () => {
  it.each(ROLES)('every %s sidebar link resolves to a real route', role => {
    const routes = routesFor(role);
    const broken = itemsFor(role).filter(item => !routes.has(item.path));
    expect(broken.map(item => `${item.label} -> ${item.path}`)).toEqual([]);
  });

  it.each(ROLES)('every %s route is reachable from the sidebar', role => {
    const linked = new Set(itemsFor(role).map(item => item.path));
    const orphaned = [...routesFor(role)].filter(route => !linked.has(route));
    expect(orphaned).toEqual([]);
  });

  it.each(ROLES)('%s nav has no duplicate paths', role => {
    const paths = itemsFor(role).map(item => item.path);
    expect(paths).toHaveLength(new Set(paths).size);
  });

  it.each(ROLES)('%s nav uses a distinct icon per item', role => {
    const icons = itemsFor(role).map(item => item.icon);
    expect(icons).toHaveLength(new Set(icons).size);
  });

  it.each(ROLES)('%s nav starts with the dashboard', role => {
    expect(itemsFor(role)[0].path).toBe('/dashboard');
  });

  it.each(ROLES)('%s groups are non-empty and uniquely titled', role => {
    const groups = navGroups[role];
    groups.forEach(group => expect(group.items.length).toBeGreaterThan(0));
    const titles = groups.map(group => group.title).filter(Boolean);
    expect(titles).toHaveLength(new Set(titles).size);
  });

  it('gives every role access to messages and streams', () => {
    ROLES.forEach(role => {
      const paths = itemsFor(role).map(item => item.path);
      expect(paths).toContain('/messages');
      expect(paths).toContain('/streams');
    });
  });

  it('gives admins lesson plan review access', () => {
    const paths = itemsFor('admin').map(item => item.path);
    expect(paths).toContain('/admin/lesson-plans');
  });
});
