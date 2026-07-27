---
okf_version: "0.1"
title: "MessagesPage"
type: UI Page
tags: [communications, ui, shared]
timestamp: 2026-07-27T00:00:00Z
description: "Shared messaging inbox available to all roles — send, receive, and read messages."
route: /messages
---

# MessagesPage

Shared messaging inbox available to all roles.

## Features

- **Inbox view** — lists received messages, ordered by `createdAt` descending
- **Sent view** — lists sent messages
- **Compose** — new message form, recipient constrained by `can_send_message` rules via `getAllowedMessageRecipients`
- **Read tracking** — unread messages visually distinguished; `markMessageRead` called on open

## Route

`/messages`

## Roles

All authenticated users (Admin, Teacher, Parent).

## Related

- `data-model/messages.md` — Backing table
- `api/message-functions.md` — Backing API functions
- `api/message-permissions.md` — Recipient constraint logic
