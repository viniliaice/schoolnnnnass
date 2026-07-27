---
type: UI Page
title: "BulkUpload"
description: "CSV-based bulk import for users, students, and exam records with validation."
tags: [admin-tools, ui, admin]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Admin page for uploading CSV files to bulk-create users, students, and exam records. Parses and validates the uploaded data before dispatching to the corresponding database function.

# Route

`/admin/bulk`

# Import Functions

| Function | Purpose |
|----------|---------|
| bulkCreateUsers | Bulk insert user records from CSV |
| bulkCreateStudents | Bulk insert student records from CSV |
| bulkCreateExams | Bulk insert exam records from CSV |

# Dependencies

| Module | Purpose |
|--------|---------|
| lib/db/bulk.ts | Database access for bulk import operations |
