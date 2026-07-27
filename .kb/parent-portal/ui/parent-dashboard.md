---
okf_version: "0.1"
title: "ParentDashboard"
type: UI Page
tags: [parent-portal, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent home page with summary cards for each child — recent scores, attendance rate, homework status, and announcements."
route: "/dashboard"
role: parent
cross_bundle_refs:
  - core:data-model/students
  - exams:api/getExamsByParent
  - attendance:api/getAttendanceByParent
  - homework:api/getHomeworkByParent
  - announcements:data-model/announcements
---
# ParentDashboard

**Route:** `/dashboard`  
**Role:** parent  

## Description

Parent home page displaying summary cards for each enrolled child. Each card shows recent exam scores, attendance rate, pending homework count, and latest announcements.

## Data Sources

| Data | Source |
|------|--------|
| Children list | `getParentPortalSnapshot().children` |
| Recent scores | `getParentPortalSnapshot().recentExams` |
| Attendance rate | `getParentPortalSnapshot().attendanceSummary` |
| Homework status | `getParentPortalSnapshot().pendingHomework` |
| Announcements | `getParentPortalSnapshot().activeAnnouncements` |

## Key Behaviors

- Cards link to `/parent/children/:id` for detailed child view
- Attendance rate displayed as percentage with color indicator
- Homework status shows count of pending items
- Announcements limited to 3 most recent with "View All" link
