---
type: Database Function
title: Security Helper Functions
description: "SQL SECURITY DEFINER helper functions for RLS: is_admin_user(), current_profile_id(), current_profile_role(). Used by RLS policies to determine user identity and role at the database level."
tags: [core, api, security, rls]
timestamp: 2026-07-27T00:00:00Z
---

is_admin_user() from 20240324_reenable_rls.sql — checks if current user has admin role in profiles.
current_profile_id() from 20260708_profiles_auth_session_rls.sql — returns the profile id of the authenticated user.
current_profile_role() from 20260708_profiles_auth_session_rls.sql — returns the role of the authenticated user.
All three are SECURITY DEFINER functions used by RLS policy WHERE clauses.

## Related

* [RLS Policies (Core)](../security/rls-policies.md) — policies using these helpers.
* [Profiles](../data-model/profiles.md) — table queried by these helpers.
