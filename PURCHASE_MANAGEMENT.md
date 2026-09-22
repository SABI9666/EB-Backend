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

1. Purchase staff create a draft and attach requirements/quotations.
2. Submit the saved purchase for approval. Pending requests lock entries/uploads, with a Withdraw for editing option.
3. COO or Director approves or rejects. Rejection requires a reason. Decisions record the person, role, note and timestamp.
4. Approved requests move to PO and permit delivery, invoice-match, payment tracking and closure.
5. Commercial edits or new supporting purchase documents reset approval to draft and require resubmission. Delivery/invoice/receipt uploads preserve approval. Closure requires a payment/closure reference and locks the record.

Every creation, update, upload, submission, withdrawal and decision has an atomic activity entry. Version checks prevent stale edits or a second approver overriding an already-decided request. Payment tracking does not transfer funds or perform automated invoice matching.

## Account setup and deployment

Deploy backend and frontend together, backend first. The two Purchase emails are allowlisted in backend authentication and frontend routing. An existing active user profile resolves to Purchase for these emails regardless of its old role. No live accounts or passwords were created or changed by this work.

If an account does not exist, create/register it using the Purchase role and the named email. Each account must have a Firebase Auth user and active Firestore users profile. Email verification is required; the portal provides Send verification email and I have verified my email controls. No shared/default password is embedded in code. The backend rejects unverified identities and unlisted users with a forged purchase role, and limits Purchase identities to purchase API routes. Other role resolution remains unchanged.

Existing Firebase credentials need Firestore and Storage read/write permissions. Inspect deployed rules: users must not be able to change their own authorization fields, and purchases/documents/activity and purchase-documents storage objects must not permit broad direct client access or public bucket access. API changes do not modify deployed Firebase rules. Collections are created on first use; queries need only standard single-field indexes. Existing records without an approval property are treated as drafts, not approved requests.

## Documents and API

PDF, PNG and JPEG: 10 MB per file. File signatures and extensions are checked; this is not antivirus scanning. Generated storage names, no public ACL/download token, authenticated downloads and failed-upload cleanup are used.

Under `/api/purchases`: GET/POST `/`, GET/PUT `/:id`, POST `/:id/documents`, GET `/:id/documents/:documentId`, POST `/:id/submit`, POST `/:id/withdraw`, POST `/:id/decision`.

## Validation

`npm run test:purchases` runs the actual Express router/auth middleware against mocked Firebase services. Coverage includes both allowed emails, unauthorized/unverified identities, role separation, validation, upload limits/signatures, activity, downloads, submit/reject/resubmit/approve, stale decisions, withdrawal, approval reset and closure protections.

Frontend jsdom checks passed for both named login routes, purchase creation/upload, unsaved-edit submission guard, pending locks, COO and Director decision controls, rejection notes, approval and filtering. Live Firebase/rules and production-account testing remain deployment checks. Full visual browser testing was unavailable because Chromium download timed out. Production deployment is not included in these changes.
