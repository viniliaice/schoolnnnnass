---
title: "RLS Policies (Core)"
type: Security Policy
tags: [core, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "Row-level security for profiles and students tables — admin full access, role-based read/write restrictions."
linked_concepts:
  - "core:data-model/profiles"
  - "core:data-model/students"
  - "core:ui/manage-users"
  - "core:ui/manage-students"
  - "auth:supabase-auth"
  - "auth:session-management"
---

# RLS Policies

**Migrations:** `20260708_profiles_auth_session_rls.sql`

## profiles

| Policy | Target | Effect |
|--------|--------|--------|
| Users read own profile | `SELECT` | `auth_id = auth.uid()` |
| Admins read all profiles | `SELECT` | `auth.jwt() ->> 'role' = 'admin'` |
| Admins write all profiles | `INSERT/UPDATE/DELETE` | `auth.jwt() ->> 'role' = 'admin'` |

## students

| Policy | Target | Effect |
|--------|--------|--------|
| Admins read all | `SELECT` | `auth.jwt() ->> 'role' = 'admin'` |
| Teachers/supervisors read assigned | `SELECT` | `className` IN user's `assignedClasses` (JSONB containment) |
| Parents read own children | `SELECT` | `parentId` = user's profile `id` |
| Admins write all | `INSERT/UPDATE/DELETE` | `auth.jwt() ->> 'role' = 'admin'` |

## Related

* [Profiles](../data-model/profiles.md) — secured by the `profiles` policies above.
* [Students](../data-model/students.md) — secured by the `students` policies above.
* [ManageUsers](../ui/manage-users.md) — admin UI governed by these policies.
* [ManageStudents](../ui/manage-students.md) — admin UI governed by these policies.
