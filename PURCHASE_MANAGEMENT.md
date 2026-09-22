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
