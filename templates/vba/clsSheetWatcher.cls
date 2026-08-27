VERSION 1.0 CLASS
BEGIN
 MultiUse = -1 'True
END
Attribute VB_Name = "clsSheetWatcher"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
Attribute VB_Description = "Prompt 7: dispatches Worksheet_Change/SelectionChange by sheet NAME (every summary and invoice sheet gets one instance, registered at runtime by ThisWorkbook.Workbook_Open, since SummaryWorkbookService.ts creates these sheets fresh for every batch - there is no template sheet pane to paste per-sheet code into)."
Public WithEvents Sheet As Worksheet

Private Sub Sheet_Change(ByVal Target As Range)
 If SyncEngine.gSyncInProgress Then Exit Sub
 Select Case Sheet.Name
 Case "Product Summary"
 Dim prows As Collection, pi As Long
 Set prows = SyncEngine.CollectDistinctRows(Target)
 For pi = 1 To prows.Count
 SyncEngine.HandleProductSummaryRowChange Sheet, Target, CLng(prows(pi))
 Next pi
 Case "Supplier Summary", "Customer Summary"
 Dim trows As Collection, ti As Long
 Set trows = SyncEngine.CollectDistinctRows(Target)
 For ti = 1 To trows.Count
 SyncEngine.HandlePartnerSummaryRowChange Sheet, Target, CLng(trows(ti))
 Next ti
 Case "Purchase Summary", "Sales Summary"
 ' Prompt 19: the two lifecycle-control trigger cells (row 2,
 ' col 1 / col 4) are now fired from Sheet_SelectionChange
 ' below instead - a real click, not an edit (see that Sub's
 ' own note for why). Anything else here is a product-block
 ' correction (Name/Qty/Rate), two-way synced with the
 ' matching invoice sheet (Prompt 18).
 If Target.Cells.Count = 1 And Target.Row = 2 And (Target.Column = 1 Or Target.Column = 4) Then
 ' Ignore - Sheet_SelectionChange already handled it (or
 ' will, for a paste that lands here without a prior
 ' selection event). Nothing to do on the Change event
 ' itself for these two cells.
 Else
 SyncEngine.HandleInvoiceListRowChange Sheet, Target
 End If
 Case Else
 SyncEngine.HandleInvoiceSheetChange Sheet, Target
 End Select
End Sub

Private Sub Sheet_SelectionChange(ByVal Target As Range)
 Select Case Sheet.Name
 Case "Purchase Summary", "Sales Summary"
 ' "+ ADD NEW INVOICE" is a styled cell, not a real Excel
 ' button control (nothing in this Node.js toolchain can
 ' create one) - clicking a plain cell only ever fires
 ' SelectionChange, never Change (Change needs the cell's
 ' VALUE to actually be edited, which a click alone never
 ' does). Firing straight from a click here is what actually
 ' makes it behave like a button; AddNewInvoice already gates
 ' its own real work behind an InputBox, so landing on the
 ' cell while just navigating around the sheet is harmless.
 ' Deletion is no longer a trigger cell - see
 ' SyncEngine.ReconcileDeletedInvoiceRows and
 ' HandleInvoiceSheetBeforeDelete instead.
 If Target.Cells.Count = 1 And Target.Row = 2 And Target.Column = 1 Then
 SyncEngine.AddNewInvoice
 End If
 Case "Product Summary", "Supplier Summary", "Customer Summary", "Batch Overview"
 ' No click-trigger cells on these sheets.
 Case Else
 ' Invoice sheets: "+ ADD NEW PRODUCT" trigger cell (row 3,
 ' col 9) - same click pattern as above. The "ADD PRODUCT"
 ' dropdown cell right above it (row 2, col 9) is a real Excel
 ' data-validation list, so picking from it is a Change event,
 ' handled in HandleInvoiceSheetChange instead.
 If Target.Cells.Count = 1 And Target.Row = 3 And Target.Column = 9 Then
 SyncEngine.AddNewProductToCurrentInvoice Sheet
 End If
 End Select
End Sub
