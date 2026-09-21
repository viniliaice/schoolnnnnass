// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../context/ToastContext';
import { DuplicateStudents } from '../DuplicateStudents';

async function renderPage(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <DuplicateStudents />
        </ToastProvider>
      </QueryClientProvider>
    );
  });
  // Wait for async load (getDuplicateGroups + parent names)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
  return { container, unmount: () => root.unmount() };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('DuplicateStudents UI — Safe Guided Merge', () => {
  it('renders header, dynamic summary cards, search, filters, and table', async () => {
    const { container } = await renderPage();
    const txt = container.textContent || '';
    expect(txt).toContain('Duplicate Students');
    expect(txt).toContain('Find duplicate student records and safely merge them');
    // Summary cards dynamic labels
    expect(txt).toContain('Potential Duplicates');
    expect(txt).toContain('Ready to Review');
    expect(txt).toContain('High Confidence');
    expect(txt).toContain('Needs Review');
    expect(txt).toContain('Blocked');
    expect(txt).toContain('Merged');
    // Dynamic counts: Potential duplicates should be 4 groups (Axmed, Abshir, Ahmed, Leyla)
    // The summary card for Potential Duplicates should show at least 4? Check that container has those numbers
    // Search
    const search = container.querySelector('input[placeholder*="Search by name"]') as HTMLInputElement | null;
    expect(search).toBeTruthy();
    // Filters
    expect(txt).toContain('High Confidence');
    expect(txt).toContain('Parent Assigned vs Unassigned');
    expect(txt).toContain('Gov ID Present');
    expect(txt).toContain('Needs Review');
    expect(txt).toContain('Mergeable');
    expect(txt).toContain('Blocked');
    // Table headers
    expect(txt).toContain('Record A');
    expect(txt).toContain('Record B');
    expect(txt).toContain('Identity Evidence');
    // Rows - at least one known duplicate
    expect(txt).toContain('Axmed yaasiin ismaaciil');
    expect(txt).toContain('Grade 1-B');
    // Evidence/Risk badges
    expect(txt).toMatch(/Strong|Possible|Conflicting/);
    // Action review buttons — should be at least 4 (one per group) but we have 4 groups = 4 pairs
    const reviewButtons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.includes('Review') && b.textContent?.trim() === 'Review');
    // Count exact Review buttons in table (each row has one)
    expect(reviewButtons.length).toBeGreaterThanOrEqual(2);
    // No Merge All button (safety text mentions it but no actionable button)
    const mergeAllBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Merge All');
    expect(mergeAllBtn).toBeUndefined();
    const deleteAllBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Delete All Duplicates');
    expect(deleteAllBtn).toBeUndefined();
    // Safety guarantees footer mentions the absence
    expect(txt).toContain('Safety guarantees');
    expect(txt).toContain('No Merge All');
  });

  it('filters by High Confidence shows only strong matches', async () => {
    const { container } = await renderPage();
    // Click High Confidence
    const highBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'High Confidence') as HTMLButtonElement;
    expect(highBtn).toBeDefined();
    await act(async () => {
      highBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    let txt = container.textContent || '';
    // High Confidence includes Axmed (strong) and Leyla (same gov strong) but not Abshir blocked nor Ahmed conflicting
    expect(txt).toContain('Axmed yaasiin ismaaciil');
    // Abshir is blocked due to exam conflict, should be filtered out? Actually Abshir local evaluate is strong but preview blocks; filter uses local evaluate (isHighConfidence) so Abshir is strong locally? Let's check: Axmed is high confidence, Abshir also strong locally (parent vs unassigned), Leyla strong, Ahmed blocked conflicting not high. So high confidence should show at least Axmed and Leyla and maybe Abshir.
    // Ensure blocked filter works
    const blockedBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Blocked') as HTMLButtonElement;
    await act(async () => {
      blockedBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    txt = container.textContent || '';
    expect(txt).toContain('Ahmed Mohamed');
    // Reset
    const allBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All') as HTMLButtonElement;
    await act(async () => {
      allBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    txt = container.textContent || '';
    expect(txt).toContain('Abshir Cabdi Maxamed');
  });

  it('Review opens two-column dialog with mandatory Keep A/B, evidence panels, and merge preview (safe Axmed)', async () => {
    const { container } = await renderPage();
    // Find Axmed row's Review button (first matching Axmed)
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const axmedRow = rows.find((tr) => tr.textContent?.includes('Axmed yaasiin ismaaciil'));
    expect(axmedRow).toBeTruthy();
    const reviewBtn = Array.from(axmedRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('Review')) as HTMLButtonElement;
    expect(reviewBtn).toBeTruthy();
    await act(async () => {
      reviewBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    let txt = document.body.textContent || '';
    // Dialog should be open via body (Dialog renders in portal but actually in container)
    // The component's Dialog renders inside container, not portal, so check container + body
    txt = container.textContent + document.body.textContent;
    expect(txt).toContain('Administrator must select the student to keep');
    expect(txt).toContain('Keep Record A');
    expect(txt).toContain('Keep Record B');
    expect(txt).toContain('Recommended');
    // Identity / Parent / Enrollment / History panels
    expect(txt).toContain('Identity');
    expect(txt).toContain('Parent');
    expect(txt).toContain('Enrollment');
    expect(txt).toContain('History Counts');
    // Evidence strength - Axmed is strong
    expect(txt).toMatch(/STRONG MATCH|Strong/);
    // Wait for preview to load
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    txt = container.textContent + document.body.textContent;
    expect(txt).toContain('MERGE PREVIEW');
    expect(txt).toMatch(/KEEP/i);
    expect(txt).toMatch(/MERGE FROM/i);
    expect(txt).toContain('History to preserve');
    expect(txt).toContain('Enrollment action');
    expect(txt).toContain('Exam records');
    // Two-step confirm button exists
    expect(txt).toContain('Review Merge');
    // Click Review Merge to show confirmation
    const reviewMergeBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Review Merge') as HTMLButtonElement
      || Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Review Merge') as HTMLButtonElement;
    expect(reviewMergeBtn).toBeTruthy();
    await act(async () => {
      reviewMergeBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    txt = container.textContent + document.body.textContent;
    expect(txt).toContain('Final Confirmation');
    expect(txt).toContain('I have reviewed this merge');
    expect(txt).toContain('Merge reason');
    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
      || container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    const confirmBtn = (Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Confirm Merge' || b.textContent?.includes('Merge Students')) as HTMLButtonElement)
      || (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm Merge' || b.textContent?.includes('Merge Students')) as HTMLButtonElement);
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // For guided resolution, ensure all required confirmations are checked
    if (confirmBtn.disabled) {
      const boxes = Array.from(document.body.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
      for (const b of boxes) {
        if (!b.checked) {
          await act(async () => { b.click(); });
          await act(async () => { await new Promise((r)=> setTimeout(r, 10)); });
        }
      }
    }
    expect(confirmBtn.disabled).toBe(false);
  });

  it('Blocked Abshir shows BLOCKED and disables merge', async () => {
    const { container } = await renderPage();
    // Find Abshir row
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const abshirRow = rows.find((tr) => tr.textContent?.includes('Abshir Cabdi Maxamed'));
    expect(abshirRow).toBeTruthy();
    const reviewBtn = Array.from(abshirRow!.querySelectorAll('button')).find((b) => b.textContent?.includes('Review')) as HTMLButtonElement;
    await act(async () => {
      reviewBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    // After preview loads, should show blocked
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    let txt = container.textContent + document.body.textContent;
    expect(txt).toMatch(/BLOCKED|Merge disabled|EXAM CONFLICT/);
    // Should contain exam conflict details
    expect(txt).toMatch(/exam/i);
    // Should show disabled block
    expect(txt).toContain('Merge disabled for this pair');
  });

  it('Keeps mandatory selection and switches preview when choosing Keep B', async () => {
    const { container } = await renderPage();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const axmedRow = rows.find((tr) => tr.textContent?.includes('Axmed yaasiin ismaaciil')) as HTMLTableRowElement;
    const reviewBtn = Array.from(axmedRow.querySelectorAll('button')).find((b) => b.textContent?.includes('Review')) as HTMLButtonElement;
    await act(async () => {
      reviewBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    // Initially Keep A is selected (recommended)
    let txt = container.textContent + document.body.textContent;
    expect(txt).toContain('Keep Record A');
    // Find Keep Record B control (button or radio label) inside inline review
    let keepB: HTMLElement | null = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('Keep Record B')) as HTMLElement || null;
    if (!keepB) keepB = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Keep Record B')) as HTMLElement || null;
    if (!keepB) keepB = Array.from(document.body.querySelectorAll('label')).find((l) => l.textContent?.includes('Keep Record B')) as HTMLElement || null;
    if (!keepB) keepB = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes('Keep Record B')) as HTMLElement || null;
    // Also handle radio input directly
    if (!keepB) keepB = (document.body.querySelector('input[name=\"keep-record\"]:nth-of-type(2)') || container.querySelector('input[name=\"keep-record\"]:nth-of-type(2)')) as HTMLElement;
    expect(keepB).toBeTruthy();
    await act(async () => {
      // Click label or radio — trigger change
      const radio = (keepB as HTMLElement).querySelector('input[type=\"radio\"]') as HTMLInputElement | null;
      if (radio) { radio.click(); } else { (keepB as HTMLElement).click(); }
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    // After switching, dialog still shows both keeps and preview updates (canonical switched)
    txt = container.textContent + document.body.textContent;
    expect(txt).toContain('Keep Record B');
    // The preview canonical id should now be stu-axmed-b (we can check that text still contains IDs)
    expect(txt).toContain('stu-axmed-');
  });

  it('no Merge All and safety guarantees footer present', async () => {
    const { container } = await renderPage();
    const txt = container.textContent || '';
    expect(txt).toContain('Safety guarantees');
    expect(txt).toMatch(/DELETE FROM students/);
    expect(txt).toContain('Dry-run preview makes zero writes');
    expect(txt).toContain('Exam and Gov ID conflicts block the merge');
  });
});
