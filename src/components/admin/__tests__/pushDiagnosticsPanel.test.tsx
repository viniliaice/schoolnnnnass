// @vitest-environment node
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../lib/supabase', () => ({
  isPlaceholderEnv: false,
  supabase: { auth: { getSession: vi.fn() } },
}));

import { PushDiagnosticsPanel } from '../PushDiagnosticsPanel';

describe('PushDiagnosticsPanel', () => {
  it('renders inspect and explicit test-push actions without claiming delivery before a run', () => {
    const html = renderToStaticMarkup(<PushDiagnosticsPanel />);
    expect(html).toContain('data-testid="push-diagnostics-panel"');
    expect(html).toContain('Inspect (no push sent)');
    expect(html).toContain('Test push to matching devices');
    expect(html).toContain('data-testid="diagnostics-teacher-id"');
    expect(html).toContain('otherwise it may reach active devices across the school.');
    expect(html).not.toContain('data-testid="diagnostics-summary"');
    expect(html).not.toContain('accepted the push');
  });
});
