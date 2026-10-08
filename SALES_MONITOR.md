# Sales revenue monitor

The matching frontend change is in `SABI9666/eb-traker`, branch `codex/sales-monitor-portal`.

## Account and deployment

Deploy this backend before the matching frontend. The frontend already points to the Cloud Run service `west-epcm-backend` in `us-central1`. This change does not create or alter a live Firebase account or deploy either application.

Use the existing login with `sales.edanbrook@outlook.com`. If it has no account, register it once with the Sales Monitor role and a privately chosen password. The frontend automatically assigns this email to `sales_monitor`; the backend independently overrides any older stored role for this authenticated identity. Other emails cannot gain access by submitting that role. Inactive and suspended accounts remain blocked. Normal Firebase password authentication remains required.

The Sales account may only call `GET /api/sales-monitor`. Shared authorization rejects its mutations and other protected API routes. The legacy email trigger and invoice router now also use shared authorization so they cannot bypass this restriction. The UI exposes only monitoring, filters, refresh, pagination and logout.

The repository does not contain deployed Firestore / Storage rules. Before production rollout, verify those rules independently: the Sales identity must not be able to write business records directly through the Firebase SDK. Preserve the existing controlled own-profile registration flow if self-registration is enabled. No live rules have been inspected or changed by this patch.

## Report definitions

- Project records: won projects and unconverted won proposals, approved variations, and priced proposal quotes. A project and its linked proposal are counted as one win. The recorded PO value takes precedence over the quoted value, with the corresponding PO currency. Project win dates fall back to the linked proposal's win date.
- Manual BDM uploads: the `bdm_entries` quote/won/variation ledger, displayed as a separate source. It is not added to project records because there is no reliable cross-ledger deduplication key.
- Booked sales means won values plus approved / manually recorded variations. It is not recognized accounting revenue, invoiced revenue, or payments collected.
- Currencies are never added together or converted using assumed rates. Missing currencies are explicitly grouped as UNSPECIFIED.
- Missing values and dates remain visible and are flagged. Date filters exclude undated records. Zero values remain zero rather than falling through to another amount field.
- Quotes have their own metric; they are not added to booked sales.
- BDM identity uses stored UID, then canonical email. Unknown owners remain visible as Unassigned.
- Date filters use the UTC event date: win date, quote pricing date, or variation approval/entry date. Filters initially show all dates. The detail-type filter only affects the final table.

The endpoint reads all five source collections in pages of 1,000, without requiring date fields or composite indexes. At 20,000 records in any source, it returns an explicit unavailable response instead of silently truncating totals. Collection failures also fail the whole report; old totals are cleared on refresh failure. Responses are `no-store` and contain only report fields, not attachments or raw user documents.

## Validation

Run `npm ci` then `npm run test:sales` and `npm run test:purchases`.
The frontend has a Playwright smoke test in `test/sales-monitor.cjs`. It uses fixtures, not production data.
Production account login, live data reconciliation and Firestore rules require verification after deployment.
