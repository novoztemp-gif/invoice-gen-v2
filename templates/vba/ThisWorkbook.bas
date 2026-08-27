Private mWatchers As Collection

Private Sub Workbook_Open()
 ActivateSync
End Sub

' Deleting an invoice is now just native Excel - delete its row in
' Purchase/Sales Summary, or delete its own sheet tab directly. This event
' catches the sheet-tab case immediately, before Excel finishes removing
' it, and hands off to SyncEngine to clean up the matching summary row +
' hidden data, then renumber. The row-deletion case is caught separately,
' the moment the summary sheet itself changes (see
' SyncEngine.ReconcileDeletedInvoiceRows, called from
' HandleInvoiceListRowChange).
Private Sub Workbook_SheetBeforeDelete(ByVal Sh As Object)
 SyncEngine.HandleInvoiceSheetBeforeDelete Sh.Name
End Sub

' Run this manually if the "+ ADD NEW INVOICE" button, deleting a row/
' sheet, or the two-way summary<->invoice sync don't respond right after
' opening a generated batch file: View menu (or Tools menu) -> Macros ->
' View Macros, select "ActivateSync", click Run. Some Excel builds don't
' reliably auto-fire Workbook_Open for workbooks assembled outside Excel
' itself (as every batch file this app generates is) - this reproduces
' exactly what Workbook_Open does, and only needs to be run once per time
' the file is opened; every button/sync click works normally afterwards,
' since the underlying event subscriptions work fine once created.
Public Sub ActivateSync()
 Dim ws As Worksheet
 Set mWatchers = New Collection
 For Each ws In Me.Worksheets
 ' _hidden_invoice_data is veryHidden and never user-edited -
 ' every other sheet (every summary sheet AND every invoice
 ' sheet) gets a watcher; clsSheetWatcher's own Sheet_Change
 ' dispatches by name to the right handler (Prompt 7 fix above).
 If ws.Name <> "_hidden_invoice_data" Then
 RegisterInvoiceSheetWatcher ws
 End If
 Next ws

 ' Once per file, not per-sheet - locks the derived Total Price/Total
 ' Amount columns on the two summary sheets against direct editing.
 ' Safe to call even on a file with neither sheet (SyncEngine's own
 ' error guard inside handles that).
 SyncEngine.LockDerivedTotalColumns
End Sub

' Also called by SyncEngine.AddNewInvoice right after it creates a
' brand-new invoice sheet at runtime - Workbook_Open only wires up the
' sheets that already existed when the file was opened, so a sheet
' created afterwards needs its own watcher registered explicitly, or its
' Worksheet_Change would never fire. (Name kept for compatibility with
' existing call sites; it registers a watcher for any sheet, not only
' invoice sheets, since Prompt 7's fix above.)
Public Sub RegisterInvoiceSheetWatcher(ws As Worksheet)
 If mWatchers Is Nothing Then Set mWatchers = New Collection
 Dim watcher As New clsSheetWatcher
 Set watcher.Sheet = ws
 mWatchers.Add watcher
 ' Applies to every sheet regardless of how it was built - the "ADD
 ' PRODUCT" dropdown + "+ ADD NEW PRODUCT" trigger this way work
 ' uniformly on both generated and manually-added invoices, with no
 ' separate implementation needed on the generator side.
 SyncEngine.EnsureAddProductControls ws
End Sub
