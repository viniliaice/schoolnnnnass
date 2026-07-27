---
okf_version: "0.1"
title: "ClassAnnouncements"
type: UI Page
tags: [communications, ui, admin, teacher]
timestamp: 2026-07-27T00:00:00Z
description: "Create and manage class announcements. Admin sees all classes, teacher sees own."
routes:
  - /admin/announcements
  - /teacher/announcements
---

# ClassAnnouncements

Create and manage class announcements.

## Features

- **Create announcement** — select class (admin: all classes; teacher: own classes), write message, broadcast
- **List announcements** — view past announcements, filter by class
- **Delete** — remove an announcement (admin only)

## Routes

| Route | Role | Scope |
|-------|------|-------|
| `/admin/announcements` | Admin | All classes |
| `/teacher/announcements` | Teacher | Own classes only |

## Related

- `data-model/announcements.md` — Backing tables
- `api/message-functions.md` — `broadcastClassAnnouncement`, `getAnnouncementsByCreator`, `deleteAnnouncement`
