---
title: "ManageUsers"
type: UI Page
tags: [core, ui, admin]
timestamp: 2026-07-27T00:00:00Z
description: "Admin CRUD interface for all user accounts — create, edit, delete, reset passwords."
linked_concepts:
  - "core:data-model/profiles"
  - "core:security/rls-policies"
  - "core:api/get-system-stats"
  - "auth:supabase-auth"
---

# ManageUsers

- **Route:** `/admin/users`
- **Data layer:** `lib/db/profiles.ts`
- **Access:** Admin only

## Features

- List all users with search and filter by role
- Create new user accounts (auto-creates Supabase auth entry)
- Edit user details (name, email, phone, role, assigned classes/subjects)
- Delete user accounts
- Reset user passwords
- Assign classes and subjects to teachers/supervisors via JSONB fields

## Related

* [Profiles](../data-model/profiles.md) — underlying table for this UI.
* [RLS Policies (Core)](../security/rls-policies.md) — RLS enforcing admin-only access.
* [get_system_stats (Core)](../api/get-system-stats.md) — counts users by role.
