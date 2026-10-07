// @vitest-environment node
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { auth: { getSession: vi.fn() } } }));
vi.mock('../../../lib/supabase', () => ({ supabase: supabaseMock, isPlaceholderEnv: false }));

import { PushDiagnosticsPanel } from '../PushDiagnosticsPanel';

describe('PushDiagnosticsPanel', () => {
  it('renders both inspection and test-push actions without claiming a result before running', () => {
    const html = renderToStaticMarkup(<PushDiagnosticsPanel />);
    expect(html).toContain('data-testid="push-diagnostics-panel"');
    expect(html).toContain('Inspect (no push sent)');
    expect(html).toContain('Test push to each device');
    expect(html).not.toContain('data-testid="diagnostics-summary"');
  });
});
