Option Explicit

Dim shell, fso, appDir, electronExe, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electronExe) Then
  MsgBox "Electron was not found. Run npm install in the repo first.", vbCritical, "Recovered Chats"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir

command = """" & electronExe & """ electron\recovery-main.js"
shell.Run command, 1, False
