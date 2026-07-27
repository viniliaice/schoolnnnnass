---
okf_version: "0.1"
title: "messages"
type: Database Table
tags: [communications, schema]
timestamp: 2026-07-27T00:00:00Z
description: "Direct messages between users with read tracking."
source: feature-schema.sql
---

# messages

Direct messages between users with read tracking.

## Columns

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | text | `PRIMARY KEY` | Unique message identifier |
| `senderId` | text | `FK → profiles.id` | User who sent the message |
| `recipientId` | text | `FK → profiles.id` | User who received the message |
| `subject` | text | | Message subject line |
| `body` | text | | Message body content |
| `readAt` | timestamptz | | Nullable — set when recipient opens the message |
| `createdAt` | timestamptz | | Auto-generated creation timestamp |

## Cross-Bundle References

- `core:data-model/profiles` — `senderId` and `recipientId` reference `profiles.id`

## Related

- [can_send_message](../api/message-permissions.md) — `can_send_message` validator
- [Message DB functions](../api/message-functions.md) — CRUD functions for messages
- [RLS policies](../security/rls-policies.md) — Row-level security on this table
- [MessagesPage UI](../ui/messages-page.md) — Client UI for viewing messages
