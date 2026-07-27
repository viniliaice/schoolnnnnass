---
title: "announcements (Teaching)"
type: Database Table
tags: [teaching, schema, announcements]
timestamp: 2026-07-27T00:00:00Z
description: "Class announcements broadcast to parents."
linked_concepts:
  - teaching:security/rls-policies
  - communications:api/notification-api
---

# `announcements`

**Source:** `feature-schema.sql`

Class announcements broadcast to parents and other stakeholders.

## Columns

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK |
| `className` | text | |
| `message` | text | |
| `createdBy` | text | |
| `createdAt` | timestamptz | |

## Related

* [Announcement Functions](../api/announcement-api.md) — CRUD functions for this table.
* [RLS Policies (Teaching)](../security/rls-policies.md) — row-level security for this table.
