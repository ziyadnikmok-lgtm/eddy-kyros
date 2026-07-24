Option Explicit

Dim shell, fso, appDir, electronExe, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electronExe) Then
  MsgBox "Electron was not found. Run npm install in the Kyros folder first.", vbCritical, "Kyros Studio"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir
shell.Environment("PROCESS")("KYROS_FORCE_LOCAL") = "1"
shell.Environment("PROCESS")("REMOTE_URL") = ""
On Error Resume Next
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

command = """" & electronExe & """ ."
shell.Run command, 1, False
