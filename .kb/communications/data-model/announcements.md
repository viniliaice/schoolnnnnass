---
okf_version: "0.1"
title: "announcements (Communications)"
type: Database Table
tags: [communications, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Class-wide announcements broadcast by teachers and admins."
source: feature-schema.sql
---

# announcements

Class-wide announcements broadcast by teachers and admins.

## Columns

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | `PRIMARY KEY` | Unique announcement identifier |
| `className` | text | | Target class for the announcement |
| `message` | text | | Announcement body |
| `createdBy` | text | | User who created the announcement |
| `createdAt` | timestamptz | | Auto-generated creation timestamp |

## announcement_recipients

Junction table tracking parent delivery of announcements.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | `PRIMARY KEY` | Unique row identifier |
| `announcementId` | text | `FK → announcements.id` | Related announcement |
| `parentId` | text | `FK → profiles.id` | Parent recipient |
| | | `UNIQUE(announcementId, parentId)` | Prevents duplicate delivery records |

## Cross-Bundle References

- `core:data-model/profiles` — `createdBy` and `parentId` reference `profiles.id`
- `teaching:data-model/announcements` — Upstream announcement concept

## Related

- [Message DB functions](../api/message-functions.md) — `broadcastClassAnnouncement`, `getAnnouncementsForParent`
- [RLS policies](../security/rls-policies.md) — Row-level security on this table
- [Class announcements UI](../ui/class-announcements.md) — Client UI for announcements
