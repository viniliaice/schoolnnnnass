// Presentational sidebar navigation.
//
// Renders the centralized navigation config (see ./navigation.ts) exactly the
// same way in the desktop column and in the mobile drawer — one implementation,
// two placements — so the two can never drift apart.
//
// Semantics:
//   nav[aria-label]  →  section h2 + ul  →  li  →  item button (aria-current)
//                                                └  group row: item button
//                                                   (destination) + disclosure
//                                                   button (aria-expanded /
//                                                   aria-controls) → ul
//
// The app navigates through state (see DashboardLayout), so destinations are
// <button>s, not <a>s: a real link would trigger a full page load and lose the
// session state the shell owns.

import type { FocusEvent, MouseEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';
import { isNavGroup, type NavEntry, type NavSection } from './navigation';

export interface SidebarNavProps {
  sections: NavSection[];
  currentPath: string;
  translate: (key: string, fallback: string) => string;
  /** Desktop collapsed mode: icon-only rows + tooltips. */
  collapsed?: boolean;
  variant?: 'desktop' | 'drawer';
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (groupId: string) => void;
  onNavigate: (path: string) => void;
  /** Hover/focus tooltip in collapsed mode (label + anchor element). */
  onTooltip?: (label: string, target: HTMLElement) => void;
  onTooltipHide?: () => void;
  /** Shown when a search filtered everything out. */
  emptyMessage?: string;
  idPrefix?: string;
  className?: string;
}

export function SidebarNav({
  sections,
  currentPath,
  translate,
  collapsed = false,
  variant = 'desktop',
  expandedGroups,
  onToggleGroup,
  onNavigate,
  onTooltip,
  onTooltipHide,
  emptyMessage,
  idPrefix = 'app-nav',
  className,
}: SidebarNavProps) {
  const labelClass = collapsed ? 'sr-only' : 'app-nav-label';
  const rowGap = variant === 'drawer' ? 'min-h-12' : 'min-h-11';
  const totalEntries = sections.reduce((count, section) => count + section.entries.length, 0);

  if (totalEntries === 0) {
    return (
      <div className={cn('px-3 py-6 text-sm', className)} role="status">
        <span className="text-[color:var(--muted)]">{emptyMessage ?? translate('nav.noResults', 'No pages found')}</span>
      </div>
    );
  }

  return (
    <div className={cn('app-nav-body', className)}>
      {sections.map(section => (
        <section key={section.id} className="app-nav-section" aria-labelledby={`${idPrefix}-section-${section.id}`}>
          <h2 id={`${idPrefix}-section-${section.id}`} className="app-nav-section-title">
            {collapsed ? (
              <span className="app-nav-section-rule" aria-hidden="true" />
            ) : (
              translate(section.labelKey, section.fallback)
            )}
            {/* The heading stays in the accessibility tree even when the
                collapsed sidebar shows only a divider instead of the text. */}
            {collapsed && <span className="sr-only">{translate(section.labelKey, section.fallback)}</span>}
          </h2>

          <ul className="app-nav-list">
            {section.entries.map(entry => (
              <li key={entry.id} className="app-nav-entry">
                {isNavGroup(entry) ? (
                  <NavGroupRow
                    group={entry}
                    currentPath={currentPath}
                    translate={translate}
                    collapsed={collapsed}
                    rowGap={rowGap}
                    variant={variant}
                    open={Boolean(expandedGroups[entry.id])}
                    onToggle={onToggleGroup}
                    onNavigate={onNavigate}
                    onTooltip={onTooltip}
                    onTooltipHide={onTooltipHide}
                    labelClass={labelClass}
                    idPrefix={idPrefix}
                  />
                ) : (
                  <NavItemButton
                    entry={entry}
                    currentPath={currentPath}
                    translate={translate}
                    collapsed={collapsed}
                    rowGap={rowGap}
                    nested={false}
                    onNavigate={onNavigate}
                    onTooltip={onTooltip}
                    onTooltipHide={onTooltipHide}
                    labelClass={labelClass}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface NavItemButtonProps {
  entry: Extract<NavEntry, { path: string }>;
  currentPath: string;
  translate: (key: string, fallback: string) => string;
  collapsed: boolean;
  rowGap: string;
  nested: boolean;
  onNavigate: (path: string) => void;
  onTooltip?: (label: string, target: HTMLElement) => void;
  onTooltipHide?: () => void;
  labelClass: string;
}

function NavItemButton({
  entry,
  currentPath,
  translate,
  collapsed,
  rowGap,
  nested,
  onNavigate,
  onTooltip,
  onTooltipHide,
  labelClass,
}: NavItemButtonProps) {
  const paths = [entry.path, ...(entry.aliases ?? [])];
  const isActive = paths.includes(currentPath);
  const label = translate(entry.labelKey, entry.fallback);
  const Icon = entry.icon;

  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      data-active={isActive ? 'true' : undefined}
      data-testid={`nav-item-${entry.id}`}
      onClick={() => onNavigate(entry.path)}
      onMouseEnter={collapsed && onTooltip ? event => onTooltip(label, event.currentTarget) : undefined}
      onMouseLeave={collapsed ? onTooltipHide : undefined}
      onFocus={collapsed && onTooltip ? event => onTooltip(label, event.currentTarget) : undefined}
      onBlur={collapsed ? onTooltipHide : undefined}
      className={cn(
        'app-nav-item',
        rowGap,
        nested && 'app-nav-item--nested',
        collapsed && 'justify-center px-0',
      )}
    >
      <Icon className="app-nav-icon" aria-hidden="true" />
      <span className={cn('min-w-0 flex-1 truncate text-left', labelClass)}>{label}</span>
    </button>
  );
}

interface NavGroupRowProps {
  group: Extract<NavEntry, { items: unknown[] }>;
  currentPath: string;
  translate: (key: string, fallback: string) => string;
  collapsed: boolean;
  rowGap: string;
  variant: 'desktop' | 'drawer';
  open: boolean;
  onToggle: (groupId: string) => void;
  onNavigate: (path: string) => void;
  onTooltip?: (label: string, target: HTMLElement) => void;
  onTooltipHide?: () => void;
  labelClass: string;
  idPrefix: string;
}

function NavGroupRow({
  group,
  currentPath,
  translate,
  collapsed,
  rowGap,
  variant,
  open,
  onToggle,
  onNavigate,
  onTooltip,
  onTooltipHide,
  labelClass,
  idPrefix,
}: NavGroupRowProps) {
  const childActive = group.items.some(child =>
    [child.path, ...(child.aliases ?? [])].includes(currentPath),
  );
  const label = translate(group.labelKey, group.fallback);
  const listId = `${idPrefix}-group-${group.id}`;
  const Icon = group.icon;
  // A group's row is a destination, not only a disclosure: it lands on the page
  // the user is already on when they are inside the group, otherwise on the
  // group's first (primary) page. Without this the parent row would be a dead
  // end for mouse users and for one-tap mobile use.
  const activeChild = group.items.find(child =>
    [child.path, ...(child.aliases ?? [])].includes(currentPath),
  );
  const landingPath = (activeChild ?? group.items[0]).path;
  const tooltipHandlers = {
    onMouseEnter:
      collapsed && onTooltip
        ? (event: MouseEvent<HTMLElement>) => onTooltip(label, event.currentTarget)
        : undefined,
    onMouseLeave: collapsed ? onTooltipHide : undefined,
    onFocus:
      collapsed && onTooltip
        ? (event: FocusEvent<HTMLElement>) => onTooltip(label, event.currentTarget)
        : undefined,
    onBlur: collapsed ? onTooltipHide : undefined,
  };

  // Collapsed desktop sidebar: no room for a disclosure, so the group becomes a
  // single icon that opens its landing page (the tooltip names the group). The
  // full tree stays one click away — the collapse toggle re-expands the sidebar.
  if (collapsed) {
    return (
      <button
        type="button"
        data-active-descendant={childActive ? 'true' : undefined}
        data-testid={`nav-group-${group.id}`}
        onClick={() => onNavigate(landingPath)}
        {...tooltipHandlers}
        className="app-nav-item app-nav-item--group min-h-11 justify-center px-0"
      >
        <Icon className="app-nav-icon" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
    );
  }

  return (
    <>
      <div className={cn('app-nav-group-row', rowGap)}>
        <button
          type="button"
          data-active-descendant={childActive ? 'true' : undefined}
          data-testid={`nav-group-${group.id}`}
          onClick={() => onNavigate(landingPath)}
          className="app-nav-item app-nav-item--group"
        >
          <Icon className="app-nav-icon" aria-hidden="true" />
          <span className={cn('min-w-0 flex-1 truncate text-left', labelClass)}>{label}</span>
        </button>

        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${translate('nav.toggleGroup', 'Toggle')} ${label}`}
          data-testid={`nav-group-${group.id}-toggle`}
          onClick={() => onToggle(group.id)}
          className={cn(
            'app-nav-item-toggle',
            rowGap,
            variant === 'drawer' ? 'w-11' : 'w-9',
          )}
        >
          <ChevronDown className={cn('app-nav-chevron', open && 'app-nav-chevron--open')} aria-hidden="true" />
        </button>
      </div>

      {/* The wrapper stays mounted so the expand/collapse transition can run.
          `inert` keeps a closed group out of the tab order and the a11y tree. */}
      <div className="app-nav-submenu" data-open={open ? 'true' : 'false'} inert={!open ? true : undefined}>
        <ul id={listId} className="app-nav-sublist">
          {group.items.map(child => (
            <li key={child.id}>
              <NavItemButton
                entry={child}
                currentPath={currentPath}
                translate={translate}
                collapsed={false}
                rowGap={rowGap}
                nested
                onNavigate={onNavigate}
                onTooltip={onTooltip}
                onTooltipHide={onTooltipHide}
                labelClass="app-nav-label"
              />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
