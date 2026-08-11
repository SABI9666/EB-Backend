// PushDailyStatus.cs — West EPCM Technologies
// Tekla Structures macro: DAILY status push.
//
// Shows one dialog with a SEPARATE row per process (Detailing, Modeling,
// Connection Design, Drafting/Drawings, Checking, Revisions, NC/DSTV, IFC,
// and BBS for rebar). The detailer enters % for each, presses Push, and the
// figures appear in the portal's Tekla Reports for COO / Director.
//
// AUTOMATIC PERCENTAGES
//   Where the model itself can answer the question, the row is pre-filled
//   and marked "(auto)". Nothing is typed for these:
//     Modeling  = modelled tonnage / PLANNED_TONNAGE project attribute
//     Detailing = parts carrying an assembly position / all parts
//     Drafting  = *.dg files in <model>\drawings / assemblies
//     NC/DSTV   = *.nc1 files in the model folder / all parts
//   Each auto row is sent with source="auto" plus the figures it was
//   derived from, so management can tell computed values from typed ones.
//   If the designer edits an auto row it is sent as source="manual".
//
// DAILY PROMPT
//   The macro records the last successful push per model under
//   %APPDATA%\WestEPCM\. If a push already happened today it exits silently
//   (unless the user runs it manually — see FORCE below), so it can be
//   attached to Tekla startup or a scheduled task and will nag only once
//   per day, per model.
//
// INSTALL (Tekla admin)
//   1. Download this file RAW (do not copy from a rendered web page).
//   2. Copy to the environment macros\modeling folder, e.g.
//      Tekla 2024: C:\ProgramData\Trimble\Tekla Structures\2024.0\Environments\common\macros\modeling\PushDailyStatus.cs
//      Tekla 2023: C:\TeklaStructures\2023.0\Environments\<env>\macros\modeling\PushDailyStatus.cs
//   3. Edit ONE line below: paste your key into API_KEY.
//   4. Run once from Applications & components -> "PushDailyStatus".
//
// AUTOMATIC DAILY PROMPT (pick one)
//   a) Add the macro to your Tekla startup macro list, or
//   b) Windows Task Scheduler -> daily -> run Tekla with the macro, or
//   c) Ask detailers to click it before logging off (simplest).
//
// Written for Tekla's built-in macro compiler (old C#): no string
// interpolation, no var/async/lambdas, classic Script/Run skeleton,
// WebClient + forced TLS 1.2, WinForms dialog built in code.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Windows.Forms;
using Tekla.Structures.Model;

namespace Tekla.Technology.Akit.UserScript
{
    public class Script
    {
        private const string API_URL = "https://west-epcm-backend-854824137821.us-central1.run.app/api/tekla-reports";
        private const string API_KEY = "PASTE_TEKLA_API_KEY_HERE";

        // Set true to always show the dialog, even if already pushed today.
        private const bool FORCE_ALWAYS_SHOW = true;

        // "Remind me later" re-opens the dialog after this many minutes,
        // and keeps doing so until the day's push is made. The timer lives
        // on Tekla's UI thread, so it survives the dialog closing but dies
        // with Tekla itself — it can never nag outside the application.
        private const int REMIND_MINUTES = 5;
        private static Timer _remindTimer;

        // West EPCM palette (matches the portal)
        private static Color CLR_DARK = Color.FromArgb(15, 23, 42);
        private static Color CLR_ACCENT = Color.FromArgb(14, 158, 209);
        private static Color CLR_TEAL = Color.FromArgb(0, 110, 115);
        private static Color CLR_BG = Color.FromArgb(245, 248, 251);
        private static Color CLR_MUTED = Color.FromArgb(100, 116, 139);

        // Activity rows. Key must match the portal: modeling, connection,
        // detailing, drafting, checking, revisions, nc, ifc, bbs.
        private static string[] STEEL_KEYS   = { "modeling", "connection", "detailing", "drafting", "checking", "revisions", "nc", "ifc" };
        private static string[] STEEL_LABELS = { "3D Modeling", "Connection Design", "Detailing", "Drawing Production", "Checking", "Revisions", "NC / DSTV Files", "IFC / Issue" };
        private static string[] REBAR_KEYS   = { "modeling", "detailing", "bbs", "drafting", "checking", "revisions", "ifc" };
        private static string[] REBAR_LABELS = { "3D Modeling", "Detailing", "Bar Bending Schedule", "Drawing Production", "Checking", "Revisions", "IFC / Issue" };

        private static Form _form;
        private static RadioButton _rbSteel;
        private static RadioButton _rbRebar;
        private static Panel _rowsPanel;
        private static TextBox _tbNotes;
        private static TextBox _tbDesigner;
        private static Label _lblInfo;
        private static List<string> _keys = new List<string>();
        private static List<NumericUpDown> _pcts = new List<NumericUpDown>();
        private static List<TextBox> _dones = new List<TextBox>();
        private static List<TextBox> _totals = new List<TextBox>();

        private static List<bool> _autoFlags = new List<bool>();
        private static List<decimal> _autoSeed = new List<decimal>();

        private static string _projectNumber = "";
        private static string _projectName = "";
        private static string _modelName = "";
        private static string _modelPath = "";
        private static double _tonnage = 0.0;
        private static int _parts = 0;
        private static int _assemblies = 0;

        // Figures used by the automatic percentage logic.
        private static int _partsNumbered = 0;
        private static double _plannedTonnage = 0.0;
        private static int _dgFiles = 0;
        private static int _ncFiles = 0;

        // key -> { percent, done, total }   (-1 = not available)
        private static Dictionary<string, double[]> _auto = new Dictionary<string, double[]>();
        // key -> short explanation of how the percentage was derived
        private static Dictionary<string, string> _autoNote = new Dictionary<string, string>();

        public static void Run(Tekla.Technology.Akit.IScript akit)
        {
            try
            {
                Model model = new Model();
                if (!model.GetConnectionStatus())
                {
                    MessageBox.Show("No Tekla model connection. Open a model first.", "Daily Status");
                    return;
                }

                ReadModel(model);
                ComputeAuto();

                if (!FORCE_ALWAYS_SHOW && AlreadyPushedToday())
                {
                    return; // already reported today — stay quiet
                }

                ShowDialog();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error: " + ex.Message, "Daily Status — ERROR");
            }
        }

        // ── Read live model figures (auto-filled, not typed by the user) ──
        private static void ReadModel(Model model)
        {
            // Statics survive between macro runs inside one Tekla session —
            // without this reset a second run would double-count everything.
            _tonnage = 0.0; _parts = 0; _assemblies = 0; _partsNumbered = 0;
            _plannedTonnage = 0.0; _dgFiles = 0; _ncFiles = 0;

            ModelObjectEnumerator objects = model.GetModelObjectSelector().GetAllObjects();
            while (objects.MoveNext())
            {
                ModelObject obj = objects.Current;
                Part part = obj as Part;
                if (part != null)
                {
                    _parts = _parts + 1;
                    double w = 0.0;
                    part.GetReportProperty("WEIGHT", ref w);
                    _tonnage = _tonnage + (w / 1000.0);

                    // A part that already carries an assembly position has
                    // been numbered — that is the detailing progress signal.
                    string pos = "";
                    part.GetReportProperty("ASSEMBLY_POS", ref pos);
                    if (pos != null)
                    {
                        pos = pos.Trim();
                        if (pos.Length > 0 && pos != "0") { _partsNumbered = _partsNumbered + 1; }
                    }
                    continue;
                }
                if (obj is Assembly) { _assemblies = _assemblies + 1; }
            }

            ProjectInfo info = model.GetProjectInfo();
            _projectNumber = info.ProjectNumber;
            _projectName = info.Name;

            ModelInfo mi = model.GetInfo();
            _modelName = mi.ModelName;
            _modelPath = mi.ModelPath;

            // Planned tonnage comes from a project attribute set by the
            // project engineer, so modeling % can be derived without typing.
            double planned = 0.0;
            if (info.GetUserProperty("PLANNED_TONNAGE", ref planned)) { _plannedTonnage = planned; }
            if (_plannedTonnage <= 0.0)
            {
                double planned2 = 0.0;
                if (info.GetUserProperty("EST_TONNAGE", ref planned2)) { _plannedTonnage = planned2; }
            }

            // Drawings and NC files live on disk — counting them needs no
            // extra Tekla API and works on every version.
            _dgFiles = CountFiles(Path.Combine(_modelPath, "drawings"), "*.dg", false);
            _ncFiles = CountNcFiles();
        }

        private static int CountFiles(string folder, string pattern, bool recurse)
        {
            try
            {
                if (folder == null || folder.Length == 0) { return 0; }
                if (!Directory.Exists(folder)) { return 0; }
                SearchOption opt = recurse ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
                return Directory.GetFiles(folder, pattern, opt).Length;
            }
            catch (Exception) { return 0; }
        }

        private static int CountNcFiles()
        {
            if (_modelPath == null || _modelPath.Length == 0) { return 0; }
            string[] candidates = { "DSTV_Profiles", "DSTV", "NC", "nc_files", "DSTV_Plates" };
            int total = 0;
            int i;
            for (i = 0; i < candidates.Length; i++)
            {
                total = total + CountFiles(Path.Combine(_modelPath, candidates[i]), "*.nc1", true);
            }
            total = total + CountFiles(_modelPath, "*.nc1", false);
            return total;
        }

        // ── Automatic percentages derived from the model itself ──────────
        // Only processes with a reliable signal are filled in. Everything
        // else stays blank for the designer to enter.
        private static void ComputeAuto()
        {
            _auto.Clear();
            _autoNote.Clear();

            if (_plannedTonnage > 0.0 && _tonnage > 0.0)
            {
                double p = (_tonnage / _plannedTonnage) * 100.0;
                _auto["modeling"] = new double[] { Clamp(p), -1.0, -1.0 };
                _autoNote["modeling"] = "auto: " + Math.Round(_tonnage, 2).ToString(CultureInfo.InvariantCulture)
                    + " T modelled of " + Math.Round(_plannedTonnage, 2).ToString(CultureInfo.InvariantCulture) + " T planned";
            }

            if (_parts > 0)
            {
                double p = ((double)_partsNumbered / (double)_parts) * 100.0;
                _auto["detailing"] = new double[] { Clamp(p), (double)_partsNumbered, (double)_parts };
                _autoNote["detailing"] = "auto: " + _partsNumbered.ToString(CultureInfo.InvariantCulture)
                    + " of " + _parts.ToString(CultureInfo.InvariantCulture) + " parts numbered";
            }

            if (_assemblies > 0 && _dgFiles > 0)
            {
                double p = ((double)_dgFiles / (double)_assemblies) * 100.0;
                _auto["drafting"] = new double[] { Clamp(p), (double)_dgFiles, (double)_assemblies };
                _autoNote["drafting"] = "auto: " + _dgFiles.ToString(CultureInfo.InvariantCulture)
                    + " drawings for " + _assemblies.ToString(CultureInfo.InvariantCulture) + " assemblies";
            }

            if (_parts > 0 && _ncFiles > 0)
            {
                double p = ((double)_ncFiles / (double)_parts) * 100.0;
                _auto["nc"] = new double[] { Clamp(p), (double)_ncFiles, (double)_parts };
                _autoNote["nc"] = "auto: " + _ncFiles.ToString(CultureInfo.InvariantCulture)
                    + " NC files for " + _parts.ToString(CultureInfo.InvariantCulture) + " parts";
            }
        }

        private static double Clamp(double v)
        {
            if (v < 0.0) { return 0.0; }
            if (v > 100.0) { return 100.0; }
            return Math.Round(v, 0);
        }

        // ── Daily throttle: one file per model under %APPDATA%\WestEPCM ──
        private static string StampPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "WestEPCM");
            if (!Directory.Exists(dir)) { Directory.CreateDirectory(dir); }
            string safe = _modelName;
            char[] bad = Path.GetInvalidFileNameChars();
            int i;
            for (i = 0; i < bad.Length; i++) { safe = safe.Replace(bad[i], '_'); }
            return Path.Combine(dir, "lastpush_" + safe + ".txt");
        }

        private static bool AlreadyPushedToday()
        {
            try
            {
                string f = StampPath();
                if (!File.Exists(f)) { return false; }
                string txt = File.ReadAllText(f).Trim();
                return txt == DateTime.Now.ToString("yyyy-MM-dd");
            }
            catch (Exception) { return false; }
        }

        private static void MarkPushedToday()
        {
            try { File.WriteAllText(StampPath(), DateTime.Now.ToString("yyyy-MM-dd")); }
            catch (Exception) { }
        }

        // ── Dialog ───────────────────────────────────────────────────────
        private static void ShowDialog()
        {
            _form = new Form();
            _form.Text = "West EPCM Technologies — Daily Status";
            _form.Width = 660;
            _form.Height = 700;
            _form.StartPosition = FormStartPosition.CenterScreen;
            _form.FormBorderStyle = FormBorderStyle.FixedDialog;
            _form.MaximizeBox = false;
            _form.MinimizeBox = false;
            _form.BackColor = Color.White;
            _form.Font = new Font("Segoe UI", 9f);

            // ── Branded header band ─────────────────────────────────────
            Panel band = new Panel();
            band.BackColor = CLR_DARK;
            band.SetBounds(0, 0, 660, 78);
            _form.Controls.Add(band);

            Label logo = new Label();
            logo.Text = "W";
            logo.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            logo.ForeColor = Color.White;
            logo.BackColor = CLR_ACCENT;
            logo.TextAlign = ContentAlignment.MiddleCenter;
            logo.SetBounds(16, 16, 44, 44);
            band.Controls.Add(logo);

            Label brand = new Label();
            brand.Text = "West EPCM Technologies";
            brand.Font = new Font("Segoe UI", 12f, FontStyle.Bold);
            brand.ForeColor = Color.White;
            brand.BackColor = CLR_DARK;
            brand.SetBounds(72, 16, 400, 24);
            band.Controls.Add(brand);

            Label sub = new Label();
            sub.Text = "Daily Status Push — " + _projectNumber + "  |  " + _modelName;
            sub.Font = new Font("Segoe UI", 8.5f);
            sub.ForeColor = Color.FromArgb(148, 163, 184);
            sub.BackColor = CLR_DARK;
            sub.SetBounds(72, 42, 560, 18);
            band.Controls.Add(sub);

            // ── Model figures strip ─────────────────────────────────────
            _lblInfo = new Label();
            _lblInfo.Text = "  MODEL   " + Math.Round(_tonnage, 2).ToString(CultureInfo.InvariantCulture)
                + " T   ·   " + _parts.ToString() + " parts (" + _partsNumbered.ToString() + " numbered)   ·   "
                + _assemblies.ToString() + " assemblies   ·   " + _dgFiles.ToString() + " drawings   ·   "
                + _ncFiles.ToString() + " NC files";
            _lblInfo.BackColor = CLR_BG;
            _lblInfo.ForeColor = CLR_MUTED;
            _lblInfo.Font = new Font("Segoe UI", 8.25f, FontStyle.Bold);
            _lblInfo.TextAlign = ContentAlignment.MiddleLeft;
            _lblInfo.SetBounds(0, 78, 660, 28);
            _form.Controls.Add(_lblInfo);

            // ── Work type + designer ────────────────────────────────────
            GroupBox gb = new GroupBox();
            gb.Text = "Work type";
            gb.ForeColor = CLR_MUTED;
            gb.SetBounds(16, 116, 290, 52);
            _rbSteel = new RadioButton();
            _rbSteel.Text = "Steel";
            _rbSteel.Checked = true;
            _rbSteel.ForeColor = CLR_DARK;
            _rbSteel.SetBounds(14, 20, 70, 22);
            _rbSteel.CheckedChanged += new EventHandler(OnTypeChanged);
            _rbRebar = new RadioButton();
            _rbRebar.Text = "Rebar";
            _rbRebar.ForeColor = CLR_DARK;
            _rbRebar.SetBounds(96, 20, 70, 22);
            gb.Controls.Add(_rbSteel);
            gb.Controls.Add(_rbRebar);
            _form.Controls.Add(gb);

            Label dl = new Label();
            dl.Text = "DESIGNER";
            dl.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            dl.ForeColor = CLR_MUTED;
            dl.SetBounds(330, 118, 90, 16);
            _form.Controls.Add(dl);

            _tbDesigner = new TextBox();
            // Pre-filled with the signed-in Windows user so each designer's
            // push is attributed to them; editable for shared workstations.
            _tbDesigner.Text = Environment.UserName;
            _tbDesigner.Font = new Font("Segoe UI", 9.5f);
            _tbDesigner.SetBounds(330, 136, 296, 26);
            _form.Controls.Add(_tbDesigner);

            // ── Process rows ────────────────────────────────────────────
            Label hdr = new Label();
            hdr.Text = "PROCESS                                              % COMPLETE          DONE / TOTAL";
            hdr.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            hdr.ForeColor = CLR_MUTED;
            hdr.SetBounds(18, 178, 600, 16);
            _form.Controls.Add(hdr);

            Label legend = new Label();
            legend.Text = "Rows marked ● auto are calculated from the model — change only if wrong.";
            legend.Font = new Font("Segoe UI", 8f);
            legend.ForeColor = CLR_TEAL;
            legend.SetBounds(18, 194, 600, 16);
            _form.Controls.Add(legend);

            _rowsPanel = new Panel();
            _rowsPanel.SetBounds(16, 214, 612, 290);
            _rowsPanel.AutoScroll = true;
            _rowsPanel.BackColor = Color.White;
            _form.Controls.Add(_rowsPanel);

            // ── Notes + actions ─────────────────────────────────────────
            Label nl = new Label();
            nl.Text = "NOTES / BLOCKERS (OPTIONAL)";
            nl.Font = new Font("Segoe UI", 7.5f, FontStyle.Bold);
            nl.ForeColor = CLR_MUTED;
            nl.SetBounds(16, 512, 300, 16);
            _form.Controls.Add(nl);

            _tbNotes = new TextBox();
            _tbNotes.Multiline = true;
            _tbNotes.SetBounds(16, 530, 612, 52);
            _form.Controls.Add(_tbNotes);

            Button ok = new Button();
            ok.Text = "Push to West EPCM";
            ok.FlatStyle = FlatStyle.Flat;
            ok.FlatAppearance.BorderSize = 0;
            ok.BackColor = CLR_ACCENT;
            ok.ForeColor = Color.White;
            ok.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            ok.SetBounds(414, 596, 214, 38);
            ok.Click += new EventHandler(OnPush);
            _form.Controls.Add(ok);

            Button later = new Button();
            later.Text = "Remind me in " + REMIND_MINUTES.ToString() + " min";
            later.FlatStyle = FlatStyle.Flat;
            later.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            later.BackColor = Color.White;
            later.ForeColor = CLR_MUTED;
            later.SetBounds(266, 596, 136, 38);
            later.Click += new EventHandler(OnLater);
            _form.Controls.Add(later);

            Label remindNote = new Label();
            remindNote.Text = AlreadyPushedToday()
                ? "Already pushed today — pushing again just updates the figures."
                : "Not pushed today. \"Remind me\" will re-open this every " + REMIND_MINUTES.ToString() + " minutes until you push.";
            remindNote.Font = new Font("Segoe UI", 7.75f);
            remindNote.ForeColor = CLR_MUTED;
            remindNote.SetBounds(18, 640, 610, 16);
            _form.Controls.Add(remindNote);

            BuildRows();
            _form.ShowDialog();
        }

        private static void OnTypeChanged(object sender, EventArgs e) { BuildRows(); }

        // "Remind me later": close now, come back in REMIND_MINUTES — but
        // only if today's push still hasn't happened by then.
        private static void OnLater(object sender, EventArgs e)
        {
            StartReminder();
            _form.Close();
        }

        private static void StartReminder()
        {
            try
            {
                if (_remindTimer == null)
                {
                    _remindTimer = new Timer();
                    _remindTimer.Tick += new EventHandler(OnRemindTick);
                }
                _remindTimer.Interval = REMIND_MINUTES * 60 * 1000;
                _remindTimer.Stop();
                _remindTimer.Start();
            }
            catch (Exception) { }
        }

        private static void StopReminder()
        {
            try { if (_remindTimer != null) { _remindTimer.Stop(); } }
            catch (Exception) { }
        }

        private static void OnRemindTick(object sender, EventArgs e)
        {
            try
            {
                _remindTimer.Stop();
                if (AlreadyPushedToday()) { return; }         // job done — stand down
                if (_form != null && _form.Visible) { StartReminder(); return; } // already open
                ShowDialog();
            }
            catch (Exception) { }
        }

        private static void BuildRows()
        {
            _rowsPanel.Controls.Clear();
            _keys.Clear(); _pcts.Clear(); _dones.Clear(); _totals.Clear();
            _autoFlags.Clear(); _autoSeed.Clear();

            string[] keys = _rbSteel.Checked ? STEEL_KEYS : REBAR_KEYS;
            string[] labels = _rbSteel.Checked ? STEEL_LABELS : REBAR_LABELS;
            CultureInfo inv = CultureInfo.InvariantCulture;

            int y = 6;
            int i;
            for (i = 0; i < keys.Length; i++)
            {
                bool isAuto = _auto.ContainsKey(keys[i]);

                Label lb = new Label();
                lb.Text = isAuto ? (labels[i] + "  ● auto") : labels[i];
                lb.ForeColor = isAuto ? CLR_TEAL : CLR_DARK;
                if (isAuto) { lb.Font = new Font("Segoe UI", 9f, FontStyle.Bold); }
                lb.SetBounds(4, y + 4, 210, 20);
                _rowsPanel.Controls.Add(lb);

                NumericUpDown nud = new NumericUpDown();
                nud.Minimum = 0; nud.Maximum = 100; nud.Increment = 5;
                nud.SetBounds(224, y, 70, 22);
                _rowsPanel.Controls.Add(nud);

                Label pc = new Label();
                pc.Text = "%";
                pc.SetBounds(298, y + 4, 20, 20);
                _rowsPanel.Controls.Add(pc);

                TextBox done = new TextBox();
                done.SetBounds(330, y, 60, 22);
                _rowsPanel.Controls.Add(done);

                Label sl = new Label();
                sl.Text = "/";
                sl.SetBounds(394, y + 4, 12, 20);
                _rowsPanel.Controls.Add(sl);

                TextBox tot = new TextBox();
                tot.SetBounds(408, y, 60, 22);
                _rowsPanel.Controls.Add(tot);

                if (isAuto)
                {
                    double[] a = _auto[keys[i]];
                    nud.Value = (decimal)a[0];
                    if (a[1] >= 0.0) { done.Text = ((int)a[1]).ToString(inv); }
                    if (a[2] >= 0.0) { tot.Text = ((int)a[2]).ToString(inv); }

                    if (_autoNote.ContainsKey(keys[i]))
                    {
                        Label hint = new Label();
                        hint.Text = _autoNote[keys[i]];
                        hint.ForeColor = Color.Gray;
                        hint.SetBounds(478, y + 4, 110, 20);
                        hint.AutoEllipsis = true;
                        _rowsPanel.Controls.Add(hint);
                    }
                }

                _keys.Add(keys[i]);
                _pcts.Add(nud);
                _dones.Add(done);
                _totals.Add(tot);
                _autoFlags.Add(isAuto);
                _autoSeed.Add(nud.Value);

                y = y + 30;
            }
        }

        // ── Push ─────────────────────────────────────────────────────────
        private static void OnPush(object sender, EventArgs e)
        {
            try
            {
                CultureInfo inv = CultureInfo.InvariantCulture;
                StringBuilder acts = new StringBuilder();
                int i;
                int reported = 0;
                for (i = 0; i < _keys.Count; i++)
                {
                    int pct = (int)_pcts[i].Value;
                    string doneS = _dones[i].Text.Trim();
                    string totS = _totals[i].Text.Trim();
                    // Skip rows left completely untouched.
                    if (pct == 0 && doneS.Length == 0 && totS.Length == 0) { continue; }

                    // Untouched auto rows are reported as computed by the
                    // macro; anything the designer changed becomes manual.
                    bool stillAuto = _autoFlags[i] && _pcts[i].Value == _autoSeed[i];

                    if (acts.Length > 0) { acts.Append(","); }
                    acts.Append("\"").Append(_keys[i]).Append("\":{");
                    acts.Append("\"percent\":").Append(pct.ToString(inv));
                    if (doneS.Length > 0) { acts.Append(",\"done\":").Append(SafeInt(doneS)); }
                    if (totS.Length > 0) { acts.Append(",\"total\":").Append(SafeInt(totS)); }
                    acts.Append(",\"source\":\"").Append(stillAuto ? "auto" : "manual").Append("\"");
                    if (stillAuto && _autoNote.ContainsKey(_keys[i]))
                    {
                        acts.Append(",\"note\":\"").Append(Esc(_autoNote[_keys[i]])).Append("\"");
                    }
                    acts.Append("}");
                    reported = reported + 1;
                }

                if (reported == 0)
                {
                    MessageBox.Show("Enter progress for at least one process.", "Daily Status");
                    return;
                }
                if (_tbDesigner.Text.Trim().Length == 0)
                {
                    MessageBox.Show("Enter the designer name.", "Daily Status");
                    return;
                }

                StringBuilder json = new StringBuilder();
                json.Append("{");
                json.Append("\"projectNumber\":\"").Append(Esc(_projectNumber)).Append("\",");
                json.Append("\"projectName\":\"").Append(Esc(_projectName)).Append("\",");
                json.Append("\"modelName\":\"").Append(Esc(_modelName)).Append("\",");
                json.Append("\"reportType\":\"model_summary\",");
                json.Append("\"workType\":\"").Append(_rbSteel.Checked ? "steel" : "rebar").Append("\",");
                json.Append("\"workstation\":\"").Append(Esc(Environment.MachineName)).Append("\",");
                json.Append("\"designer\":\"").Append(Esc(_tbDesigner.Text.Trim())).Append("\",");
                json.Append("\"notes\":\"").Append(Esc(_tbNotes.Text)).Append("\",");
                json.Append("\"metrics\":{");
                json.Append("\"tonnage\":").Append(Math.Round(_tonnage, 2).ToString(inv)).Append(",");
                json.Append("\"parts\":").Append(_parts.ToString(inv)).Append(",");
                json.Append("\"assemblies\":").Append(_assemblies.ToString(inv));
                json.Append("},");
                json.Append("\"activities\":{").Append(acts.ToString()).Append("}");
                json.Append("}");

                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
                WebClient client = new WebClient();
                // Catch a key that was never pasted in BEFORE going to the
                // network — the server can only answer "unauthorized", but
                // here we can say exactly what to fix.
                string key = API_KEY.Trim();
                if (key.Length == 0 || key == "PASTE_TEKLA_API_KEY_HERE")
                {
                    MessageBox.Show(
                        "The API key has not been set on this workstation.\n\n"
                        + "Open this file in Notepad:\n"
                        + "  PushDailyStatus.cs  (in the Tekla macros folder)\n\n"
                        + "and replace PASTE_TEKLA_API_KEY_HERE with the key\n"
                        + "from your West EPCM administrator (STEP 2 of the\n"
                        + "install guide). Then restart Tekla and push again.",
                        "Daily Status — API key missing");
                    return;
                }

                client.Headers.Add("Content-Type", "application/json");
                client.Headers.Add("X-Tekla-Api-Key", key);
                client.Encoding = Encoding.UTF8;
                string reply = client.UploadString(API_URL, "POST", json.ToString());

                // The server reports back how many processes it actually
                // stored. If that is 0 while we sent some, the push landed
                // on an out-of-date backend that dropped them — the designer
                // should know now, not the COO three days later.
                int stored = ReadStored(reply);
                string warn = "";
                if (stored == 0 && reported > 0)
                {
                    warn = "\n\nWARNING: the portal stored 0 processes."
                         + "\nOnly model totals were saved. Tell your West EPCM"
                         + "\nadministrator the backend needs updating, then"
                         + "\npush again.";
                }

                MarkPushedToday();
                StopReminder();
                MessageBox.Show("Sent to West EPCM portal.\n\nProcesses reported: "
                    + reported.ToString()
                    + (stored >= 0 ? "\nProcesses stored by portal: " + stored.ToString() : "")
                    + "\nProject: " + _projectNumber
                    + "\nDesigner: " + _tbDesigner.Text.Trim()
                    + warn,
                    "Daily Status — OK");
                _form.Close();
            }
            catch (WebException webEx)
            {
                string detail = webEx.Message;
                try
                {
                    if (webEx.Response != null)
                    {
                        StreamReader r = new StreamReader(webEx.Response.GetResponseStream());
                        detail = detail + "\n" + r.ReadToEnd();
                    }
                }
                catch (Exception) { }
                MessageBox.Show("Upload failed:\n" + detail, "Daily Status — ERROR");
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error: " + ex.Message, "Daily Status — ERROR");
            }
        }

        // Pulls "activitiesStored":N out of the JSON reply without needing a
        // parser. Returns -1 when the field is absent (older backend).
        private static int ReadStored(string reply)
        {
            try
            {
                if (reply == null) { return -1; }
                string tag = "\"activitiesStored\"";
                int i = reply.IndexOf(tag);
                if (i < 0) { return -1; }
                i = reply.IndexOf(':', i + tag.Length);
                if (i < 0) { return -1; }
                i = i + 1;
                StringBuilder digits = new StringBuilder();
                while (i < reply.Length)
                {
                    char c = reply[i];
                    if (c == ' ') { i = i + 1; continue; }
                    if (c < '0' || c > '9') { break; }
                    digits.Append(c);
                    i = i + 1;
                }
                if (digits.Length == 0) { return -1; }
                int v = 0;
                if (!int.TryParse(digits.ToString(), out v)) { return -1; }
                return v;
            }
            catch (Exception) { return -1; }
        }

        private static string SafeInt(string t)
        {
            int v = 0;
            if (!int.TryParse(t, out v)) { v = 0; }
            return v.ToString(CultureInfo.InvariantCulture);
        }

        private static string Esc(string value)
        {
            if (value == null) { return ""; }
            StringBuilder sb = new StringBuilder();
            int i;
            for (i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '"') { sb.Append("\\\""); }
                else if (c == '\\') { sb.Append("\\\\"); }
                else if (c < ' ') { sb.Append(' '); }
                else { sb.Append(c); }
            }
            return sb.ToString();
        }
    }
}
