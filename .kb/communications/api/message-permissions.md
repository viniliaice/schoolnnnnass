---
okf_version: "0.1"
title: "can_send_message"
type: Database Function
tags: [communications, api, security]
timestamp: 2026-07-27T00:00:00Z
description: "Role-based messaging permission validator — determines if sender can message recipient based on school hierarchy and class assignments."
source: feature-schema.sql
enforced_by: trg_messages_validate_permissions
---

# can_send_message

Role-based messaging permission validator. Determines whether a sender is allowed to message a recipient based on school hierarchy and class assignments.

## Permission Rules

| Sender Role | Allowed Recipients |
|-------------|-------------------|
| Admin | Anyone |
| Teacher | Parents of their enrolled students |
| Parent | Teachers of their children |

## Enforcement

Invoked automatically by the `trg_messages_validate_permissions` trigger on every `INSERT` into the `messages` table. If the function returns `false`, the insert is rejected.

## Returns

- `boolean` — `true` if the sender is permitted to message the recipient

## Cross-Bundle References

- `core:data-model/profiles` — Role and class assignment lookups
- `teaching:data-model/announcements` — Teacher-class mappings

## Related

- [messages table](../data-model/messages.md) — Table this function guards
- [RLS policies](../security/rls-policies.md) — Complementary row-level security
- [Message DB functions](message-functions.md) — Functions that invoke this validator
