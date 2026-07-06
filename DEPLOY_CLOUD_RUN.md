# Deploy the backend to Google Cloud Run

Migrating the API off Render's free tier (which sleeps and causes the 50-second
"slow" first load) to **Google Cloud Run** — same Google Cloud network as your
Firebase, always-warm, auto-scaling, pay-per-use.

Your data (Firestore + Storage) does **not** move — only the API server does.

---

## Prerequisites (one-time)

1. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install
2. Log in and select your Firebase project (same one your app already uses):
   ```
   gcloud auth login
   gcloud config set project eb-tracker-ff945
   ```
3. Enable the services:
   ```
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   ```

## Step 1 — Pick the region (IMPORTANT for speed)

Deploy the API in the **same region as your Firestore database**. Check it in
Firebase Console → Firestore Database (top of the page shows the location, e.g.
`nam5 (us-central)` or `asia-south1`).

- Firestore in `us-central` / `nam5` → use region **`us-central1`**
- Firestore in `asia-south1` (Mumbai) → use region **`asia-south1`**

Matching regions is often a bigger speed win than the platform itself.

## Step 2 — Deploy (build happens in the cloud from the Dockerfile)

From the repo root:
```
gcloud run deploy west-epcm-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --memory 512Mi \
  --cpu 1 \
  --port 8080
```
- `--min-instances 1` keeps ONE instance always warm → **no cold starts** (this
  is the fix for the slowness). It costs a few dollars a month; set to `0` if
  you prefer scale-to-zero and can tolerate a ~1–2s wake (still far better than
  Render's 50s).
- Replace `us-central1` with your Firestore region from Step 1.

## Step 3 — Set environment variables

Copy the values from your current Render service (Render → EB-Backend →
Environment). The app uses these:

| Variable | Needed? | Notes |
|---|---|---|
| `RESEND_API_KEY` | ✅ | Email sending |
| `TEKLA_API_KEY` | ✅ | Tekla push auth |
| `FIREBASE_STORAGE_BUCKET` | ✅ | e.g. `eb-tracker-ff945.firebasestorage.app` |
| `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` | Optional | See note below |
| `NODE_ENV` | Optional | `production` |

Set them:
```
gcloud run services update west-epcm-backend --region us-central1 \
  --set-env-vars "RESEND_API_KEY=xxx,TEKLA_API_KEY=xxx,FIREBASE_STORAGE_BUCKET=eb-tracker-ff945.firebasestorage.app,NODE_ENV=production"
```

### Firebase credentials — you can go key-less on Cloud Run
Because Cloud Run runs *inside* your Firebase project, the app now supports
**Application Default Credentials** — no service-account key needed. Just grant
the Cloud Run service account access (one-time):
```
# Find the runtime service account (usually PROJECT_NUMBER-compute@developer.gserviceaccount.com)
gcloud projects add-iam-policy-binding eb-tracker-ff945 \
  --member="serviceAccount:$(gcloud run services describe west-epcm-backend --region us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role="roles/datastore.user"
gcloud projects add-iam-policy-binding eb-tracker-ff945 \
  --member="serviceAccount:$(gcloud run services describe west-epcm-backend --region us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role="roles/firebaseauth.admin"
gcloud projects add-iam-policy-binding eb-tracker-ff945 \
  --member="serviceAccount:$(gcloud run services describe west-epcm-backend --region us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role="roles/storage.admin"
```
> Prefer to keep it simple / identical to Render? Skip the IAM step and just set
> `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` (same value as on Render) as an env var.
> The code tries the key first, then falls back to ADC.

## Step 4 — Get the new URL and point the frontend at it

```
gcloud run services describe west-epcm-backend --region us-central1 --format='value(status.url)'
```
You'll get something like `https://west-epcm-backend-xxxxx-uc.a.run.app`.

Then update the frontend so it calls the new backend:
- In `eb-traker/public/app1.js`, change `API_BASE` from
  `https://eb-backend-rxu6.onrender.com` to the new Cloud Run URL.
- (Tell Claude the URL and it will make this change + the Tekla macro URL for you.)

## Step 5 — Verify
```
curl https://<your-run-url>/health
```
Should return `{"status":"OK", ...}` instantly (no 50s wait).

## Step 6 — Redeploys later
Just rerun the Step 2 command from the repo root — Cloud Run rebuilds and rolls
out a new revision with zero downtime.

---

### Optional: custom domain
Map `api.west-epcm.com` (or similar) to the service:
```
gcloud run domain-mappings create --service west-epcm-backend --domain api.yourdomain.com --region us-central1
```
Then update `API_BASE` to the custom domain.

### Cost estimate
With `--min-instances 1`, ~$5–12/month depending on region/traffic. With
`--min-instances 0`, often within the free tier for low traffic (but you get a
~1–2s wake on the first request after idle).
