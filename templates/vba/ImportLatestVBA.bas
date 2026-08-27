Attribute VB_Name = "ImportLatestVBA"
Option Explicit

' Prompt 21: one-time bootstrap module — paste this into a NEW standard
' module once (Insert -> Module, name it "ImportLatestVBA", paste this
' whole file). From then on, this Sub can be rerun any time
' SyncEngine.bas / clsSheetWatcher.cls / ThisWorkbook.bas change on disk,
' reloading all three straight from those files — no manual copy-pasting
' for any future update. Requires "Trust access to the VBA project object
' model" enabled (Excel > Preferences > Security > Macro Security... on
' Mac; File > Options > Trust Center on Windows).
'
' Uses ONLY CodeModule.DeleteLines/AddFromString for every managed
' component — never VBComponents.Import/Remove. Import's handling of a
' class module's VERSION/BEGIN/END header proved unreliable on at least
' one real Mac Excel build (produced a genuine compile error, "Expected:
' end of statement", pointing at the header block itself, imported as
' literal code instead of being recognized as component metadata) — this
' sidesteps Import entirely rather than depend on it for any component.
' That means SyncEngine and clsSheetWatcher must already exist as
' components before this Sub can refill their code; if either is
' missing, the report below says exactly which one and what to do.
'
' IMPORTANT after running this Sub: close the workbook completely and
' reopen it before testing anything. Workbook_Open is what actually
' registers every sheet's event watcher, and redefining a class module's
' code (clsSheetWatcher) while old instances of it are still alive in a
' running session is not something VBA guarantees will behave — a full
' close/reopen guarantees a clean state built from the freshly loaded code.

Private Const VBA_SOURCE_DIR As String = _
    "/Users/puvanesh/Invoice-Gen-V2/invoice-gen-v2/templates/vba/"

' Reads a .bas/.cls file and returns just its real code — strips any
' leading VERSION/BEGIN/MultiUse/END class-header block and any leading
' "Attribute ..." lines (both are component metadata, never valid inside
' a CodeModule.AddFromString call).
Private Function ReadCodeBody(path As String) As String
    Dim fnum As Integer, ln As String, content As String, inHeader As Boolean
    inHeader = True
    fnum = FreeFile
    Open path For Input As #fnum
    Do While Not EOF(fnum)
        Line Input #fnum, ln
        If inHeader Then
            If Left(ln, 7) = "VERSION" Or ln = "BEGIN" Or ln = "END" Or _
               Left(Trim(ln), 8) = "MultiUse" Or Left(ln, 10) = "Attribute " Then
                ' still header/attribute metadata — skip this line
            Else
                inHeader = False
            End If
        End If
        If Not inHeader Then content = content & ln & vbCrLf
    Loop
    Close #fnum
    ReadCodeBody = content
End Function

Private Function ReloadComponent(proj As Object, componentName As String, filePath As String) As String
    On Error GoTo Fail
    Dim mod1 As Object
    Set mod1 = proj.VBComponents(componentName).CodeModule
    If mod1.CountOfLines > 0 Then mod1.DeleteLines 1, mod1.CountOfLines
    mod1.AddFromString ReadCodeBody(filePath)
    ReloadComponent = componentName & ": reloaded." & vbCrLf
    Exit Function
Fail:
    ReloadComponent = componentName & ": FAILED - " & Err.Description & _
        " (does the component exist yet? Insert -> Module/Class Module, name it exactly '" & _
        componentName & "', then rerun.)" & vbCrLf
End Function

Public Sub ImportLatestVBA()
    Dim proj As Object
    Set proj = ThisWorkbook.VBProject

    Dim report As String
    report = ""
    report = report & ReloadComponent(proj, "SyncEngine", VBA_SOURCE_DIR & "SyncEngine.bas")
    report = report & ReloadComponent(proj, "clsSheetWatcher", VBA_SOURCE_DIR & "clsSheetWatcher.cls")
    report = report & ReloadComponent(proj, "ThisWorkbook", VBA_SOURCE_DIR & "ThisWorkbook.bas")

    report = report & vbCrLf & "Now SAVE, then CLOSE and REOPEN this file before testing."
    MsgBox report, vbInformation, "ImportLatestVBA"
End Sub
