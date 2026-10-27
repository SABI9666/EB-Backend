# Sales revenue monitor

The matching frontend change is in `SABI9666/eb-traker`, branch `codex/sales-monitor-portal`.

## Account and deployment

Deploy this backend before the matching frontend. The frontend already points to the Cloud Run service `west-epcm-backend` in `us-central1`. This change does not create or alter a live Firebase account or deploy either application.

Use the existing login with `sales.edanbrook@outlook.com`. If it has no account, register it once with the Sales Monitor role and a privately chosen password. The frontend automatically assigns this email to `sales_monitor`; the backend independently overrides any older stored role for this authenticated identity. Other emails cannot gain access by submitting that role. Inactive and suspended accounts remain blocked. Normal Firebase password authentication remains required.

The Sales account may only call `GET /api/sales-monitor`. Shared authorization rejects its mutations and other protected API routes. The legacy email trigger and invoice router now also use shared authorization so they cannot bypass this restriction. The UI exposes only monitoring, filters, refresh, pagination and logout.

The repository does not contain deployed Firestore / Storage rules. Before production rollout, verify those rules independently: the Sales identity must not be able to write business records directly through the Firebase SDK. Preserve the existing controlled own-profile registration flow if self-registration is enabled. No live rules have been inspected or changed by this patch.

## Report definitions

One report serves the sales portal and COO / Director. It reads `users`, `proposals`, `accountVariations` and `purchase_projects`.

- Won: proposals a BDM marked won. The value is the P.O. value the BDM entered when clicking Won, in the P.O. currency, dated by the won date. A won proposal without a P.O. value is listed with no value and flagged.
- Variations: entries Accounts uploaded against a BDM (`accountVariations`), dated by upload. Rejected / cancelled entries are excluded.
- Purchase projects: the initial approved sales value of purchase portal projects at the award / PO date. Shown separately and never attributed to a BDM.
- RFQ value: the quote value the estimator entered on the proposal (pricing), dated by pricing. Reported on its own; never added to sales.
- Sales total = won + variations (BDM sales) + purchase projects. It is not invoiced revenue or payments collected.
- The manual "Upload Quote / Won" ledger (`bdm_entries`) is no longer read.
- The report starts on 1 December 2025. Missing values and dates stay visible and are flagged.

The endpoint reads all four source collections in pages of 1,000, without requiring date fields or composite indexes. At 20,000 records in any source, it returns an explicit unavailable response instead of silently truncating totals. Collection failures also fail the whole report; old totals are cleared on refresh failure. Responses are `no-store` and contain only report fields, not attachments or raw user documents.

## Validation

Run `npm ci` then `npm run test:sales` and `npm run test:purchases`.
The frontend has a Playwright smoke test in `test/sales-monitor.cjs`. It uses fixtures, not production data.
Production account login, live data reconciliation and Firestore rules require verification after deployment.
