// PushDailyStatus.cs — West EPCM Technologies
// Tekla Structures macro: DAILY status push.
//
// Shows one dialog with a SEPARATE row per process (Detailing, Modeling,
// Connection Design, Drafting/Drawings, Checking, Revisions, NC/DSTV, IFC,
// and BBS for rebar). The detailer enters % for each, presses Push, and the
// figures appear in the portal's Tekla Reports for COO / Director.
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

        private static string _projectNumber = "";
        private static string _projectName = "";
        private static string _modelName = "";
        private static double _tonnage = 0.0;
        private static int _parts = 0;
        private static int _assemblies = 0;

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
                    continue;
                }
                if (obj is Assembly) { _assemblies = _assemblies + 1; }
            }

            ProjectInfo info = model.GetProjectInfo();
            _projectNumber = info.ProjectNumber;
            _projectName = info.Name;
            _modelName = model.GetInfo().ModelName;
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
            _form.Text = "West EPCM — Daily Status Push";
            _form.Width = 640;
            _form.Height = 620;
            _form.StartPosition = FormStartPosition.CenterScreen;
            _form.FormBorderStyle = FormBorderStyle.FixedDialog;
            _form.MaximizeBox = false;
            _form.MinimizeBox = false;

            Label head = new Label();
            head.Text = "Daily progress — " + _projectNumber + "  |  " + _modelName;
            head.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            head.SetBounds(14, 12, 600, 22);
            _form.Controls.Add(head);

            _lblInfo = new Label();
            _lblInfo.Text = "From model: " + Math.Round(_tonnage, 2).ToString(CultureInfo.InvariantCulture)
                + " T | " + _parts.ToString() + " parts | " + _assemblies.ToString() + " assemblies";
            _lblInfo.ForeColor = Color.DimGray;
            _lblInfo.SetBounds(14, 34, 600, 18);
            _form.Controls.Add(_lblInfo);

            GroupBox gb = new GroupBox();
            gb.Text = "Work type";
            gb.SetBounds(14, 58, 300, 50);
            _rbSteel = new RadioButton();
            _rbSteel.Text = "Steel";
            _rbSteel.Checked = true;
            _rbSteel.SetBounds(14, 18, 70, 22);
            _rbSteel.CheckedChanged += new EventHandler(OnTypeChanged);
            _rbRebar = new RadioButton();
            _rbRebar.Text = "Rebar";
            _rbRebar.SetBounds(96, 18, 70, 22);
            gb.Controls.Add(_rbSteel);
            gb.Controls.Add(_rbRebar);
            _form.Controls.Add(gb);

            Label hdr = new Label();
            hdr.Text = "Process                                   % complete      done / total";
            hdr.ForeColor = Color.DimGray;
            hdr.SetBounds(16, 116, 600, 18);
            _form.Controls.Add(hdr);

            _rowsPanel = new Panel();
            _rowsPanel.SetBounds(14, 136, 600, 300);
            _rowsPanel.AutoScroll = true;
            _form.Controls.Add(_rowsPanel);

            Label dl = new Label();
            dl.Text = "Designer";
            dl.SetBounds(330, 74, 60, 18);
            _form.Controls.Add(dl);

            _tbDesigner = new TextBox();
            // Pre-filled with the signed-in Windows user so each designer's
            // push is attributed to them; editable for shared workstations.
            _tbDesigner.Text = Environment.UserName;
            _tbDesigner.SetBounds(330, 94, 284, 22);
            _form.Controls.Add(_tbDesigner);

            Label nl = new Label();
            nl.Text = "Notes / blockers (optional)";
            nl.SetBounds(14, 442, 300, 18);
            _form.Controls.Add(nl);

            _tbNotes = new TextBox();
            _tbNotes.Multiline = true;
            _tbNotes.SetBounds(14, 462, 600, 50);
            _form.Controls.Add(_tbNotes);

            Button ok = new Button();
            ok.Text = "Push to West EPCM";
            ok.SetBounds(400, 524, 214, 34);
            ok.Click += new EventHandler(OnPush);
            _form.Controls.Add(ok);

            Button later = new Button();
            later.Text = "Remind me later";
            later.SetBounds(270, 524, 120, 34);
            later.Click += new EventHandler(OnLater);
            _form.Controls.Add(later);

            BuildRows();
            _form.ShowDialog();
        }

        private static void OnTypeChanged(object sender, EventArgs e) { BuildRows(); }
        private static void OnLater(object sender, EventArgs e) { _form.Close(); }

        private static void BuildRows()
        {
            _rowsPanel.Controls.Clear();
            _keys.Clear(); _pcts.Clear(); _dones.Clear(); _totals.Clear();

            string[] keys = _rbSteel.Checked ? STEEL_KEYS : REBAR_KEYS;
            string[] labels = _rbSteel.Checked ? STEEL_LABELS : REBAR_LABELS;

            int y = 6;
            int i;
            for (i = 0; i < keys.Length; i++)
            {
                Label lb = new Label();
                lb.Text = labels[i];
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

                _keys.Add(keys[i]);
                _pcts.Add(nud);
                _dones.Add(done);
                _totals.Add(tot);

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

                    if (acts.Length > 0) { acts.Append(","); }
                    acts.Append("\"").Append(_keys[i]).Append("\":{");
                    acts.Append("\"percent\":").Append(pct.ToString(inv));
                    if (doneS.Length > 0) { acts.Append(",\"done\":").Append(SafeInt(doneS)); }
                    if (totS.Length > 0) { acts.Append(",\"total\":").Append(SafeInt(totS)); }
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
                client.Headers.Add("Content-Type", "application/json");
                client.Headers.Add("X-Tekla-Api-Key", API_KEY);
                client.Encoding = Encoding.UTF8;
                client.UploadString(API_URL, "POST", json.ToString());

                MarkPushedToday();
                MessageBox.Show("Sent to West EPCM portal.\n\nProcesses reported: "
                    + reported.ToString() + "\nProject: " + _projectNumber
                    + "\nDesigner: " + _tbDesigner.Text.Trim(),
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
