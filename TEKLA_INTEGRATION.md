# Tekla Structures → West EPCM Technologies Integration

How model data (tonnage, assemblies, parts, bolts, drawing status) gets from
Tekla Structures on a detailing workstation into the **COO / Director →
Operations & Management → Tekla Reports** dashboard.

```
Tekla Structures (Windows workstation)
   │  ① Open API plugin  – or –  ② report CSV + PowerShell watcher
   ▼
POST https://west-epcm-backend-854824137821.us-central1.run.app/api/tekla-reports
   │  (header: X-Tekla-Api-Key — machine push ONLY)
   ▼
Firestore `tekla_reports`  ──►  COO/Director portal "Tekla Reports" view
```

**Integrity by design**
- Reports are accepted **only** from workstations holding the machine key —
  there is **no manual entry or CSV upload in the portal**, so designers
  cannot type or adjust figures. Numbers come straight from the model.
- Viewing is restricted to **COO and Director** (enforced server-side).
- Completion percentages are computed **server-side** from the pushed
  metrics (modeled vs planned tonnage, drawings issued vs total), never
  trusted from the client.

---

## Step 1 — Create the machine API key (one-time, admin)

1. Generate a long random key, e.g. in PowerShell:
   `-join ((65..90)+(97..122)+(48..57) | Get-Random -Count 48 | % {[char]$_})`
2. On **Render → EB-Backend → Environment**, add:
   `TEKLA_API_KEY = <your key>` and redeploy.
3. Keep the key on the Tekla workstations only. It is **write-only** — it can
   push reports but can never read portal data.

## Step 2 — Choose how to push from Tekla

### Option A (recommended): Tekla macro — use the READY-MADE file

**Do not copy-paste code from this document.** Use the ready file in this
repo: **[`tekla/PushModelData.cs`](tekla/PushModelData.cs)** — it is written
for Tekla's built-in macro compiler (old C#: no `$"..."` interpolation, no
`var`, classic `Script`/`Run` skeleton, `WebClient` + forced TLS 1.2).

Install steps:
1. Download `tekla/PushModelData.cs` from GitHub using **Raw → Save as**
   (never copy from a rendered page — markdown code fences (```) and smart
   quotes will break the compile with `CS1056: Unexpected character` errors).
2. Place it in the Tekla environment macros folder, e.g.
   `C:\TeklaStructures\2023.0\Environments\Australasia\macros\modeling\PushModelData.cs`
3. Open the file in Notepad and paste your key into the `API_KEY` line.
4. In Tekla: **Applications & components** → search `PushModelData` → run.
   A popup confirms what was sent (tonnage, parts, assemblies) or shows the
   exact error.
5. Optional but recommended: define a project UDA `PLANNED_TONNAGE` on the
   Tekla project — the portal uses it to compute the modeling completion %.

If your macro folder differs, check Tekla menu: File → Settings →
`XS_MACRO_DIRECTORY`.

### Option B: Tekla report template + PowerShell watcher (no coding in Tekla)

1. In Tekla: **Drawings & reports → Reports** — run a template that outputs
   CSV with the columns:
   `PROJECT,PROJECT_NAME,MODEL,PHASE,TONNAGE,ASSEMBLIES,PARTS,BOLTS,DRAWINGS_TOTAL,DRAWINGS_ISSUED`
   (Template Editor: use `PROJECT.NUMBER`, `WEIGHT` sums, etc.)
2. Save this script as `push-tekla-report.ps1` on the workstation:

```powershell
param([string]$CsvPath = "C:\TeklaReports\model_summary.csv")
$API = "https://west-epcm-backend-854824137821.us-central1.run.app/api/tekla-reports"
$KEY = "PASTE_TEKLA_API_KEY_HERE"

Import-Csv $CsvPath | ForEach-Object {
    $payload = @{
        projectNumber = $_.PROJECT
        projectName   = $_.PROJECT_NAME
        modelName     = $_.MODEL
        phase         = $_.PHASE
        reportType    = "model_summary"
        workstation   = $env:COMPUTERNAME
        metrics = @{
            tonnage        = [double]$_.TONNAGE
            assemblies     = [int]$_.ASSEMBLIES
            parts          = [int]$_.PARTS
            bolts          = [int]$_.BOLTS
            drawingsTotal  = [int]$_.DRAWINGS_TOTAL
            drawingsIssued = [int]$_.DRAWINGS_ISSUED
        }
    } | ConvertTo-Json
    Invoke-RestMethod -Uri $API -Method Post -Body $payload `
        -ContentType "application/json" -Headers @{ "X-Tekla-Api-Key" = $KEY }
}
Write-Host "Pushed $CsvPath to West EPCM portal"
```

3. Run it after generating the report (or schedule with Task Scheduler /
   attach to a Tekla macro that fires the report then the script).

> There is intentionally **no Option C** (manual portal entry). Writes
> require the machine key so the figures cannot be manipulated by hand.

---

## Step 3 — View reports (COO / Director only)

**Operations & Management → Tekla Reports** shows:
- Summary tiles: **average completion %**, models tracked, models with
  pending work, modeled tonnage, drawings issued vs total.
- A **progress board** — one card per model with MODELING / DRAWINGS /
  OVERALL completion bars (green ≥80%, amber 40–79%, red <40%) and the
  outstanding-work list ("12 drawings pending", "45.2 T modeling
  remaining", plus any `pendingItems` the plugin reports).
- Full report history table; row click → detail; COO/Director can delete
  bad entries.

## Progress fields the workstation should send

| Field | Purpose |
|---|---|
| `metrics.tonnage` | Modeled tonnage so far (from model weights) |
| `metrics.plannedTonnage` | Estimated/contract tonnage → server derives modeling % |
| `metrics.modelingPercent` | OR send an explicit % (overrides the tonnage ratio) |
| `metrics.drawingsTotal` / `drawingsIssued` | → server derives drawing % |
| `pendingItems` | Array of strings — open phases/statuses, e.g. `["Phase 3 connections not modeled", "GA drawings unchecked"]` |

CSV columns for Option B (add the new ones):
`PROJECT,PROJECT_NAME,MODEL,PHASE,TONNAGE,PLANNED_TONNAGE,ASSEMBLIES,PARTS,BOLTS,DRAWINGS_TOTAL,DRAWINGS_ISSUED`
and in the PowerShell payload add
`plannedTonnage = [double]$_.PLANNED_TONNAGE` inside `metrics`.

## API reference

`POST /api/tekla-reports`
- Auth: header `X-Tekla-Api-Key: <key>` — **machine push only**. Portal
  tokens are rejected for POST (manual entry disabled by design).
- Body: `{ projectNumber, projectName, modelName, phase, reportType,
  teklaVersion, workstation, notes, pendingItems: [...],
  metrics: { tonnage, plannedTonnage, modelingPercent, assemblies, parts,
  bolts, drawingsTotal, drawingsIssued }, rows: [...] }` (rows optional,
  ≤500, primitives only).
- Server stores computed `progress: { modelingPercent, drawingPercent,
  overallPercent, derivedPending }` alongside the raw metrics.

`GET /api/tekla-reports` — list + per-model summary (**coo/director only**).
`GET /api/tekla-reports?id=<docId>` — one report incl. detail rows.
`DELETE /api/tekla-reports?id=<docId>` — coo/director only.
