---
title: "profiles"
type: Database Table
tags: [core, schema, auth]
timestamp: 2026-07-27T00:00:00Z
description: "User accounts table (teachers, admins, supervisors, parents) linked to Supabase auth. Serves as the identity hub for the entire system."
linked_concepts:
  - "core:data-model/students"
  - "core:data-model/class-subjects"
  - "core:ui/manage-users"
  - "core:security/rls-policies"
  - "core:api/get-system-stats"
  - "auth:supabase-auth"
  - "timetable:data-model/teacher-availability"
  - "attendance:data-model/attendance"
  - "finance:data-model/fees"
  - "communications:data-model/notifications"
---

# profiles

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key, matches Supabase auth.users id |
| `name` | `text` | Full display name |
| `email` | `text` | Login email |
| `password` | `text` | Hashed password |
| `role` | `text` | One of: `admin`, `teacher`, `parent`, `supervisor` |
| `phone1` | `text` | Primary phone number |
| `phone2` | `text` | Secondary phone number |
| `xafada` | `text` | Custom field (clan/neighborhood) |
| `udow` | `text` | Custom field (sub-clan) |
| `paymentnumber` | `text` | Payment identifier |
| `assignedClasses` | `jsonb` | JSON array of class names assigned to teacher/supervisor |
| `assignedSubjects` | `jsonb` | JSON array of subject IDs assigned to teacher |
| `fcm_token` | `text` | Firebase Cloud Messaging push token |
| `auth_id` | `text` | FK → auth.users.id |
| `photo_url` | `text` | Profile photo URL |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Indexes

| Name | Column(s) |
|------|-----------|
| `idx_users_role` | `role` |

## Notes

- `role` enum: `admin | teacher | parent | supervisor`
- `assignedClasses` and `assignedSubjects` are JSONB for flexible querying without join tables.
- Linked to Supabase `auth.users` via `auth_id` for authentication.

## Related

* [ManageUsers](../ui/manage-users.md) — UI for CRUD on profiles.
* [Students](students.md) — `parentId` FK targets `profiles.id`.
* [ClassSubjects](class-subjects.md) — `teacherId` FK targets `profiles.id`.
* [RLS Policies (Core)](../security/rls-policies.md) — row-level security for this table.
* [get_system_stats (Core)](../api/get-system-stats.md) — counts profiles by role.
