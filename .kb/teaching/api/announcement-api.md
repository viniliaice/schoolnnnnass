---
title: "Announcement Functions"
type: Database Function
tags: [teaching, api, announcements]
timestamp: 2026-07-27T00:00:00Z
description: "Functions for broadcasting announcements and fetching them by class or creator."
linked_concepts:
  - teaching:data-model/announcements
  - communications:api/notification-api
---

# Announcement Functions

**Source:** `feature-schema.sql`

| Function | Description |
|----------|-------------|
| `broadcastClassAnnouncement` | Send an announcement to all members of a class |
| `getAnnouncementsForParent` | Retrieve announcements relevant to a specific parent |
| `getAnnouncementsByCreator` | Retrieve announcements created by a specific user |
| `deleteAnnouncement` | Remove an existing announcement |

## Related

* [Announcements (Teaching)](../data-model/announcements.md) — underlying table for these functions.
* [ClassAnnouncements](../../communications/ui/class-announcements.md) — UI consuming these functions.
