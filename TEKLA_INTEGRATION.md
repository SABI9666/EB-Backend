# Tekla Structures → West EPCM Technologies Integration

How model data (tonnage, assemblies, parts, bolts, drawing status) gets from
Tekla Structures on a detailing workstation into the **COO / Director →
Operations & Management → Tekla Reports** dashboard.

```
Tekla Structures (Windows workstation)
   │  ① Open API plugin  – or –  ② report CSV + PowerShell  – or –  ③ portal form/CSV
   ▼
POST https://eb-backend-rxu6.onrender.com/api/tekla-reports
   │  (header: X-Tekla-Api-Key)
   ▼
Firestore `tekla_reports`  ──►  COO/Director portal "Tekla Reports" view
```

---

## Step 1 — Create the machine API key (one-time, admin)

1. Generate a long random key, e.g. in PowerShell:
   `-join ((65..90)+(97..122)+(48..57) | Get-Random -Count 48 | % {[char]$_})`
2. On **Render → EB-Backend → Environment**, add:
   `TEKLA_API_KEY = <your key>` and redeploy.
3. Keep the key on the Tekla workstations only. It is **write-only** — it can
   push reports but can never read portal data.

## Step 2 — Choose how to push from Tekla

### Option A (recommended): Tekla Open API plugin (C#/.NET)

Requires Tekla Structures + Visual Studio. References:
`Tekla.Structures.dll`, `Tekla.Structures.Model.dll` (from the Tekla
installation's `bin` folder). Runs inside Tekla; push on demand or on save.

```csharp
// TeklaReportPusher.cs — minimal Open API example
using System;
using System.Collections;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Tekla.Structures.Model;

public static class TeklaReportPusher
{
    const string API_URL = "https://eb-backend-rxu6.onrender.com/api/tekla-reports";
    const string API_KEY = "PASTE_TEKLA_API_KEY_HERE";

    public static void Push()
    {
        var model = new Model();
        if (!model.GetConnectionStatus()) return;

        double tonnage = 0; int parts = 0, assemblies = 0;
        var enumerator = model.GetModelObjectSelector()
            .GetAllObjectsWithType(ModelObject.ModelObjectEnum.PART);
        while (enumerator.MoveNext())
        {
            if (enumerator.Current is Part part)
            {
                parts++;
                double weight = 0;
                part.GetReportProperty("WEIGHT", ref weight); // kg
                tonnage += weight / 1000.0;
                var assembly = part.GetAssembly();
                if (assembly != null && part.GetAssembly().GetMainPart()?.Identifier.ID
                        == part.Identifier.ID)
                    assemblies++;
            }
        }

        var payload = new
        {
            projectNumber = model.GetProjectInfo().ProjectNumber,
            projectName   = model.GetProjectInfo().Name,
            modelName     = model.GetInfo().ModelName,
            reportType    = "model_summary",
            teklaVersion  = Tekla.Structures.TeklaStructuresInfo.GetCurrentProgramVersion(),
            workstation   = Environment.MachineName,
            metrics = new { tonnage = Math.Round(tonnage, 2), assemblies, parts }
        };

        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add("X-Tekla-Api-Key", API_KEY);
        var body = new StringContent(JsonSerializer.Serialize(payload),
                                     Encoding.UTF8, "application/json");
        var resp = http.PostAsync(API_URL, body).Result;
        Console.WriteLine($"Tekla push: {(int)resp.StatusCode}");
    }
}
```

Build as a macro or plugin (`.cs` macro in `..\Environments\common\macros\modeling`
is the fastest path — no compilation deploy needed).

### Option B: Tekla report template + PowerShell watcher (no coding in Tekla)

1. In Tekla: **Drawings & reports → Reports** — run a template that outputs
   CSV with the columns:
   `PROJECT,PROJECT_NAME,MODEL,PHASE,TONNAGE,ASSEMBLIES,PARTS,BOLTS,DRAWINGS_TOTAL,DRAWINGS_ISSUED`
   (Template Editor: use `PROJECT.NUMBER`, `WEIGHT` sums, etc.)
2. Save this script as `push-tekla-report.ps1` on the workstation:

```powershell
param([string]$CsvPath = "C:\TeklaReports\model_summary.csv")
$API = "https://eb-backend-rxu6.onrender.com/api/tekla-reports"
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

### Option C: No workstation setup at all

Designers / Design Leads log into the portal and use **Tekla Reports →
➕ Add Report** (manual entry) or **⬆ Import CSV** with the same column
format as Option B. Good for day-1 while Option A/B is being set up.

---

## Step 3 — View reports (COO / Director)

**Operations & Management → Tekla Reports** shows:
- Summary tiles: models reported, total tonnage (latest per model),
  drawings issued vs total, report count.
- Filterable table of every report (project, model, phase, tonnage,
  assemblies, parts, drawings, source, who/when).
- Row click → full details. COO/Director can delete bad entries.

## API reference

`POST /api/tekla-reports`
- Auth: header `X-Tekla-Api-Key: <key>` (machine) **or** portal Bearer token
  (roles: designer, design_lead, coo, director).
- Body: `{ projectNumber, projectName, modelName, phase, reportType,
  teklaVersion, workstation, notes, metrics: { tonnage, assemblies, parts,
  bolts, drawingsTotal, drawingsIssued }, rows: [...] }` (rows optional,
  ≤500, primitives only).

`GET /api/tekla-reports` — list + per-model summary (coo/director/design_lead).
`GET /api/tekla-reports?id=<docId>` — one report incl. detail rows.
`DELETE /api/tekla-reports?id=<docId>` — coo/director only.
