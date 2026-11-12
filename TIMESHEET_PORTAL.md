# Timesheet Portal (multi-company)

A separate product that runs on the same server and Firebase project as EB Tracker but
shares **no data or screens** with it.

| Part | Where |
|---|---|
| Web page | `eb-traker/public/timesheet/` -> `https://<eb-tracker-site>/timesheet/` |
| API | `ts-portal/`, mounted at `/api/ts-portal` (one line in `server.js`) |
| Data | Firestore `tsPlatform`, `tsUsers`, `tsCompanies/**` only |
| Tests | `npm run test:ts-portal` |

EB Tracker's pages, routes (`/api/timesheets` etc.) and collections are not changed.
The portal page uses its own named Firebase session, so signing in or out of the
portal never signs anyone in or out of EB Tracker.

## How companies sign in

1. Everyone uses the same page: `/timesheet/`.
2. **Sign in** tab: any invited person. The server looks up `tsUsers/{uid}` to find
   their company and role, so the company never comes from the browser. One login
   belongs to one company.
3. **Super Admin** tab: the platform owner. Only accounts listed in
   `tsPlatform/config.superAdminUids` get in; everyone else is signed out with
   "This account is not a Super Admin".
4. Accounts not in any company, a suspended company, or a disabled member are refused.

## Roles

| Role | Can do |
|---|---|
| employee | Enter and submit their week (grid or Excel/CSV upload), see history |
| supervisor | + approve their direct reports, team view, reports for their team |
| project_manager | + approve sheets with their projects, reports for their projects |
| gm | + approve at the GM step, reports for the whole company, monthly email |
| company_admin | + people, projects, settings, reopen weeks, activity log, whole-company reports |
| Super Admin | Create, suspend and activate companies, add company admins, all-company summary |

Approval steps are chosen per company (Settings): any of Supervisor -> Project manager
-> GM. A step with nobody to approve goes to the company admins; nobody approves their
own week.

## Go-live steps

1. Deploy the backend as usual (Cloud Run). Optional environment variables:
   - `TS_PORTAL_URL` - link used in emails, e.g. `https://eb-tracker-frontend.vercel.app/timesheet/`
   - `TS_EMAIL_FROM` - sender (default `EB Tracker Timesheets <ithelpdesk@edanbrook.com>`)
   - `TS_TICK_SECRET` - long random string for the scheduler (step 4)
   - `TS_SANDBOX_EMAIL` - in staging, send every portal email here instead
   - `RESEND_API_KEY` is already set for EB Tracker and is reused.
2. Deploy the front end (the new `public/timesheet/` folder).
3. Make yourself Super Admin (the only way to grant it):
   ```
   node scripts/ts-bootstrap-superadmin.js you@example.com
   ```
   The email must already have a Firebase login (create one in Firebase Console ->
   Authentication if needed).
4. Reminders and the monthly GM report: create a Cloud Scheduler job that calls the
   portal every hour:
   ```
   gcloud scheduler jobs create http ts-portal-tick --location=us-central1 \
     --schedule="5 * * * *" --http-method=POST \
     --uri="https://west-epcm-backend-854824137821.us-central1.run.app/api/ts-portal/internal/tick" \
     --headers="x-tick-secret=<TS_TICK_SECRET>"
   ```
   Each company gets its weekly reminder at its own reminder day/time (company time
   zone) and the previous month's report on the 1st; each is sent once.
5. Open `/timesheet/`, choose **Super Admin**, create the first company and its admin.

## Security check before inviting outside companies

Outside companies get logins in the **same Firebase project** as EB Tracker. EB Tracker
already signs out any login without a `users/{uid}` profile, but its browser code also
reads Firestore directly, so check the Firestore security rules: if a rule allows
*any signed-in user* to read EB Tracker collections, tighten it to require an EB Tracker
profile, for example:

```
function isEbUser() { return request.auth != null
  && exists(/databases/$(database)/documents/users/$(request.auth.uid)); }
match /tsCompanies/{doc=**} { allow read, write: if false; }   // portal data: API only
match /tsUsers/{doc=**}     { allow read, write: if false; }
match /tsPlatform/{doc=**}  { allow read, write: if false; }
```
