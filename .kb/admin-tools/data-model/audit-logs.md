---
type: Database Table
title: "audit_logs"
description: "System audit trail for tracking administrative actions."
tags: [admin-tools, schema, audit]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Captures a tamper-evident log of every administrative action performed within the system. RLS ensures authenticated users can insert while only admins can read.

# Schema

| Column | Type | Description |
|--------|------|-------------|
| id | bigserial PK | Auto-incrementing log identifier |
| action | text | Description of the action performed |
| details | JSONB | Structured payload with action-specific data |
| createdAt | timestamptz | When the action occurred |

# Security

RLS enabled. Authenticated users receive INSERT privilege; admins receive SELECT on all rows.

# Migration

`00001_create_audit_logs.sql`
