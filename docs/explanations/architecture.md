# Architecture Overview

Why the system is built this way, and how the pieces fit together.

## The problem

Schools need a centralized system to manage students, teachers, exams, and reports. Existing solutions are either too complex (enterprise SaaS) or too simple (spreadsheets). MBK International School needs something in between: a web app that handles the full academic workflow while staying simple enough for non-technical staff.

## The approach

### Frontend: React + Vite + Tailwind

**Why React:** Component-based UI fits the dashboard pattern — each role has different views, but they share common UI elements (tables, forms, modals). React's composition model makes this natural.

**Why Vite:** Fast dev server, standard production build with content-hashed `/assets/*` JS/CSS. Hashed filenames are immutable, so browsers and the CDN cache them long-term and a deploy only re-downloads what actually changed. (The project originally shipped as one inlined HTML file via `vite-plugin-singlefile`; that was removed once the app grew serverless API routes and a service worker, which already require a real host.)

**Why Tailwind CSS:** Utility-first CSS eliminates the need for a custom design system. The theming system (Acanthus, Baroque, Aurora) uses CSS custom properties that Tailwind's `@theme` directive can reference.

### Backend: Supabase

**Why Supabase:** It provides PostgreSQL, authentication, row-level security, and edge functions in one platform. For a school app, this means:

- **PostgreSQL:** relational data model fits students → exams → reports perfectly
- **Auth:** email/password login with session management
- **RLS:** teachers can only see their own classes, parents only their children
- **Edge Functions:** the AI lesson plan review runs as a Supabase edge function

### Client-side routing

**Why not a router library:** The app uses a simple `switch` statement on `currentPath` in `App.tsx`. Each role has its own route set. This is intentional — the app is small enough that a full router library would add complexity without benefit.

The routing works like this:

```
User logs in → RoleContext determines role → App.tsx switches on path → correct page renders
```

### State management

**Why React Query:** Server state (exams, students, reports) is cached and refetched automatically. Local state (UI toggles, form inputs) stays in component state. No global store needed.

```
Server state → TanStack React Query (cache, refetch, background sync)
UI state → useState/useContext (RoleContext, ToastContext)
```

## Key design decisions

### Role-based access at the component level

Each role has its own set of pages. The `AppContent` component checks `session.role` and renders the appropriate route set. This means:

- Admin sees all management pages
- Teacher sees class-specific pages
- Parent sees child-specific pages
- Supervisor sees monitoring pages

There's no shared routing table — each role's routes are explicit.

### Exams as the central entity

Everything revolves around exams:

```
Students → take Exams → per Subject → per Month → in Classes
Teachers → enter Exams → for their assigned Classes
Supervisors → verify Exams → before Parents see them
Parents → view Exam results → on Reports
```

This flow determines the entire data model and UI structure.

### Hashed-asset deployment

The production build emits a small `index.html` plus content-hashed files under `/assets/`. This means:

- `index.html` stays tiny and always revalidates, so deploys propagate immediately
- `/assets/*` filenames change only when their content changes, so they are cached as immutable (browser + CDN)
- A small code change re-downloads only the changed chunk, not the whole app
- The service worker precaches the entry JS/CSS (stamped at build time), so offline-after-first-load still works

## Trade-offs

**What was gained:**
- Cheap deploys (immutable hashed assets; only changed files re-download)
- Fast development (Vite HMR)
- Type safety (TypeScript throughout)
- Security (Supabase RLS)

**What was given up:**
- Server-side rendering (SEO doesn't matter for a school app)
- Code splitting (single file means everything loads at once)
- Traditional routing (no URL-based navigation, no browser back button)
- Offline-first (requires network for Supabase calls)

## Alternatives considered

**Next.js:** Would add SSR and routing, but the single-file deployment goal conflicts with Next.js's server-side model. The app doesn't need SEO.

**Firebase:** Similar to Supabase but less SQL-friendly. The relational data model (students → exams → reports) benefits from PostgreSQL's JOIN capabilities.

**Custom backend:** More control but more maintenance. Supabase handles auth, database, and edge functions — the three things a school app needs.
