---
type: UI Page
title: "ClassPromotion"
description: "Bulk class promotion interface — select source class, promote all students to next class level with undo capability."
tags: [admin-tools, ui, admin]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Admin-facing page for batch-promoting students from one class level to the next. Dispatches `promote_students` via `lib/db/promotions.ts` and supports rollback via `undoPromotion`.

# Route

`/admin/promotion`

# Dependencies

| Module | Purpose |
|--------|---------|
| lib/db/promotions.ts | Database access for promotion and undo operations |

# Related API

* [promote_students](../api/promote-students.md) — Underlying RPC called by this page.
