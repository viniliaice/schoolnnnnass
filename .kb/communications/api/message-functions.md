---
okf_version: "0.1"
title: "Message & Announcement DB Functions"
type: Database Function
tags: [communications, api]
timestamp: 2026-07-27T00:00:00Z
description: "CRUD functions for messages and announcements."
source: feature-schema.sql
---

# Message & Announcement DB Functions

## Message Functions

| Function | Description |
|----------|-------------|
| `getMessagesForUser(userId)` | Returns all messages where the user is sender or recipient |
| `getAllowedMessageRecipients(senderId)` | Returns profiles the sender may message per `can_send_message` rules |
| `sendMessage(senderId, recipientId, subject, body)` | Inserts a new message (permission check via trigger) |
| `markMessageRead(messageId)` | Sets `readAt` timestamp for the given message |

## Announcement Functions

| Function | Description |
|----------|-------------|
| `broadcastClassAnnouncement(className, message, createdBy)` | Creates announcement and inserts `announcement_recipients` rows for all parents of students in that class |
| `getAnnouncementsForParent(parentId)` | Returns announcements delivered to a parent |
| `getAnnouncementsByCreator(creatorId)` | Returns announcements created by a specific user |
| `deleteAnnouncement(announcementId)` | Soft/hard deletes an announcement and its recipient rows |

## Cross-Bundle References

- `core:data-model/profiles` — User and role lookups
- `teaching:data-model/announcements` — Class and enrollment context

## Related

- [messages table](../data-model/messages.md) — Underlying table for message functions
- [announcements table](../data-model/announcements.md) — Underlying table for announcement functions
- [can_send_message](message-permissions.md) — Permission gate enforced on `sendMessage`
- [MessagesPage UI](../ui/messages-page.md) — Client UI that consumes these functions
