---
type: Overview
title: MBK International School — Project Overview
description: A React + Supabase school management application for MBK International School
resource: schoolnnnnass/README.md
tags: [overview, project, react, supabase]
timestamp: 2026-07-27T00:00:00Z
---

# MBK International School

A complete school management system built with React, Vite, and Supabase. Manages students, teachers, parents, and supervisors across 9 feature domains.

## Quick start

```bash
npm install
cp .env.example .env  # Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

## Documentation

| Type | Description |
|------|-------------|
| [docs/README.md](docs/README.md) | Full documentation index |
| [.kb/index.md](.kb/index.md) | Reference documentation (170 concept files) |
| [docs/tutorials/](docs/tutorials/) | Step-by-step learning paths for each role |
| [docs/how-tos/](docs/how-tos/) | Task-oriented guides for common operations |
| [docs/explanations/](docs/explanations/) | Architecture and design rationale |

## Roles

| Role | Access |
|------|--------|
| Admin | Full system management — users, classes, exams, academic calendar |
| Teacher | Class-specific — enter grades, attendance, homework, quizzes, lesson plans |
| Parent | Child-specific — view reports, monitor progress, take quizzes |
| Supervisor | Oversight — verify exams, review lesson plans, monitor teachers |

## Tech stack

- **Frontend:** React 19, Vite 7, Tailwind CSS 4, React Router 7
- **Backend:** Supabase (PostgreSQL, Auth, RLS, Edge Functions)
- **State:** TanStack React Query
- **Build:** Single-file output via vite-plugin-singlefile

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript type check |
| `npm run test` | Run tests |
| `npm run validate` | Type check + tests + build |
