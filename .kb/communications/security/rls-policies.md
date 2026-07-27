---
okf_version: "0.1"
title: "RLS Policies (Communications)"
type: Security Policy
tags: [communications, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "Message RLS — users read own sent/received; announcement RLS — admins full, teachers create for own classes."
source: feature-schema.sql
---

# RLS Policies

## messages

| Policy | Operation | Rule |
|--------|-----------|------|
| `messages_select_policy` | `SELECT` | `senderId = current_user_id() OR recipientId = current_user_id()` |
| `messages_insert_policy` | `INSERT` | `senderId = current_user_id()` (further validated by `trg_messages_validate_permissions`) |

Users may only read messages they sent or received, and may only insert messages as themselves.

## announcements

| Policy | Operation | Rule |
|--------|-----------|------|
| `announcements_select_policy` | `SELECT` | Admin: all rows; Teacher: `className IN (own classes)`; Parent: `announcementId IN (announcement_recipients rows for this user)` |
| `announcements_insert_policy` | `INSERT` | Admin: all classes; Teacher: `className IN (own classes)` |
| `announcements_delete_policy` | `DELETE` | Admin only |

## announcement_recipients

| Policy | Operation | Rule |
|--------|-----------|------|
| `ar_select_policy` | `SELECT` | `parentId = current_user_id()` (parents see their own delivery records) |

Permissions are granted to appropriate roles via `GRANT` statements in `feature-schema.sql`.

## Related

- [can_send_message](../api/message-permissions.md) — Complementary trigger-based permission enforcement
- [messages table](../data-model/messages.md) — Table with RLS applied
- [announcements table](../data-model/announcements.md) — Tables with RLS applied
- [MessagesPage UI](../ui/messages-page.md) — Client UI governed by these policies
