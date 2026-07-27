---
type: Config
title: Agent Configuration
description: OKF skill configuration and available playbooks for this repository
resource: AGENTS.md
tags: [okf, config]
timestamp: 2026-07-27T00:00:00Z
---

# AGENTS.md — MBK International School AI Project Map

## Before doing anything else
Read this file first. Do NOT run a full codebase scan or glob the entire repo to "understand the project" — everything you need to locate relevant code is listed below. Only read files outside this map if a task explicitly requires something not covered here, and even then, search narrowly (specific folder, not root).

## Stack
Next.js (App Router) + Supabase. School web app — [fill in: parent portal / admin dashboard / student-facing, etc.].

## Where things live
[Fill in your key file directories here]

## Full knowledge base — check this before scanning the repo
This project has a structured knowledge base at `.kb/` covering all 9 feature domains (90 concept files): schema, RLS policies, UI pages, API functions. Before grep-ing or globbing the codebase to understand a feature, read `.kb/index.md` first, then the relevant bundle's index.md — e.g. `.kb/exams/index.md`, `.kb/lesson-plans/index.md`.

Only fall back to a broader repo scan if `.kb/` doesn't cover what you need, and even then, search narrowly (one folder, not root).

## Do NOT touch without explicit instruction
* [list stable, working systems here — e.g. auth/session middleware, push/email notification setup, payment/billing integration, existing grading logic]
* Anything in `supabase/migrations/` that's already applied — only add new migration files, never edit old ones.

## Working rules
1. **Plan before code.** For any multi-step task, output a short plan (files touched, schema changes, net-new vs reused) and wait for confirmation before writing code.
2. **No full scans.** Use this map + targeted file reads. If you genuinely need to search broadly, say so and narrow to one folder at a time.
3. **Extend, don't rewrite.** Prefer adding props/fields/functions to existing files over refactoring or duplicating them.
4. **One phase at a time.** For multi-phase work, stop after each phase, run a type/build check, and report before continuing — don't chain phases without a checkpoint.
5. **Type check filtering.** After changes, run `tsc` (or your build/lint step) and report only NEW errors — cross-reference against known pre-existing errors (ask me if unsure which are pre-existing).
6. **Client vs Server.** Note whether a component is a Server Component or needs `'use client'` before touching it — don't add client-only hooks (useState, useEffect) into a Server Component without adding the directive, and don't add it needlessly to files that don't need it.

---

## Agent Configuration

### okf skill
* **Path:** `.opencode/skill/okf`
* **Installed via:** `okf skill .opencode/skill/okf --here --force`
* **CLI:** `okf` (gem install okf)
* **Playbooks available:**
  * consume.md
  * curate.md
  * doctor.md
  * maintain.md
  * menu.md
  * migrate.md
  * produce.md
  * refine.md
  * search.md
  