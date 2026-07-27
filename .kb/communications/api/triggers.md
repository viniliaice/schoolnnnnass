---
type: Database Function
title: Message Permission Trigger
description: "Trigger that validates message sender/recipient permissions before insert — uses can_send_message() to enforce school hierarchy."
tags: [communications, api, triggers]
timestamp: 2026-07-27T00:00:00Z
---

trg_messages_validate_permissions trigger on messages table, firing BEFORE INSERT.
Calls can_send_message(NEW.senderId, NEW.recipientId) and raises EXCEPTION if not permitted.
From feature-schema.sql.

## Related

- [can_send_message](message-permissions.md) — Validator function called by this trigger
- [messages table](../data-model/messages.md) — Table this trigger is defined on
