# Investigation — Family IDs page performance

Date: 2026-08-04  
Scope: `/admin/family-ids` (`src/pages/admin/FamilyIds.tsx`)

## Findings

1. **Initial load did extra work for printing.**
   The page fetched every parent profile name immediately after loading students, even though parent names are only needed when staff preview or download family-card PDFs. This made the Family IDs dashboard wait on a second network query before leaving the loading state.

2. **Print-card data was prepared eagerly.**
   `AsyncPrintLink` built card data on mount/filter changes. PDF generation itself was already click-triggered, but the data prep and parent-name dependency still belonged on the print action path, not the page-load path.

3. **PDF cache could survive layout changes.**
   The generated blob cache was not reset when `layout` or `withLookup` changed, so a user could prepare one layout, switch options, and download/preview stale output.

4. **Progress toward the 200-family goal was not visible.**
   Admins could see total families, but not the requested rollout progress (for example, `14 of 200`).

## Changes made

- Removed the eager parent-name fetch from `reload()` so the main dashboard renders after the student query only.
- Moved parent-name loading and `buildFamilyCardData()` into the Preview/Download action path.
- Kept the generated PDF blob cached after first preparation, but now invalidates that cache when families, layout, or lookup-list settings change.
- Added an accessible progress bar showing current families out of the 200 target. If production has 14 generated families, the bar reads **14 of 200** (7%).

## Expected impact

- Faster initial Family IDs page load, especially with many parents/families.
- Less background work when admins only need to review/import/generate and are not printing yet.
- Correct print preview/download after changing print options.
