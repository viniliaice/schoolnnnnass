# TODOS.md — MBK International School

Deferred work from CEO review (2026-08-02) — Family ID Generator.

## Release log + parent visibility
- **What:** Gate "release" tap records (student, family, staff, timestamp) to a `release_log` table; parents see their kids' releases in the portal.
- **Why:** Accountability layer for the wrong-parent incident — a record of who left with whom.
- **Pros:** Completes the safety story; cheap once the gate screen exists.
- **Cons:** Adds scope to M2; needs the gate screen to exist first.
- **Context:** Deferred in CEO review (Expansion 1). The M2 gate screen ships lookup-only; the release tap and log come after the core match proves out.
- **Effort:** M (human ~1-2 days / CC ~15 min)
- **Priority:** P2
- **Depends on:** Gate screen (M2) shipped.

## Offline-first gate mode
- **What:** Gate screen becomes a PWA that caches the family lookup table; works with zero connectivity (data labeled "as of last sync").
- **Why:** The gate is exactly where networks fail; if lookup is down, staff fall back to memory — the thing being eliminated.
- **Pros:** Gate never waits on the network; resilience where it matters.
- **Cons:** PWA/service-worker complexity; stale-data risk needs clear labeling.
- **Context:** Deferred in CEO review (Expansion 2). Decide after M2 pilot — if the gate has usable signal, this stays deferred.
- **Effort:** M (human ~1 day / CC ~20 min)
- **Priority:** P3
- **Depends on:** M2 pilot results (gate network reality).

## Gate access for Umal's team
- **What:** Confirm whether Umal Kharye Xuseen, Maxamed Aden, and Abdurahman Aw Nuux have app logins; if not, add supervisor accounts or a PIN-gated shared-device gate mode.
- **Why:** The gate screen is admin/supervisor-only by review decision (2026-08-02); the named gate team needs a way in.
- **Context:** Open question from CEO review (Issue 5/7). Do not build before confirming who needs access.
- **Effort:** S (human ~2-4 hrs / CC ~10 min)
- **Priority:** P2
- **Depends on:** Answer from school leadership.

## NOT in scope (rejected in CEO review 2026-08-02)
- Year-based ID renewal & bulk reprint (skipped — ad hoc reprint acceptable)
- Pickup-zone color bands (visual flourish; fold into card design later if wanted)
- SMS/WhatsApp release notifications (needs vendor decision; portal visibility deferred with release log)
- Pickup-time analytics dashboard (post-M3, if demand appears)

## E2E harness + gate-flow E2E tests
- **What:** Add Playwright E2E infra (config + a `gate-flow.e2e.ts` covering type-ID → kids shown, camera-scan → kids, hardware-scanner input) and wire into `test:ci`.
- **Why:** The gate flow is the safety-critical interaction; the user explicitly chose E2E over unit-only for it (eng review 2026-08-02).
- **Pros:** Highest-confidence coverage of the exact flow that prevents wrong-parent handoffs.
- **Cons:** Needs browser download (blocked in current sandbox) + a runnable Supabase test env; adds CI surface.
- **Context:** Decided in /plan-eng-review (2026-08-02). Unit tests for lookup logic ship in the build; this is the E2E layer deferred because the repo has no browser infra today. Playwright must be added to devDeps when this is picked up.
- **Effort:** M (human ~1 day / CC ~30 min)
- **Priority:** P2
- **Depends on:** M2 gate screen shipped; browser-available environment.

## DESIGN.md (design system doc) gap
- **What:** Create a minimal DESIGN.md capturing the existing `src/index.css` tokens (`--primary #0F4C3A`, gold `#C8A24A`, dark gradients) as the project's design system.
- **Why:** /plan-design-review (2026-08-02) found no DESIGN.md; the app has a coherent token system that isn't documented, so future features drift.
- **Pros:** Future design reviews calibrate against it; new features match the look.
- **Cons:** Doc maintenance; low urgency.
- **Context:** Existing tokens verified in src/index.css. Small doc, high leverage.
- **Effort:** S (human ~1h / CC ~5min)
- **Priority:** P3
- **Depends on:** —

## Parent portal card reprint link
- **What:** After M3 (family ID in portal), add a printable reminder-card link so parents can reprint a lost card.
- **Why:** Office prints the initial run (design decision 2026-08-02); reprints shouldn't need the office.
- **Pros:** Self-service; QR size/contrast caveat documented.
- **Cons:** Variable parent printers → scanning reliability risk (mitigate: fixed layout, min QR size).
- **Context:** Card-issuance decision in design review (office-first). Follow-up after M3.
- **Effort:** S (human ~2h / CC ~10min)
- **Priority:** P3
- **Depends on:** M3 parent portal family ID.
