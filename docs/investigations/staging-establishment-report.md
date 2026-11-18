# Safe staging establishment report

## STAGING ENVIRONMENT NOT READY — BLOCKERS REMAIN

This task established prerequisites, not a running staging environment. **Staging project reference: not allocated / not verified.** Production reference `qopeilyvkfqbjdeudwnz` is explicitly prohibited as a restore or test-write target.

No resource was created, activated, upgraded or purchased. No backup was restored. No migration, deployment, account creation, notification, production configuration change or production data write was performed. The only new repository artifact for this task is this report. Previous repair files remain unchanged.

## 1. Verified environment facts and safest acquisition path

Read-only `list_projects` and `get_project` confirm production is `aassaas`, `eu-west-1`, PostgreSQL `17.6.1.084`. It is the only active project returned; seven others are inactive and are neither approved staging destinations nor verified production restores. Their names do not establish provenance. Previous branch discovery found only the default production branch; schema-only branching is not the required data restore.

### Recommended architecture

Use a **new dedicated Supabase project and separate database**, with its own reference, generated database password, Auth signing/API credentials, staging-only roles, and restricted membership. Prefer a separate staging organisation/access boundary if project-scoped access cannot prevent testers accessing production. Confirm plan and access-control capabilities before choosing. Do not assume the existing organisation's project roles meet that requirement.

A privileged backup custodian may require production **read-only** export access; the staging app, test actors and staging operator runtime must have **no production write credentials or production connection configuration**. Never copy a production `.env`, service key, SMTP/SMS key, VAPID key, webhook token, OAuth secret or database password into staging. Do not display keys in chat, reports, logs or Git. Provision new staging secrets via the platform secret manager through an approved secure process.

**Preferred sequence:** approved backup → restricted quarantine/inspection → dedicated staging restore → integrity verification → isolation/privacy review by another authorised person → authorisation to rehearse. Do not start with an exposed restore and disable notifications afterwards.

Two candidate acquisition routes require a custodian decision:

1. **Provider-supported restore to a new project**, if the account actually offers it. The owner must establish the operation restores to a distinct project rather than rewinding production, identify all copied settings/jobs/secrets and demonstrate isolation before services can process restored data. If unsafe automatic outbound execution cannot be prevented, do not use this route directly.
2. **Authorised logical backup into a new quarantined project**, with compatible PostgreSQL tooling and an explicit schema/data/roles/grants restore manifest. Inspect the archive and restore order offline; exclude executable integrations from activation, not assessment rows. Provider-managed Auth/storage schemas and roles need the supported export/restore procedure, not blindly replaying an arbitrary `pg_dump`. Keep the original backup immutable and encrypted. A new export, if needed, requires separate production read/export approval and a consistent snapshot manifest.

A private offline restore can be an intermediate quarantine step if hosted egress cannot be controlled during restoration. It is not itself the final Supabase/Auth/RLS-equivalent rehearsal target. A hosted project that cannot meet the outbound-safety gate must remain inaccessible and NOT READY.

## 2. Backup provenance: findings and required evidence

### Actual discovery result

The connected Supabase tool inventory offers project creation and paused-project reactivation, but **no backup catalogue, PITR window inspection, download or backup-to-new-project restore tool**. `restore_project` reactivates a paused project; it is not a way to select a dated production backup. `get_project` returns no backup dates/retention/billing entitlement. No secret-bearing Auth/API-key response was requested.

Therefore:

| Question | Verified answer |
|---|---|
| Available provider production backups | Unknown; owner dashboard/support evidence required |
| Backup IDs/dates/completion state | Unknown |
| Earliest/latest PITR restore point | Unknown |
| Downloadable logical versus physical format | Unknown |
| All assessment tables included | Not verified; no archive obtained |
| Functions/indexes/triggers/constraints preserved | Not verified; no restore performed |
| Auth users/grants/RLS/roles included | Not verified |
| Storage file bytes included | Not verified; do not infer from DB metadata |
| Cost/free-slot entitlement | Unknown |

Earlier bounded Drive backup-name and workspace searches did not identify a verified PostgreSQL backup. Workbook backups are **not database backups**. No claim of absence across all possible backup locations is made.

### Custodian evidence request (no credentials)

From the production project's **Database → Backups/PITR** dashboard (or current equivalent), provide a redacted inventory of backup identifier, source reference, UTC snapshot start/end, completion state, retention/expiry, format, PostgreSQL version, encryption/access requirements and restore-to-new-project availability. For PITR include supported time window and selected UTC recovery point. Never click a production restore action for this task. If a logical export is required, record tool/version/options and snapshot consistency; record whether it was newly created rather than an existing provider backup.

For the chosen backup record immutable artifact SHA-256, byte size, custody/access log, selected restore point, restore logs/warnings and independent sign-off. A filename or checksum alone does not prove source provenance or completeness. Record the backup's own baseline; do not compare an older restore against today's live count as if they must match.

### Minimum restore scope

Restore the full application dependency closure, not just `exams`:

- `exams`, `students`, `subjects`, `profiles`, `terms`, `academic_years`, `student_enrollments`, `class_subjects` and all referenced class/teacher/parent/assignment records.
- `grade_uploads`, `grade_correction_audit`, `student_merge_audit`, `exam_historical_duplicate_candidates`, `grade_scales`, `report_config`, `report_comments`.
- `teacher_exam_progress` view and all upload/monitor/report/progress/correction/merge function overloads and dependencies, including server-only helpers.
- Primary/foreign/unique/check constraints **with validation states**, indexes with predicates/NULL semantics, triggers with enabled states, enums/defaults/sequences, extensions, grants/owners, RLS/policies, migration history and Auth relationships required by the app.

Inventory above comes from live catalog and repository knowledge. It is a minimum checklist, **not proof that these objects exist in a particular backup**. Inspect its table of contents, restore it and compare canonical definitions and per-table counts/fingerprints. Capture function signatures, body hashes, security-definer/search-path configuration and privileges securely without publishing embedded secrets. Preserve disabled integration definitions in a separate restricted manifest for audit; document the intentional staging deviations.

### Storage

Production `storage.objects` currently contains **11 metadata rows**. Actual file bytes, buckets, privacy and assessment-workflow dependency have not been inspected. Metadata restoration does not prove file restoration. Determine whether upload parsing uses browser-provided workbooks only, whether original workbooks are persisted, and whether reports/logos/attachments require objects. Retrieve no private object unless necessary and approved. For required objects, use separately authorised encrypted transfer with bucket/object hashes and staging-only URLs/policies; never let staging fall back to production storage. If not required, use synthetic fixtures and document the storage limitation rather than claiming a complete storage clone.

## 3. Notification and integration isolation — concrete hazards

### Read-only evidence

Production currently has **four enabled (`O`) outbound-capable triggers**:

| Table | Trigger | Function |
|---|---|---|
| `public.messages` | `on_new_message` | `public.call_push_notification` |
| `public.announcements` | `on_new_announcement` | `public.call_push_notification` |
| `public.announcements` | `send-notification` | `supabase_functions.http_request` |
| `public.messages` | `msgnoti` | `supabase_functions.http_request` |

Installed extensions include `pg_net` and `supabase_vault`. At inspection: `cron.job` was absent, `pg_subscription` count was zero, foreign server count was zero, `vault.secrets` count was zero, and `net.http_request_queue` count was zero. These observations **do not establish absence of external schedulers or secrets embedded in functions/trigger arguments/settings**. Endpoint/token-bearing trigger arguments and secret values were deliberately not retrieved into chat.

Relevant application objects: `notifications`, `notification_preferences`, `notification_recipients`, `academic_reminder_schedules`, `push_subscriptions`.

Repository evidence:

- `vercel.json` schedules `/api/academic-reminders/cron` at `0 13 * * *`.
- `api/academic-reminders/cron.ts` loads schedules and can invoke push/reminder processing through server Supabase credentials and VAPID configuration.
- `api/send-parent-credentials.ts` sends email through Resend when configured. No request was made to this endpoint.
- `src/lib/whatsapp.ts` opens `wa.me` browser links using contact data. **Disabling SMTP/API keys does not disable this path.** It also embeds a production app link.
- Local `supabase/config.toml` contains Auth email/SMS configuration, but is not evidence of hosted production or future staging settings.

### Required controls and independent proof

| Layer | Required staging control | Evidence needed before access |
|---|---|---|
| Restore/quarantine | No public app access, workers, realtime consumers or automatic deployment during restore; outbound network denied before executable objects activate | Provider/operator attestation and deny-policy logs; restore sequence review |
| Database webhooks | Disable/quarantine the four copied outbound triggers and discover all other outbound functions/hooks; preserve unrelated exam status guard/RLS | Staging trigger/function diff with no active outbound callback; reviewer signature |
| HTTP queue | No production destinations/credentials in restored queues or callable integration configuration; no queue processing until reviewed | Restricted scan and queue inventory; no network invocation to production |
| Cron/schedulers | Staging pg_cron/pgAgent/jobs, reminder schedules, Vercel cron, CI/GitHub Actions and external cron integrations disabled/not installed | Staging job inventories and scheduler-owner confirmation |
| Edge/server functions | Do not copy/deploy production notification/integration functions or their secrets; outbound blocked by default | Function inventory, secret **names only**, server env review |
| Auth | Disable invitations, public signup, password recovery and phone/OAuth sends; fresh signing keys, staging-only redirect hosts; approved synthetic test accounts only | Redacted staging Auth configuration, session/key-separation review and controlled sink tests |
| Email/SMS | No live SMTP/Resend/Twilio/provider credentials; only non-forwarding local capture sink if essential | Credential absence attestation, transport deny logs and synthetic-recipient capture |
| Web push | No live VAPID keys; quarantined real subscriptions; browser push permissions blocked | Staging env and subscription access review; browser/service-worker policy |
| Browser WhatsApp/other navigation | Isolated test browser with deny-by-default external navigation/network, popup and external-protocol blocking; only staging/test origins allowed | Browser policy and synthetic blocked-link test; not just a JS `fetch` mock |
| Storage/integrations | Staging URLs only; no remote production buckets, database links, subscriptions, analytics/webhooks/AI calls carrying data | Origin/URL inventory, network allowlist and denied-request evidence |
| Access | Tester runtime carries staging-only credentials; fresh browser profile/session; no production connection fallback | Independent URL/ref/environment review; verify fail-closed missing staging config |

No staging exists, so **none of these staging controls is claimed verified**. Missing credentials are defence in depth, not sufficient isolation. Do not send a real test email/SMS/push or open WhatsApp to prove blocking. Use only synthetic destinations and an enforced deny boundary. Do not modify production hooks/jobs/settings to make a clone safe.

Some managed-platform network restrictions control inbound access, not arbitrary outbound egress; do not treat them as an egress firewall without provider confirmation. If isolation requires code changes, propose and obtain approval first; no notification code was changed in this task.

## 4. Data integrity baseline (production read-only reference)

These are actual SELECT-only observations, **not a pre-migration staging manifest**. One initial relationship aggregate had a SQL syntax typo, failed before execution and was corrected; no security rejection or bypass occurred. The catalog/relationship/hash reads were separate statements and are not a single exported consistent backup snapshot. Re-capture at the chosen backup snapshot and after restore.

| Measurement | Result |
|---|---:|
| Total exam records | 35,820 |
| Labelled (`assessmentLabel IS NOT NULL`) | 32,321 |
| Unlabelled (`assessmentLabel IS NULL`) | **3,499** |
| Ambiguous unlabelled monthly groups | **331** |
| Rows within those groups | **667** |
| Distinct exam-linked student IDs | 726 |
| Distinct exam-linked subject IDs | 8 |
| NULL student IDs / unresolved student references | 0 / 0 |
| NULL subject IDs / unresolved subject references | 0 / 0 |
| NULL term IDs / unresolved non-NULL term references | 0 / 0 |
| Approved | 35,092 |
| Rejected | 728 |
| Pending | 0 (no pending group returned) |
| Database size (not backup size or billing disk use) | 80,546,963 bytes |

Fingerprints (ordered per-row JSONB MD5; integrity aids, not cryptographic backup authentication):

- Full exam rows: `e69c1cb5ac89ce0d84af27f3b1c5c719`
- Full unlabelled exam rows: `9d18d589c2df63111b18ea568a9ccca3`
- Ordered `(exam ID, student ID, subject ID, term ID)` relationships: `a36788de48c40dfbdb46086a4c03b2b5`

The provider returned a `captured_at` timestamp of `2026-11-18T14:07:05.761813+00:00`, inconsistent with the session's supplied date. This is retained as **provider-reported metadata, not trusted local time or a backup restore point**. Resolve time/provenance discrepancies before approving a snapshot.

### Existing exam indexes: 14 observed

All use btree:

| Name | Keys / predicate |
|---|---|
| `exams_pkey` | UNIQUE `id` |
| `exams_bulk_assessment_identity_unique` | UNIQUE `studentId, subjectId, examType, assessmentLabel, termId`; subjectId/termId/assessmentLabel all NOT NULL predicate; **month absent** |
| `idx_exams_month` | month |
| `idx_exams_bulk_identity_lookup` | studentId, subjectId, termId, assessmentLabel |
| `idx_exams_uploaded_by` | uploadedBy |
| `idx_exams_studentid` | studentId |
| `idx_exams_parentid` | parentId |
| `idx_exams_teacherid` | teacherId |
| `idx_exams_status` | status |
| `idx_exams_termid` | termId |
| `idx_exams_subjectid` | subjectId |
| `idx_exams_teacher_month_examtype` | teacherId, month, examType |
| `idx_exams_student_id_date` | studentId, date DESC |
| `idx_exams_marks_monitor_scope` | teacherId, termId, month, subjectId, examType |

### Existing exam constraints: 12 observed

- Validated: `exams_pkey`; `exams_status_check` permits pending/approved/rejected.
- Validated foreign keys: `exams_studentId_fkey` → students (ON DELETE CASCADE), `exams_subjectId_fkey` → subjects, `exams_termId_fkey` → terms, `exams_teacherId_fkey` → profiles (ON DELETE CASCADE), `exams_parentId_fkey` and `exams_uploadedBy_fkey` → profiles (ON DELETE SET NULL).
- **NOT VALID** checks: `exams_assessment_label_check`, `exams_entry_state_check`, `exams_exam_type_check`, `exams_score_entry_state_check`. Preserve this state in the baseline; do not silently validate or clean historical rows during restore.
- Enabled exam trigger: `enforce_exam_status_guard_trg`, BEFORE INSERT OR UPDATE, calls `enforce_exam_status_guard()`.

The existing SELECT-only `monthly-assessment-repair-preflight.sql` captures full definitions and relevant functions/grants; `staging-rehearsal-integrity.sql` captures ordered fingerprints, statuses and ambiguous groups. They do not apply migrations. A restricted custodian must additionally export all referenced relationship-table rows, definitions and policies, and compare them at the **same backup snapshot**, rather than treating zero orphans as proof every relationship is historically correct.

### Mandatory preservation rule

Protect **all 3,499 unlabelled rows**, including their row IDs, scores, months, subjects, term IDs, entry states and statuses. Protect all 331 ambiguous groups with exact membership, not just a count. No deletion/deduplication, arbitrary winner, inferred label, merge or historical correction. The previous read-only split was 3,462 monthly/non-termwide and 37 Midterm/Final rows; the proposed monthly predicate excludes NULL labels, while term-wide NULL-safe uniqueness must be checked for collisions on the actual restore. A collision is a blocker, never permission to repair legacy data automatically.

## 5. Privacy, anonymisation and access

A production-equivalent backup contains children's educational data and likely parent/teacher contact details, Auth credentials/sessions and push destinations. **Privacy review is mandatory before staging access.** No broad access to a raw restore should be granted merely because the project is called staging.

Recommended two-stage custody:

1. Restricted backup custodian alone verifies the raw quarantined restore and records exact assessment/relationship baseline.
2. Before broader tester/browser access, obtain approval for consistent masking of names, contact details, addresses, free text, recipient endpoints and Auth credentials/sessions **on the isolated copy only**. Use synthetic accounts; never authenticate as a real user or reuse password hashes, refresh tokens or production JWT keys.

Do not change assessment IDs/scores/months/labels/approvals or break FK relationships while masking. Record pre/post-masking manifests separately, including approved non-assessment deviations. Determine whether stable IDs themselves are identifying under the school privacy policy; if remapping is required, use a separately approved consistent mapping and acknowledge that full-row checksums will change. This task does not authorise any masking execution or real-identity reassignment. If existing restrictions forbid changing copied contact data, keep raw data custodian-only under verified egress denial and request explicit permission for a masked test copy. Anonymisation alone is not a notification kill switch.

## 6. Grade 2-C workbook provenance investigation

Read-only Drive metadata, backup sheet structure/calendar header and the existing audit document were inspected. No marks were edited or restored. Student/parent cell data was not exported to this report.

| Candidate | Observed evidence | Classification / confidence |
|---|---|---|
| `2C Teacher Planner 2026/27` (`1C1OnAJwIqTeVDW6yG3hH4TV_RWiYjHzp5FU1BjI33DQ`) | Native Sheet, version 1966; created 2026-06-15; provider modified time 2026-11-18 | Mutable working planner, **not an immutable original upload**; whether it supplied a particular DB upload is unknown |
| `BACKUP 2026-10-17 2C Teacher Planner (pre Sem1 Att correction)` (`1XqXxaltL371su8K1w3V-hYXEmwwrGjQfWrK1apZXjHo`) | Native Sheet version 10; created/modified 2026-10-17 15:59:30.293Z; visible calendar headers “Auguest”, September, October, November; student/attendance/report-like structure | Backup-labelled planner copy, not a DB backup; **original-upload status unverified**. Copy source/revision not supplied in returned metadata |
| `2C_Teacher_Planner_2026-27_15Oct_1520Z.xlsx` (`1ZcRmxiqiBrBv8E2xnc7vaT2rWweDU9_2`) | Stored XLSX, version 3, 1,864,808 bytes; Drive created 2026-10-17; modified 1980-01-01; MD5 `bead055d113702952cf0b9ef0c696e79` | Stored workbook/export candidate, **not proven original or a 15 October snapshot**. Filename and anomalous modified timestamp are unreliable chronology; binary content not inspected |
| `Grade 2C — Marksheet (Phase 1 corrected copy, original untouched)` (`1LhvXbwOPqJstLTr7Mr2PzF5i7htKjdaMuVK5d1MGsxw`) | Native Sheet version 7; created/modified 2026-10-14; title explicitly says corrected copy | Derivative by declared title; not an authoritative original without source chain and correction log |

The read-only `GRADE2C_ASSESSMENT_AND_REPORT_AUDIT.md` (`1tr6t_6U-HSC_pk3J8rT19-6LSR0zjk8E`, 1,191 bytes, complete extraction) describes a formula/report investigation, not a certified marks recovery archive. It reports omitted Math HW1 inclusion (`CE4=SUM(O4:V4)` omitting N4), blank-as-zero aggregation, an Arabic import pointing to a draft, an overwritten formula, and unresolved authoritative weighting/source decisions. Those are **claims in a prior audit**, not fresh recalculations of current marks. They warn against treating reconstructed totals as original per-assessment evidence.

Metadata and a calendar header do not establish that each workbook score predates the overwrite, corresponds to the same student/subject/term, or was ever uploaded. No revision-history endpoint is exposed by the discovered Drive tools. Obtain owner-confirmed original source, revision/export chain, actual upload workbook/email attachment or ledger hash linkage, exact month/year/term/label semantics, and a secure pseudonymous identity crosswalk. Compare typed inputs separately from formulas/imported/reconstructed outputs. A school-authorised independent reviewer must reconcile per-assessment values against a second trustworthy source and approve any later recovery list. **No historical marks restoration is authorised or supported yet.** Preserve September as September regardless of upload/export date.

## 7. Costs, approvals and owners

No price or quota was verified and no cost was incurred by resource creation. Do not infer that `plan=free` guarantees a free slot, sufficient limits or feature equivalence. No attempt was made to discover entitlement by creating a resource.

| Required decision/evidence | Owner | Current state |
|---|---|---|
| New project/org, region and data residency | School data owner + Supabase owner | Approval outstanding |
| Backup read/export permission and selected restore point | Production backup custodian | Outstanding |
| New-project restore availability, plan/compute/disk/egress/retention cost quote | Supabase billing owner/provider | Unknown; budget cap and duration approval required |
| Secure transfer/temporary quarantine infrastructure | Security/operator | Outstanding; approve any cost first |
| Privacy/masking/access list and retention/deletion policy | School data owner | Outstanding |
| Network, browser and scheduler isolation | Security/operator | Not implemented/verified |
| Independent reviewer of environment before migration | Named reviewer other than setup executor | Not assigned |
| Migration execution approval after environment verification | Release owner/user | Explicitly withheld pending verification |

## 8. Exact next steps and stop gates

1. **Owner supplies evidence only:** redacted backup inventory/PITR window and selected source snapshot, approved destination organisation/region, cost quotation and spending cap. Do not send secrets or trigger a production restore.
2. Approve the chosen acquisition route and custodian. Confirm compatible PostgreSQL 17 tooling/provider procedure, secure backup storage, consistency manifest, full schema/data/grants scope and storage requirements. Record backup SHA-256 and restore point; reconcile the observed clock discrepancy.
3. With explicit cost/resource approval, create a dedicated project. Record its real reference and database identity and prove neither equals production. Allocate new credentials securely. Do not reuse inactive projects opportunistically or copy production environment variables.
4. Establish quarantine **before restore**: deny outbound execution/network, restrict access, disable app/worker/cron connections, segregate integration secrets. If hosted restrictions cannot provide this safety, stop and arrange an approved offline sanitisation/quarantine path.
5. Custodian restores only to the approved distinct target, never production. Capture restore logs, table/object inventory and exact raw-restored baseline. Compare backup snapshot data, all 3,499 unlabelled rows/331 groups, full exam rows, relationships and relevant schema. Any mismatch stops establishment; do not fill missing records from guesses.
6. Implement only approved staging integration/identity safety deviations. Preserve exam guards and RLS, quarantine live recipients/Auth sessions, configure synthetic accounts and non-forwarding sinks. Produce a signed isolation manifest and evidence from synthetic blocked-send tests across DB, server and browser layers.
7. **Independent verification gate:** another authorised reviewer checks target ref, backup chain/completeness, row/relationship/schema comparison, access/no-production-credential separation, outbound/scheduler/webhook isolation and privacy. Until they sign, **do not apply the proposed migration**.
8. Only after that sign-off and explicit staging-migration approval: run the prepared migration on staging, inspect every index/constraint/trigger/grant/RLS change and compare full pre/post exam/legacy manifests before seeding test rows.
9. Perform October/November uploads, approvals/corrections, identical reuploads, synthetic duplicate-student merge, independent-session concurrent confirmation, expired preview and modified-payload rejection, monthly/term-wide reports and failed-batch rollback. Rehearse recovery against a disposable staging recovery copy with approved costs; do not recreate the unsafe month-blind index over legitimate cross-month data. Use the detailed matrix in `monthly-assessment-staging-readiness.md`. Record every unexecuted case as NOT RUN.
10. Publish rehearsal results for a separate production decision. **No production deployment or migration is authorised by staging establishment or its sign-off.**

### Current deliverable status

- Project reference: **none established**.
- Backup provenance/dates/restore points: **not accessible through available tools; custodian evidence required**.
- Notification isolation: production hazards identified; **no staging isolation evidence yet**.
- Integrity baseline: production read-only aggregate/catalog reference recorded above; **backup-consistent and restored-staging baselines outstanding**.
- Costs/approvals: no paid action taken; quotation, budget and resource/restore/privacy approvals outstanding.
- Rehearsal: **NOT RUN**, intentionally blocked by the independent-verification requirement.

**Final status: STAGING ENVIRONMENT NOT READY — BLOCKERS REMAIN. Production remains unchanged by this task.**
