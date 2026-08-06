===========================================================
  WEST EPCM TECHNOLOGIES
  Daily Status Push for Tekla Structures
  INSTALLATION - for designers / detailers
===========================================================

Time needed: about 2 minutes.
You need the API KEY from your West EPCM administrator
(a long line of letters and numbers). If your admin already
filled it in, skip STEP 2.


-----------------------------------------------------------
STEP 1 - UNZIP
-----------------------------------------------------------
Right-click this ZIP file -> "Extract All..."
You get the file:  PushDailyStatus.cs


-----------------------------------------------------------
STEP 2 - PUT IN YOUR API KEY
-----------------------------------------------------------
1. Right-click PushDailyStatus.cs -> Open with -> Notepad
2. Find this line near the top:

      private const string API_KEY = "PASTE_TEKLA_API_KEY_HERE";

3. Replace  PASTE_TEKLA_API_KEY_HERE  with your key,
   keeping the quotes:

      private const string API_KEY = "aB3xK9mQ...your-key...";

4. Save (Ctrl+S) and close Notepad.

Do not change anything else in the file.


-----------------------------------------------------------
STEP 3 - COPY INTO TEKLA'S MACRO FOLDER
-----------------------------------------------------------
Copy PushDailyStatus.cs into the folder for your Tekla version:

  Tekla 2024:
  C:\ProgramData\Trimble\Tekla Structures\2024.0\Environments\common\macros\modeling

  Tekla 2023:
  C:\TeklaStructures\2023.0\Environments\<your environment>\macros\modeling

ProgramData is a hidden folder - paste the path into the
Windows Explorer address bar and press Enter.

If you cannot find the folder, ask your Tekla administrator
for the XS_MACRO_DIRECTORY location.


-----------------------------------------------------------
STEP 4 - RUN IT ONCE TO CHECK
-----------------------------------------------------------
1. Open your Tekla model.
2. Open "Applications & components"  (Ctrl + F).
3. Type:  push
4. Double-click  "PushDailyStatus".

The Daily Status window opens - installation is done.
Check your name in the Designer box, then click
"Push to West EPCM". You should see a confirmation.

Run it once per working day, before you log off.


-----------------------------------------------------------
IF SOMETHING GOES WRONG
-----------------------------------------------------------
Macro not listed in Applications & components
      -> Wrong folder (STEP 3), or restart Tekla.

"No Tekla model connection"
      -> Open a model first, then run the macro.

"Upload failed" / 403
      -> API key wrong or missing. Redo STEP 2.

A compile error window appears
      -> The file was not taken from this ZIP (for example
         copy-pasted from a web page). Re-extract the ZIP
         and copy the file again.

Send a screenshot of any other error to your West EPCM
administrator.

===========================================================
