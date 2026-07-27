---
okf_version: "0.1"
title: "StreamsPage"
type: UI Page
tags: [communications, ui, shared]
timestamp: 2026-07-27T00:00:00Z
description: "Activity feed showing recent attendance and homework events across classes."
route: /streams
---

# StreamsPage

Activity feed showing recent attendance and homework events across classes.

## Features

- **Activity feed** — chronologically ordered events from attendance and homework modules
- **Per-class filter** — narrow feed to a specific class
- **Event types** — attendance recorded, homework assigned, homework submitted, homework graded

## Route

`/streams`

## Roles

All authenticated users. Teachers see their own classes; admins see all classes; parents see their children's classes.

## Cross-Bundle References

- `attendance:api/events` — Attendance events in the stream
- `homework:api/events` — Homework events in the stream

## Related

- `data-model/messages.md` — Messages table (indirect — stream is read-only)
