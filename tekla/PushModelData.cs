// PushModelData.cs — West EPCM Technologies
// Tekla Structures macro: pushes live model data (tonnage, parts, assemblies)
// to the West EPCM portal's /api/tekla-reports endpoint.
//
// INSTALL (Tekla admin):
//   1. Download this file AS-IS (raw file — do NOT copy from a web page that
//      shows ``` characters; those are formatting, not code).
//   2. Place it in your Tekla environment macros folder, e.g.:
//        C:\TeklaStructures\2023.0\Environments\Australasia\macros\modeling\PushModelData.cs
//   3. Edit ONE line below: paste your key into API_KEY.
//   4. In Tekla: Applications & components -> search "PushModelData" -> run.
//      A popup confirms success or shows the error.
//
// Written for Tekla's built-in macro compiler (old C#): no string
// interpolation, no var/async, classic Script/Run skeleton, WebClient + TLS12.
//
// Optional: set a project User-Defined Attribute named PLANNED_TONNAGE on the
// Tekla project to make the portal compute the modeling completion %.

using System;
using System.Net;
using System.Text;
using System.Windows.Forms;
using Tekla.Structures.Model;

namespace Tekla.Technology.Akit.UserScript
{
    public class Script
    {
        private const string API_URL = "https://eb-backend-rxu6.onrender.com/api/tekla-reports";
        private const string API_KEY = "PASTE_TEKLA_API_KEY_HERE";

        public static void Run(Tekla.Technology.Akit.IScript akit)
        {
            try
            {
                Model model = new Model();
                if (!model.GetConnectionStatus())
                {
                    MessageBox.Show("No Tekla model connection. Open a model first.", "PushModelData");
                    return;
                }

                double tonnage = 0.0;
                int parts = 0;
                int assemblies = 0;

                ModelObjectEnumerator objects =
                    model.GetModelObjectSelector().GetAllObjectsWithType(
                        ModelObject.ModelObjectEnum.PART);

                while (objects.MoveNext())
                {
                    Part part = objects.Current as Part;
                    if (part == null)
                    {
                        continue;
                    }
                    parts = parts + 1;

                    double weightKg = 0.0;
                    part.GetReportProperty("WEIGHT", ref weightKg);
                    tonnage = tonnage + (weightKg / 1000.0);

                    Assembly assembly = part.GetAssembly();
                    if (assembly != null)
                    {
                        ModelObject mainPart = assembly.GetMainPart();
                        if (mainPart != null && mainPart.Identifier.ID == part.Identifier.ID)
                        {
                            assemblies = assemblies + 1;
                        }
                    }
                }

                ProjectInfo info = model.GetProjectInfo();
                string projectNumber = info.ProjectNumber;
                string projectName = info.Name;
                string modelName = model.GetInfo().ModelName;

                // Optional planned tonnage from a project UDA (drives the
                // modeling completion % in the portal).
                double plannedTonnage = 0.0;
                try
                {
                    info.GetUserProperty("PLANNED_TONNAGE", ref plannedTonnage);
                }
                catch (Exception)
                {
                    plannedTonnage = 0.0;
                }

                System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;

                StringBuilder json = new StringBuilder();
                json.Append("{");
                json.Append("\"projectNumber\":\"").Append(JsonEscape(projectNumber)).Append("\",");
                json.Append("\"projectName\":\"").Append(JsonEscape(projectName)).Append("\",");
                json.Append("\"modelName\":\"").Append(JsonEscape(modelName)).Append("\",");
                json.Append("\"reportType\":\"model_summary\",");
                json.Append("\"workstation\":\"").Append(JsonEscape(Environment.MachineName)).Append("\",");
                json.Append("\"metrics\":{");
                json.Append("\"tonnage\":").Append(Math.Round(tonnage, 2).ToString(inv)).Append(",");
                json.Append("\"plannedTonnage\":").Append(Math.Round(plannedTonnage, 2).ToString(inv)).Append(",");
                json.Append("\"assemblies\":").Append(assemblies.ToString(inv)).Append(",");
                json.Append("\"parts\":").Append(parts.ToString(inv));
                json.Append("}");
                json.Append("}");

                // Render is HTTPS-only; older .NET needs TLS 1.2 forced.
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;

                WebClient client = new WebClient();
                client.Headers.Add("Content-Type", "application/json");
                client.Headers.Add("X-Tekla-Api-Key", API_KEY);
                client.Encoding = Encoding.UTF8;
                client.UploadString(API_URL, "POST", json.ToString());

                MessageBox.Show(
                    "Sent to West EPCM portal:\n\n" +
                    "Project: " + projectNumber + "\n" +
                    "Model: " + modelName + "\n" +
                    "Tonnage: " + Math.Round(tonnage, 2).ToString(inv) + " T\n" +
                    "Parts: " + parts.ToString(inv) + "\n" +
                    "Assemblies: " + assemblies.ToString(inv),
                    "PushModelData — OK");
            }
            catch (WebException webEx)
            {
                string detail = webEx.Message;
                try
                {
                    if (webEx.Response != null)
                    {
                        System.IO.StreamReader reader = new System.IO.StreamReader(
                            webEx.Response.GetResponseStream());
                        detail = detail + "\n" + reader.ReadToEnd();
                    }
                }
                catch (Exception)
                {
                }
                MessageBox.Show("Upload failed:\n" + detail +
                    "\n\nCheck the API key and internet connection.", "PushModelData — ERROR");
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error: " + ex.Message, "PushModelData — ERROR");
            }
        }

        private static string JsonEscape(string value)
        {
            if (value == null)
            {
                return "";
            }
            StringBuilder sb = new StringBuilder();
            int i;
            for (i = 0; i < value.Length; i++)
            {
                char c = value[i];
                if (c == '"')
                {
                    sb.Append("\\\"");
                }
                else if (c == '\\')
                {
                    sb.Append("\\\\");
                }
                else if (c < ' ')
                {
                    sb.Append(' ');
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }
    }
}
