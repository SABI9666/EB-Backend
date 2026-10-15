# Purchase portal and management approval

Purchase Management replaces the sample-only prototype and uses existing Firebase Auth, Firestore and Storage services.

## Access

| User | Access |
|---|---|
| anwar@edanbrook.in | Purchase portal: create/edit entries, upload documents, submit requests, track purchases |
| anwar1@edanbrook.in | Same shared Purchase portal and register |
| COO | View all purchases/documents/activity; approve or reject pending requests |
| Director | View all purchases/documents/activity; approve or reject pending requests |
| Other users | No purchase access |

Purchase staff own all entry/upload operations. Management cannot edit or upload through the purchase API. Either COO or Director can decide a pending request; this is not a two-signature workflow. Purchase staff cannot approve.

## Workflow

1. Creating an entry immediately submits its initial draft to COO / Director. Existing legacy drafts can also be reviewed directly from the register, or submitted by Purchase.
2. COO and Director have visible Review & approve / Review & reject row actions. Either manager can decide; rejection needs a reason. Decisions use record versions to prevent duplicate or stale approval.
3. After approval, the same Purchase row exposes Edit, Add quote, Add P.O., Add document / process and Request delete.
4. Edits (including stage changes) store proposed values separately. Managers see current versus proposed fields. The current entry changes only on approval; rejection preserves the approved entry.
5. Each document upload immediately creates a pending document request. This includes quotations, comparisons, PO, delivery, invoices, receipts and other documents. The document is marked pending and remains downloadable for review. Only approval advances the stage; rejected or withdrawn documents remain labeled in the audit history. Supporting files never move the stage backwards.
6. Delete requests require a reason. Approval archives the entry out of the active register; records, documents and activity history are retained. Rejection keeps the entry visible. There is no immediate hard-delete endpoint.
7. Only one operation may await approval per entry. Purchase may withdraw it; this discards the proposed operation and restores the prior approval state. Other writes and uploads remain blocked while pending.
8. Closure is a proposed edit requiring a payment/closure reference and management approval. Closed records cannot be edited or receive uploads, but may be submitted for approved archival.

Stage labels track the approved process: RFQ, quotes, comparison, PO, delivery, invoice match, payment and closed. Payment tracking does not transfer funds or perform automated invoice matching. No mandatory quote-to-PO stage sequence or two-signature approval requirement is introduced.

## Account setup and deployment

Deploy backend and frontend together, backend first. The two Purchase emails are allowlisted in backend authentication and frontend routing. An existing active user profile resolves to Purchase for these emails regardless of its old role. No live accounts or passwords were created or changed by this work.

If an account does not exist, create/register it using the Purchase role and the named email. Each account must have a Firebase Auth user and active Firestore users profile. Email verification is not required for the two allowlisted accounts; after registration they can log in with their password. No shared/default password is embedded in code. The backend accepts both verified and unverified allowlisted identities, rejects unlisted users with a forged purchase role, and limits Purchase identities to purchase API routes. Other role resolution remains unchanged.

Existing Firebase credentials need Firestore and Storage read/write permissions. Inspect deployed rules: users must not be able to change their own authorization fields, and purchases/documents/activity and purchase-documents storage objects must not permit broad direct client access or public bucket access. API changes do not modify deployed Firebase rules. Collections are created on first use; queries need only standard single-field indexes. Existing records without an approval property are treated as drafts, not approved requests. Legacy pending approvals remain reviewable; no data migration is required.

## Documents and API

PDF, PNG and JPEG: 10 MB per file. File signatures and extensions are checked; this is not antivirus scanning. Generated storage names, no public ACL/download token, authenticated downloads and failed-upload cleanup are used.

Under `/api/purchases`: GET/POST `/`, GET/PUT `/:id`, POST `/:id/documents`, GET `/:id/documents/:documentId`, POST `/:id/submit`, POST `/:id/withdraw`, POST `/:id/decision`, POST `/:id/delete-request`. Upload forms include `type`, `file` and the current record `version`. PUT submits proposed edits rather than immediately changing the record. Approved archival hides a record from the list; authenticated detail reads retain audit access.

## Validation

`npm run test:purchases` runs the actual Express router/auth middleware against mocked Firebase services. It covers both named accounts without email verification, unauthorized identities, role separation, immediate initial review, legacy drafts/pending requests, staged edit approval/rejection, every upload category, upload validation and stale versions, rejection/withdrawal, approved closure and audit-preserving deletion.

Frontend jsdom checks cover both manager roles, visible row actions, current/proposed details, rejection validation, edit/delete/upload request payloads and pending locks. Live Firebase rules, production accounts and cloud deployment are not exercised by these tests.

Deploy backend first, then the matching frontend update. Old clients will need a refresh: uploads now require a version and every upload is sent for review.

## Projects and daily site logs

### Project-first workflow

The purchase portal opens on **1 · Projects & Site Logs**. Work runs in this order:

1. Create the project: number, client, client PO / work order, client contact, value, dates and scope.
2. COO / Director approve the project. This fixes the initial sales value.
3. Raise purchase requests under the approved project, using **+ Purchase request** on the project or **2 · Purchase Requests**.
4. COO / Director approve each request and each later edit, document and stage step.
5. Record daily material, manpower and machinery costs on the project.

The server requires every new purchase request, and every edit, to reference an existing project number. That project must have been approved at least once. New requests are refused for completed or cancelled projects. Edits are refused for cancelled projects. The server sets the project name and `projectId` from the project. Legacy purchases without a project must be linked to one the next time they are edited. Inside a project, the *Purchase requests* tab lists linked requests with their approval state and pending operation. From there, Purchase can view, edit, add a quote, add a P.O. or add a document, and COO / Director can review and approve.

The Purchase portal has a **Projects & Site Logs** workspace (`/api/purchase-projects`, collection `purchase_projects`). Purchase portal projects are separate from BDM sales.

- **Project register.** Purchase staff create a project with:
  - a unique project number, fixed once created
  - name, client, location and manager
  - project / PO value and currency, and the award / PO date
  - planned start and planned completion dates
  - actual completion date, required when the status is completed
  - status: active, on hold, completed or cancelled
  - a "count in sales" flag

  A new project and every later header edit go to COO / Director for approval. Edits apply at once and need a reason.
- **Initial sales value.** The first approval fixes `initialSales`: the value, currency and award date approved at that time. Later edits and approvals never change it. They only decide whether the project still counts: "count in sales" ticked and the project not cancelled. `sales` holds what the sales monitor reads.
- **Daily logs.** Each project takes dated entries recorded directly by Purchase. Amounts are computed by the server in the project currency:
  - Material: quantity × rate (with unit, supplier and DC / invoice reference)
  - Manpower: workers × rate per man-day (with trade, hours each and contractor); man-days and man-hours are tracked
  - Machinery: units × hours × rate per hour (with owner / supplier); machine-hours are tracked

  Future dates are rejected. Completed or cancelled projects take no new entries. Removing an entry needs a reason; the entry stays in history but is excluded from totals.
- **Linking purchases.** The purchase form has an optional project number selector.

### Sales portal

The Sales Revenue Monitor shows purchase portal projects as their own source (`purchase`, kind `purchase`). It shows only the initial sales value, at the award / PO date, with no cost figures. These rows are not attributed to any BDM:
- They are excluded from BDM performance, win rate, pipeline and average deal size.
- They are listed in a separate "Purchase portal projects" section.
- They are added to booked sales and shown as their own column in the weekly / monthly and quarterly sales tables.

COO / Director can also open the Sales Revenue Monitor (Corporate → Sales, or the Reports Center). Values are not deduplicated against BDM uploads or project records.

### COO / Director reports

These reports are reached from Procurement or the Reports Center.

- **Project-wise Report.** The project list has *Cost report* and *Schedule report* views, with CSV export and print / PDF. Each project report shows the initial sales value and the current contract value, KPIs, a cost breakdown and a date filter. It has these tabs:
  - *Cost report*: financial summary (initial sales value, revision, cost, balance, margin, approved purchase commitments), cost by category, monthly cost with cumulative % of value, material consumption, manpower by trade and machinery by equipment.
  - *Schedule report*: planned versus actual dates, duration, elapsed and remaining days, and time elapsed versus cost consumed. It flags a project "at risk" when cost runs more than 15 points ahead of time, and "overdue" after planned completion. It includes weekly site activity, showing idle weeks.
  - Daily summary, material, manpower, machinery, linked purchases and activity history.
- **Purchase Report.** The purchase register is filtered by project, stage, approval / overdue, created date and search. It has KPIs, stage-wise, project-wise and vendor-wise summaries, overdue requirements and the full register. Values stay in their own currency. CSV export and print / PDF are available.

Validation: `npm run test:purchase-projects`. Frontend fixture tests in eb-traker (Playwright): `node test/purchase-projects.cjs` and `node test/sales-monitor.cjs`.
