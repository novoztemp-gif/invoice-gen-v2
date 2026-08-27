Attribute VB_Name = "SyncEngine"
Option Explicit

' =============================================================================
' SyncEngine.bas - Excel-only two-way synchronization for the finalized-batch
' filing workbook (Prompt 4, revised by Prompt 4B, extended by Prompts 5-15).
'
' PROMPT 15 - INVOICE SHEET REBUILT AS A VERTICAL PRODUCT TABLE
' ------------------------------------------------------------
' The client's actual reference invoice (the file download-invoice/route.ts
' has always produced) is a single vertical product table - Sl. No. / Name
' of the Product / HSN/ACS / Qty in KG / Rate Per KG / Total Amount, padded
' to a fixed minimum number of rows - not the N-products-wide horizontal
' block layout Prompts 6-14 built. SummaryWorkbookService.ts's
' buildInvoiceSheet was rewritten to be a direct cell-for-cell port of that
' real generator, and every piece of this file that assumed "one product =
' one 4-column block, blockIdx*4+1 = its starting column" now instead
' means "one product = one ROW, INV_PRODUCT_DATA_ROW + blockIdx = its row"
' - WriteProductBlockDisplay, PropagateProductRename,
' PropagateQuantityRedistribution, PropagateAmountRedistribution,
' HandleInvoiceLineEdit, HandleInvoiceSheetChange, and BuildBlankInvoiceSheet
' were all updated accordingly. Total Amount (column 8) is now a live
' formula on every row from generation onward
' (=IF(AND(Qty<>"",Rate<>""),Qty*Rate,"")), so a brand-new product typed
' directly into any of the pre-formatted blank rows computes its own total
' immediately with no VBA involved - this made the old "ADD PRODUCT"
' trigger cell and its AddProductBlock column-insert workflow entirely
' unnecessary, and it has been removed. UpdateAmountInWords and the
' certification block ("For {name}", now one merged multi-line cell
' instead of three separate rows) were retargeted to the new fixed footer
' rows (see the constants block below, and invoiceFooterRows() in
' SummaryWorkbookService.ts, which this file's constants must stay
' numerically in sync with). Rows 1-13 (header banner, Delivery/Seller
' Details, Details of Receiver/Original for Recipient) are unchanged.
'
' PROMPT 11 - INVOICE SUMMARY COLUMN ARCHITECTURE REWORK
' ---------------------------------------------------------
' The client rejected the Invoice Summary layout Prompts 9/10 shipped:
' Invoice Amount/Transport Mode/Vehicle Number/hidden Invoice ID/Partner ID
' sat between Supplier and the product blocks. The required layout puts the
' product blocks IMMEDIATELY after Supplier/Customer (column 4), with
' Invoice Amount/Transport Mode/Vehicle Number/Invoice ID/Partner ID moved
' to AFTER the last product block instead - a position that now shifts
' with the batch's widest invoice. This made every one of the old
' PS_COL_INVOICE_ID(8)/PS_COL_PARTNER_ID(9)/hardcoded-literal-5/6/7
' assumptions obsolete. Replaced with FindColumnByHeader - a generic
' header-text column finder (the same idea as the existing
' FindInvoiceAmountColumn, generalized) - so every one of those fields is
' now located at runtime by matching its header text in PS_HEADER_ROW,
' never a fixed column number. Only columns 1-4 (Invoice Number/Invoice
' Date/Date of Supply/Supplier or Customer) remain fixed. Also switched
' Invoice Amount's formula (both the generator's and AppendInvoiceListRow's
' own) to a same-row SUMIF over that row's own "Total Price" block cells,
' matching SummaryWorkbookService.ts's Prompt 10 fix - this also made
' RenumberAllInvoices's old cross-sheet-name formula rewrite unnecessary
' (the formula no longer references an invoice sheet by name at all), so
' that loop was removed. AppendPartnerSummaryRow also switched to
' whole-column COUNTIF/SUMIF ranges (Prompt 9's TS-side fix, now mirrored
' here) since the columns it references aren't fixed letters any more
' either.
'
' PROMPT 7 - VBA ACTIVATION FIX
' -------------------------------
' Attempting real embedding surfaced a genuine, previously-undetected wiring
' bug: Prompts 4B/5/6 assumed Worksheet_Change code could be pasted directly
' into each summary sheet's own code pane inside the TEMPLATE. But this
' template's Product/Supplier/Customer/Purchase/Sales Summary sheets don't
' exist in templates/BLANK EXCEL.xlsm at all - SummaryWorkbookService.ts
' creates them fresh, from scratch, for every batch. There was never a sheet
' to paste that code into. Fixed by moving ALL summary-sheet dispatch logic
' into clsSheetWatcher itself (keyed off Sheet.Name), and having
' ThisWorkbook.Workbook_Open register a watcher for every sheet - summary or
' invoice alike - instead of skipping summary sheets. See the "MODULE:
' clsSheetWatcher" and "MODULE: ThisWorkbook" sections below for the exact
' change; the old separate "MODULE: SummarySheetHandlers" paste-in section is
' gone because it's no longer needed.
'
' PROMPT 5 ADDITIONS
' --------------------
' Invoice Summary becomes the invoice lifecycle control point (section 9):
' a "+ ADD NEW INVOICE" trigger cell creates a brand-new, zero-product
' invoice sheet (AddNewInvoice/BuildBlankInvoiceSheet), and a "DELETE
' SELECTED INVOICE" trigger (DeleteSelectedInvoice/DeleteInvoiceByStableId)
' removes one, always followed by RenumberAllInvoices - a gap-free 1..N
' renumbering of every remaining invoice's display Invoice Number and
' sheet name (via a two-phase temp-name rename, so no intermediate
' collision is possible), while the stable Invoice ID never changes
' (section 12). Discovering this also surfaced a real, previously-dormant
' bug: a zero-product invoice's Invoice Amount used to sit at column 1,
' which a first "Add Product" column-insert would then use as ITS
' insertion point too - corrupting the fixed columns 1-4 used by rows 5-8.
' Fixed in SummaryWorkbookService.ts (Invoice Amount now reserved at
' column 5 minimum) and in AddProductBlock (locates the column by
' scanning for the "Invoice Amount" header text, not by ProductCount*4+1).
'
' PROMPT 4B CHANGES FROM PROMPT 4
' --------------------------------
' Prompt 4's architecture stored the normalized per-invoice-line data in
' hidden ROWS directly below each invoice sheet's own visible area (rows
' 12+). That was discovered to be unsafe: adding a new product block to an
' invoice requires inserting 4 new columns, and a full-column insert shifts
' EVERY row on that sheet uniformly - corrupting the fixed-column hidden
' rows sitting below the visible area on the very same sheet.
'
' Prompt 4B's fix: ALL normalized line-item data now lives on ONE dedicated,
' very-hidden worksheet, "_hidden_invoice_data" (built by
' SummaryWorkbookService.ts -> buildHiddenInvoiceDataSheet), with columns:
' BatchID | InvoiceID | InvoiceNumber | ProductID | ProductName | HSN |
' Category | Qty | Rate | Amount | PartnerID | PartnerName | SheetName |
' BlockIndex
' This sheet only ever grows vertically (one row appended per new product
' line), so it is completely unaffected by any invoice sheet's column
' layout changing - including from "Add Product" itself. It is the ONE
' normalized source of truth; Product Summary's own per-product rows keep
' only a Product ID pointer (identity, not a second copy of the line data),
' exactly like Purchase/Sales Summary's Invoice ID / Partner ID pointers.
'
' Prompt 4B also REMOVES the Prompt 4 restriction "Target.Cells.Count > 1 ->
' Exit Sub". Every entry point below now inspects the complete edited
' range, groups it into the distinct affected records (row on a summary
' sheet, or product block on an invoice sheet), and processes each
' distinct record exactly once, using its final (already-pasted) value.
'
' WHAT THIS FILE IS / WHY IT ISN'T COMPILED IN YET
' --------------------------------------------------
' Same as Prompt 4: this is real, hand-written VBA, mirroring the tested
' TypeScript specification at src/lib/services/WorkbookSyncEngine.ts, but it
' cannot be compiled into templates/BLANK EXCEL.xlsm from this Node.js
' toolchain (no pure-JS library can produce a vbaProject.bin). Per Prompt
' 4B's own explicit instruction, that one-time manual compilation step is
' deliberately NOT done in this prompt - see the import instructions at the
' end of this comment block, to be followed only after this architecture is
' confirmed final.
'
' ONE-TIME MANUAL SETUP (Prompt 20 - every update after this is automatic):
' 1. Open templates/BLANK EXCEL.xlsm in Excel. Alt+F11.
' 2. Enable "Trust access to the VBA project object model" (Excel >
' Preferences > Security > Macro Security... on Mac) - required for
' step 4 below to be able to touch the project at all.
' 3. Insert -> Module, name it exactly "ImportLatestVBA", paste the
' contents of templates/vba/ImportLatestVBA.bas. This is the ONLY
' manual paste ever needed - it already knows how to load
' SyncEngine/clsSheetWatcher/ThisWorkbook itself, including the very
' first time (VBComponents.Remove on a component that doesn't exist
' yet is harmlessly swallowed, same as every other "()Set ws =
' Nothing; On Error Resume Next" pattern already used throughout
' SyncEngine.bas).
' 4. Run ImportLatestVBA once (Run -> Run Sub, or F5 with the cursor
' inside it). It reloads all three of SyncEngine/clsSheetWatcher/
' ThisWorkbook straight from the files on disk and reports success/
' failure per component in a message box.
' 5. Save as .xlsm, close the file completely, then reopen it (Workbook_
' Open is what actually registers every sheet's event watcher - 
' redefining a class module's code while old instances are still
' alive mid-session isn't something VBA guarantees works correctly).
' Replace templates/BLANK EXCEL.xlsm.
' 6. Every future update: Claude rewrites the changed file(s) on disk,
' then runs `osascript -e 'tell application "Microsoft Excel" to run
' VB macro "ImportLatestVBA"'` - confirmed reliable for running an
' EXISTING macro (unlike injecting new VBA source, which has no
' scriptable path at all). Still close/reopen after, per step 5.
'
' (Prompt 7: clsSheetWatcher/ThisWorkbook together are the only wiring
' needed - every sheet, summary or invoice, gets its watcher registered
' dynamically at runtime by Workbook_Open/RegisterInvoiceSheetWatcher, and
' clsSheetWatcher's own Sheet_Change dispatches by sheet name. No per-sheet
' code panes to paste into anywhere, which matters because this template's
' summary sheets don't exist yet - SummaryWorkbookService.ts creates them
' fresh for every batch, so there is no sheet here to paste into.)
'
' NO EXTERNAL CALLS (Prompt 4 section 1, reaffirmed by Prompt 4B section 22)
' -----------------------------------------------------------------------
' Every Sub only reads/writes cells on ThisWorkbook's own worksheets. No
' shell/process execution, no MSXML2 or WinHttp object creation, no URL
' download call, no reference to Supabase or any other network/database
' API anywhere in this file - verified by an automated test
' (WorkbookSyncEngine.test.ts) that scans this exact file's text.
' =============================================================================


' =========================== MODULE: SyncEngine =============================
' (everything from here to the "MODULE: clsSheetWatcher" marker goes into a
' new standard module named exactly "SyncEngine")

' --- Re-entrancy guard (section 15: no recursive sync loops) ---------------
Public gSyncInProgress As Boolean

' --- Sheet name constants ---------------------------------------------------
Private Const SHEET_PURCHASE_SUMMARY As String = "Purchase Summary"
Private Const SHEET_SALES_SUMMARY As String = "Sales Summary"
Private Const SHEET_SUPPLIER_SUMMARY As String = "Supplier Summary"
Private Const SHEET_CUSTOMER_SUMMARY As String = "Customer Summary"
Private Const SHEET_PRODUCT_SUMMARY As String = "Product Summary"
Private Const SHEET_HIDDEN_DATA As String = "_hidden_invoice_data"

' --- Purchase/Sales Summary column layout - header row 3, data from row 4.
' PROMPT 11: columns 1-4 (Invoice Number/Invoice Date/Date of Supply/
' Supplier or Customer) are the ONLY fixed visible columns now. The client
' rejected the previous layout (Invoice Amount/Transport/Vehicle/hidden IDs
' sitting between Supplier and the product blocks) - the product blocks
' now come immediately after column 4, and Invoice Amount/Transport Mode/
' Vehicle Number/Invoice ID/Partner ID all move right together as the
' batch's widest invoice grows or shrinks. Every one of those is now
' located at runtime by matching its header text in PS_HEADER_ROW - see
' FindColumnByHeader below - never by a hardcoded column number.
Private Const PS_COL_PARTNER_NAME As Long = 4
Private Const PS_HEADER_ROW As Long = 3
Private Const PS_DATA_START_ROW As Long = 4
' Prompt 18: where each row's first 4-column product block starts - 
' mirrors SUMMARY_PRODUCT_BLOCK_START_COL in SummaryWorkbookService.ts.
Private Const PS_PRODUCT_BLOCK_START_COL As Long = 5

' --- Supplier/Customer Summary column layout --------------------------------
Private Const PT_COL_NAME As Long = 1
Private Const PT_COL_PARTNER_ID As Long = 4
Private Const PT_DATA_START_ROW As Long = 4

' --- Product Summary column layout ------------------------------------------
' (Prompt 4B: no longer holds a copy of the line-item data - just a Product
' ID pointer, exactly like Purchase Summary's Invoice ID / Partner ID.)
Private Const PR_COL_NAME As Long = 1
Private Const PR_COL_HSN As Long = 2
Private Const PR_COL_QTY As Long = 3
Private Const PR_COL_AMOUNT As Long = 4
Private Const PR_COL_PRODUCT_ID As Long = 5
Private Const PR_DATA_START_ROW As Long = 4

' --- _hidden_invoice_data column layout (Prompt 4B, section 16) ------------
Private Const HID_COL_BATCH_ID As Long = 1
Private Const HID_COL_INVOICE_ID As Long = 2
Private Const HID_COL_INVOICE_NUMBER As Long = 3
Private Const HID_COL_PRODUCT_ID As Long = 4
Private Const HID_COL_PRODUCT_NAME As Long = 5
Private Const HID_COL_HSN As Long = 6
Private Const HID_COL_CATEGORY As Long = 7
Private Const HID_COL_QTY As Long = 8
Private Const HID_COL_RATE As Long = 9
Private Const HID_COL_AMOUNT As Long = 10
Private Const HID_COL_PARTNER_ID As Long = 11
Private Const HID_COL_PARTNER_NAME As Long = 12
Private Const HID_COL_SHEET_NAME As Long = 13
Private Const HID_COL_BLOCK_INDEX As Long = 14
Private Const HID_DATA_START_ROW As Long = 2

' --- Invoice sheet row layout (buildInvoiceSheet) ---------------------------
' PROMPT 15: the invoice sheet is now a direct port of the reference
' invoice's own vertical product table (Sl.No/Name/HSN/Qty/Rate/Total),
' padded to MIN_PRODUCT_ROWS_VBA blank editable rows, rather than the old
' N-products-wide horizontal block layout - matching
' SummaryWorkbookService.ts's Prompt 15 rewrite (invoiceFooterRows) exactly.
' Rows 1-13 (header banner, Delivery/Seller Details, Details of Receiver/
' Original for Recipient) are unchanged from Prompt 13. Every row from the
' product table's "Total" line downward is now MIN_PRODUCT_ROWS_VBA rows
' below INV_PRODUCT_DATA_ROW for any invoice with 16 or fewer products - 
' the overwhelming common case, and the one this whole module (like the TS
' generator) assumes. An invoice with MORE than 16 products would need
' these found dynamically instead; that's a known, documented limitation
' shared with SummaryWorkbookService.ts's own MIN_PRODUCT_ROWS default.
Private Const INV_PARTNER_ROW As Long = 9
Private Const INV_PARTNER_VALUE_COL As Long = 3
Private Const INV_PRODUCT_HEADER_ROW As Long = 14
Private Const INV_PRODUCT_DATA_ROW As Long = 16
Private Const MIN_PRODUCT_ROWS_VBA As Long = 16
' Row 9 = "Name"/"Invoice No" label/value pair (paired with the receiver's
' Name field - addReferenceStyleRow(sheet, 9, ["Name",...], ["Invoice No",...])).
Private Const INV_INVOICE_NUMBER_ROW As Long = 9
Private Const INV_INVOICE_NUMBER_VALUE_COL As Long = 7

' --- Prompt 15: fixed footer rows shared by Sales and Purchase invoice
' sheets, derived the same way invoiceFooterRows() derives them in
' SummaryWorkbookService.ts (INV_PRODUCT_DATA_ROW + MIN_PRODUCT_ROWS_VBA,
' then +1 for each row after that) - kept as literal constants here since
' VBA has no equivalent of calling that function at compile time, but the
' arithmetic must stay numerically identical to it.
Private Const TOTAL_ROW_VBA As Long = 32 ' INV_PRODUCT_DATA_ROW + MIN_PRODUCT_ROWS_VBA
Private Const GOODS_DISPATCHED_ROW_VBA As Long = 33 ' TOTAL_ROW_VBA + 1
Private Const AMOUNT_IN_WORDS_ROW As Long = 34 ' TOTAL_ROW_VBA + 2
Private Const BANK_DETAILS_HEADER_ROW_VBA As Long = 36 ' TOTAL_ROW_VBA + 4
Private Const BANK_DETAILS_NAME_OF_ACCOUNT_ROW As Long = 37 ' TOTAL_ROW_VBA + 5
Private Const BANK_DETAILS_IFSC_ROW As Long = 41 ' TOTAL_ROW_VBA + 9
Private Const CERTIFICATION_TERMS_ROW_VBA As Long = 43 ' TOTAL_ROW_VBA + 11
Private Const BATCH_OVERVIEW_SHEET_NAME_VBA As String = "Batch Overview"

' --- Purchase/Sales Summary lifecycle-control trigger cells (Prompt 5) -----
Private Const ADD_INVOICE_ROW As Long = 2
Private Const ADD_INVOICE_COL As Long = 1
Private Const ADD_INVOICE_LABEL As String = "+ ADD NEW INVOICE"
Private Const DELETE_INVOICE_ROW As Long = 2
Private Const DELETE_INVOICE_COL As Long = 4
Private Const DELETE_INVOICE_LABEL As String = "DELETE SELECTED INVOICE"

' Tracks the last invoice-data row the user had selected on Purchase/Sales
' Summary BEFORE clicking into the DELETE trigger cell - Excel moves the
' ActiveCell to whatever cell you start editing, so by the time
' Worksheet_Change fires for the trigger itself, the row the user actually
' meant to delete is only recoverable if something already remembered it.
' Populated by Worksheet_SelectionChange (see MODULE: InvoiceListSheetHandlers).
Public gLastSelectedInvoiceRow As Long

' --- Add Product dropdown trigger cells (see EnsureAddProductControls) -----
Private Const ADD_PRODUCT_TRIGGER_ROW As Long = 2
Private Const ADD_PRODUCT_TRIGGER_COL As Long = 9
Private Const ADD_NEW_PRODUCT_TRIGGER_ROW As Long = 3
Private Const ADD_NEW_PRODUCT_TRIGGER_COL As Long = 9
Private Const ADD_PRODUCT_PLACEHOLDER As String = "ADD PRODUCT (pick existing)"
Private Const ADD_NEW_PRODUCT_LABEL As String = "+ ADD NEW PRODUCT"


' --------------------------- generic dedupe helper --------------------------

' Adds `key` to `coll` only if not already present - the standard VBA
' dedupe idiom (a duplicate Collection key raises error 457, suppressed).
Private Sub AddUnique(coll As Collection, key As String)
 On Error Resume Next
 coll.Add key, key
 On Error GoTo 0
End Sub

' Returns the distinct row numbers (as strings) touched by Target, across
' every non-contiguous area of a multi-cell paste/fill (section 11/21).
Public Function CollectDistinctRows(Target As Range) As Collection
 Dim result As New Collection
 Dim area As Range, r As Range
 For Each area In Target.Areas
 For Each r In area.Rows
 AddUnique result, CStr(r.Row)
 Next r
 Next area
 Set CollectDistinctRows = result
End Function


' --------------------------- sheet lookups ----------------------------------

Private Function IsSummarySheet(ws As Worksheet) As Boolean
 Select Case ws.Name
 Case SHEET_PURCHASE_SUMMARY, SHEET_SALES_SUMMARY, SHEET_SUPPLIER_SUMMARY, _
 SHEET_CUSTOMER_SUMMARY, SHEET_PRODUCT_SUMMARY, SHEET_HIDDEN_DATA, _
 BATCH_OVERVIEW_SHEET_NAME_VBA
 IsSummarySheet = True
 Case Else
 IsSummarySheet = False
 End Select
End Function

Private Function InvoiceListSheet() As Worksheet
 On Error Resume Next
 Set InvoiceListSheet = ThisWorkbook.Worksheets(SHEET_PURCHASE_SUMMARY)
 If InvoiceListSheet Is Nothing Then Set InvoiceListSheet = ThisWorkbook.Worksheets(SHEET_SALES_SUMMARY)
 On Error GoTo 0
End Function

Private Function PartnerSummarySheet() As Worksheet
 On Error Resume Next
 Set PartnerSummarySheet = ThisWorkbook.Worksheets(SHEET_SUPPLIER_SUMMARY)
 If PartnerSummarySheet Is Nothing Then Set PartnerSummarySheet = ThisWorkbook.Worksheets(SHEET_CUSTOMER_SUMMARY)
 On Error GoTo 0
End Function

Private Function ProductSummarySheet() As Worksheet
 Set ProductSummarySheet = ThisWorkbook.Worksheets(SHEET_PRODUCT_SUMMARY)
End Function

Private Function HiddenDataSheet() As Worksheet
 Set HiddenDataSheet = ThisWorkbook.Worksheets(SHEET_HIDDEN_DATA)
End Function


' --------------------------- invoice-sheet helpers --------------------------

' Prompt 15: the product table is always padded to MIN_PRODUCT_ROWS_VBA rows
' (see the constants block above), so this is fixed arithmetic now rather
' than something that has to be scanned for - replaces the old
' InvoiceProductCount/FindInvoiceAmountColumn pair, which located a
' per-product COLUMN block; products are rows now, not columns.
Private Function LastProductRowVba() As Long
 LastProductRowVba = INV_PRODUCT_DATA_ROW + MIN_PRODUCT_ROWS_VBA - 1
End Function


' --------------------- Purchase/Sales Summary dynamic columns (Prompt 11) ---

' Generic header-text column finder - the same idea as FindInvoiceAmountColumn
' above, generalized to any header string on any header row. Replaces the
' old fixed PS_COL_INVOICE_ID / PS_COL_PARTNER_ID / hardcoded literal
' columns 5/6/7 that AppendInvoiceListRow used to write Invoice Amount/
' Transport Mode/Vehicle Number to - all obsolete now that the product
' blocks sit between Supplier and those fields instead of after them.
Public Function FindColumnByHeader(ws As Worksheet, headerRow As Long, headerText As String) As Long
 ' Deliberately NOT using .End(xlToLeft) to find the last column: on at
 ' least one real Mac Excel build it skips right over the hidden
 ' Invoice ID / Partner ID columns despite them holding real values,
 ' silently returning a too-small lastCol and making every lookup past
 ' that point return 0 - which is exactly what broke every button and
 ' every two-way sync depending on this function. A generous fixed
 ' upper bound sidesteps that unreliable detection entirely; scanning
 ' 300 columns is trivial cost and comfortably covers even a very large
 ' number of product blocks plus the handful of fixed tail columns.
 Dim lastCol As Long, c As Long
 lastCol = 300
 For c = 1 To lastCol
 If CStr(ws.Cells(headerRow, c).Value) = headerText Then
 FindColumnByHeader = c
 Exit Function
 End If
 Next c
 FindColumnByHeader = 0
End Function

Private Function PartnerIdHeaderText(listWs As Worksheet) As String
 If listWs.Name = SHEET_SALES_SUMMARY Then
 PartnerIdHeaderText = "Customer ID"
 Else
 PartnerIdHeaderText = "Supplier ID"
 End If
End Function

Private Function InvoiceIdColumn(listWs As Worksheet) As Long
 InvoiceIdColumn = FindColumnByHeader(listWs, PS_HEADER_ROW, "Invoice ID")
End Function

Private Function PartnerIdColumn(listWs As Worksheet) As Long
 PartnerIdColumn = FindColumnByHeader(listWs, PS_HEADER_ROW, PartnerIdHeaderText(listWs))
End Function

Private Function InvoiceAmountColumnOnSummary(listWs As Worksheet) As Long
 InvoiceAmountColumnOnSummary = FindColumnByHeader(listWs, PS_HEADER_ROW, "Invoice Amount")
End Function

Private Function TransportModeColumn(listWs As Worksheet) As Long
 TransportModeColumn = FindColumnByHeader(listWs, PS_HEADER_ROW, "Transport Mode")
End Function

Private Function VehicleNumberColumn(listWs As Worksheet) As Long
 VehicleNumberColumn = FindColumnByHeader(listWs, PS_HEADER_ROW, "Vehicle Number")
End Function

' Column number -> letter (1 -> "A", 27 -> "AA") - mirrors colLetter() in
' SummaryWorkbookService.ts exactly, needed now that formula range strings
' (e.g. the Invoice Amount TOTAL row's SUM) reference a column that moves
' with the batch's widest invoice instead of a fixed letter.
Public Function ColLetter(colNum As Long) As String
 Dim n As Long, letters As String, remainderVal As Long
 n = colNum
 Do While n > 0
 remainderVal = (n - 1) Mod 26
 letters = Chr(65 + remainderVal) & letters
 n = (n - 1) \ 26
 Loop
 ColLetter = letters
End Function

' A row appended to Purchase/Sales Summary at runtime (AppendInvoiceListRow)
' only gets its fixed identity/tail columns filled in - its product-block
' columns are blank cells with no formula at all, since a brand-new
' invoice starts with zero products. Every place that writes a product's
' Qty/Rate into a summary row's block (below) calls this first so the
' block's own Total Price cell always has its live Qty*Rate formula,
' regardless of whether that row was there from generation (where the
' formula already exists - this is a harmless no-op re-write) or appended
' at runtime (where it's the only thing that ever sets it up).
Private Sub EnsureSummaryTotalPriceFormula(listWs As Worksheet, listRow As Long, blockBase As Long)
 listWs.Cells(listRow, blockBase + 3).Formula = _
 "=" & ColLetter(blockBase + 1) & listRow & "*" & ColLetter(blockBase + 2) & listRow
End Sub


' --------------------------- _hidden_invoice_data helpers -------------------

Private Function HiddenDataLastRow() As Long
 Dim ws As Worksheet, r As Long
 Set ws = HiddenDataSheet()
 r = HID_DATA_START_ROW
 Do While ws.Cells(r, HID_COL_INVOICE_ID).Value <> ""
 r = r + 1
 Loop
 HiddenDataLastRow = r - 1
End Function

Private Function FindHiddenRowBySheetAndBlock(sheetName As String, blockIdx As Long) As Long
 Dim ws As Worksheet, r As Long, lastRow As Long
 Set ws = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(ws.Cells(r, HID_COL_SHEET_NAME).Value) = sheetName And _
 CLng(ws.Cells(r, HID_COL_BLOCK_INDEX).Value) = blockIdx Then
 FindHiddenRowBySheetAndBlock = r
 Exit Function
 End If
 Next r
 FindHiddenRowBySheetAndBlock = 0
End Function

' Prompt 18: same lookup, keyed by Invoice ID instead of sheet name - used
' when the edit originates on Purchase/Sales Summary, which knows the
' invoice's stable ID (its own hidden column) but not its sheet name.
Private Function FindHiddenRowByInvoiceAndBlock(invoiceId As String, blockIdx As Long) As Long
 Dim ws As Worksheet, r As Long, lastRow As Long
 Set ws = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(ws.Cells(r, HID_COL_INVOICE_ID).Value) = invoiceId And _
 CLng(ws.Cells(r, HID_COL_BLOCK_INDEX).Value) = blockIdx Then
 FindHiddenRowByInvoiceAndBlock = r
 Exit Function
 End If
 Next r
 FindHiddenRowByInvoiceAndBlock = 0
End Function

Private Function FindHiddenRowsByProduct(productId As String) As Collection
 Dim ws As Worksheet, r As Long, lastRow As Long
 Dim result As New Collection
 Set ws = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(ws.Cells(r, HID_COL_PRODUCT_ID).Value) = productId Then result.Add r
 Next r
 Set FindHiddenRowsByProduct = result
End Function

' Any row belonging to `sheetName` carries that invoice's own identity
' fields (they're the same on every line of one invoice) - used both to
' resolve an invoice sheet's own IDs and, via the zero-product sentinel row
' SummaryWorkbookService.ts always writes, to work even for an invoice with
' no product lines at all.
Private Sub GetSheetIdentity(ws As Worksheet, ByRef batchId As String, ByRef invoiceId As String, _
 ByRef invNum As String, ByRef partnerId As String, ByRef partnerName As String)
 Dim hws As Worksheet, r As Long, lastRow As Long
 Set hws = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(hws.Cells(r, HID_COL_SHEET_NAME).Value) = ws.Name Then
 batchId = CStr(hws.Cells(r, HID_COL_BATCH_ID).Value)
 invoiceId = CStr(hws.Cells(r, HID_COL_INVOICE_ID).Value)
 invNum = CStr(hws.Cells(r, HID_COL_INVOICE_NUMBER).Value)
 partnerId = CStr(hws.Cells(r, HID_COL_PARTNER_ID).Value)
 partnerName = CStr(hws.Cells(r, HID_COL_PARTNER_NAME).Value)
 Exit Sub
 End If
 Next r
End Sub

Private Sub AppendHiddenDataRow(batchId As String, invoiceId As String, invNum As String, _
 productId As String, prodName As String, hsn As String, category As String, _
 qty As Double, rate As Double, amount As Double, _
 partnerId As String, partnerName As String, sheetName As String, blockIdx As Long)
 Dim ws As Worksheet, r As Long
 Set ws = HiddenDataSheet()
 r = HiddenDataLastRow() + 1
 ws.Cells(r, HID_COL_BATCH_ID).Value = batchId
 ws.Cells(r, HID_COL_INVOICE_ID).Value = invoiceId
 ws.Cells(r, HID_COL_INVOICE_NUMBER).Value = invNum
 ws.Cells(r, HID_COL_PRODUCT_ID).Value = productId
 ws.Cells(r, HID_COL_PRODUCT_NAME).Value = prodName
 ws.Cells(r, HID_COL_HSN).Value = hsn
 ws.Cells(r, HID_COL_CATEGORY).Value = category
 ws.Cells(r, HID_COL_QTY).Value = qty
 ws.Cells(r, HID_COL_RATE).Value = rate
 ws.Cells(r, HID_COL_AMOUNT).Value = amount
 ws.Cells(r, HID_COL_PARTNER_ID).Value = partnerId
 ws.Cells(r, HID_COL_PARTNER_NAME).Value = partnerName
 ws.Cells(r, HID_COL_SHEET_NAME).Value = sheetName
 ws.Cells(r, HID_COL_BLOCK_INDEX).Value = blockIdx
End Sub


' --------------------------- Product Summary helpers -------------------------

Private Function ProductSummaryRowCount() As Long
 Dim ws As Worksheet, r As Long
 Set ws = ProductSummarySheet()
 r = PR_DATA_START_ROW
 Do While ws.Cells(r, PR_COL_NAME).Value <> "" And ws.Cells(r, PR_COL_NAME).Value <> "TOTAL"
 r = r + 1
 Loop
 ProductSummaryRowCount = r - PR_DATA_START_ROW
End Function

Private Function FindProductSummaryRow(productId As String) As Long
 Dim ws As Worksheet, r As Long, n As Long
 Set ws = ProductSummarySheet()
 n = ProductSummaryRowCount()
 For r = PR_DATA_START_ROW To PR_DATA_START_ROW + n - 1
 If CStr(ws.Cells(r, PR_COL_PRODUCT_ID).Value) = productId Then
 FindProductSummaryRow = r
 Exit Function
 End If
 Next r
 FindProductSummaryRow = 0
End Function

Private Function FindProductSummaryRowByName(name As String) As Long
 Dim ws As Worksheet, r As Long, n As Long
 Set ws = ProductSummarySheet()
 n = ProductSummaryRowCount()
 For r = PR_DATA_START_ROW To PR_DATA_START_ROW + n - 1
 If LCase(Trim(CStr(ws.Cells(r, PR_COL_NAME).Value))) = LCase(Trim(name)) Then
 FindProductSummaryRowByName = r
 Exit Function
 End If
 Next r
 FindProductSummaryRowByName = 0
End Function

' Totals are whole-column SUMIF against _hidden_invoice_data (section 6) - 
' never a bounded range - so they never go stale as that sheet grows, and
' never need rewriting when OTHER products' rows are added/removed.
Private Sub WriteProductSummaryFormulas(r As Long)
 Dim ws As Worksheet
 Set ws = ProductSummarySheet()
 ws.Cells(r, PR_COL_QTY).Formula = _
 "=SUMIF(" & SHEET_HIDDEN_DATA & "!$D:$D,E" & r & "," & SHEET_HIDDEN_DATA & "!$H:$H)"
 ws.Cells(r, PR_COL_AMOUNT).Formula = _
 "=SUMIF(" & SHEET_HIDDEN_DATA & "!$D:$D,E" & r & "," & SHEET_HIDDEN_DATA & "!$J:$J)"
End Sub

' Inserts a brand-new product row just above the TOTAL row (section 8:
' "If it is genuinely new: create a new Product Summary row"), shifting the
' TOTAL row down by one and rewriting its SUM range to include the new row
' explicitly - deliberately not relying on Excel's insert-at-boundary
' auto-extend behavior, which is unreliable exactly at this boundary.
Private Function AppendProductSummaryRow(productId As String, name As String, hsn As String) As Long
 Dim ws As Worksheet, n As Long, newRow As Long, totalRow As Long
 Set ws = ProductSummarySheet()
 n = ProductSummaryRowCount()
 newRow = PR_DATA_START_ROW + n

 ws.Rows(newRow).Insert Shift:=xlDown, CopyOrigin:=xlFormatFromLeftOrAbove
 ws.Cells(newRow, PR_COL_NAME).Value = name
 ws.Cells(newRow, PR_COL_HSN).Value = hsn
 ws.Cells(newRow, PR_COL_PRODUCT_ID).Value = productId
 WriteProductSummaryFormulas newRow

 totalRow = newRow + 1
 ws.Cells(totalRow, PR_COL_QTY).Formula = "=SUM(C" & PR_DATA_START_ROW & ":C" & newRow & ")"
 ws.Cells(totalRow, PR_COL_AMOUNT).Formula = "=SUM(D" & PR_DATA_START_ROW & ":D" & newRow & ")"

 AppendProductSummaryRow = newRow
End Function


' --------------------------- redistribution math -----------------------------

' Deterministic largest-remainder proportional redistribution - a faithful
' VBA port of redistributeProportionally() in WorkbookSyncEngine.ts: 2-decimal
' precision, ascending-index tie-break, never negative, always sums exactly
' to newTotal. `weights` is 0-based; the returned array is too.
Private Function RedistributeProportionally(weights() As Double, newTotal As Double) As Double()
 Const PRECISION As Long = 100
 Dim n As Long, i As Long
 n = UBound(weights) - LBound(weights) + 1

 Dim result() As Double
 ReDim result(0 To n - 1)
 If n = 0 Then
 RedistributeProportionally = result
 Exit Function
 End If

 Dim safeTotal As Double
 safeTotal = newTotal
 If safeTotal < 0 Then safeTotal = 0
 Dim targetUnits As Long
 targetUnits = CLng(Application.WorksheetFunction.Round(safeTotal * PRECISION, 0))

 Dim weightSum As Double
 weightSum = 0
 For i = 0 To n - 1
 If weights(i) > 0 Then weightSum = weightSum + weights(i)
 Next i

 Dim shares() As Long, fracs() As Double
 ReDim shares(0 To n - 1)
 ReDim fracs(0 To n - 1)
 Dim used As Long
 used = 0

 If weightSum > 0 Then
 Dim raw As Double, w As Double
 For i = 0 To n - 1
 w = weights(i)
 If w < 0 Then w = 0
 raw = (w / weightSum) * targetUnits
 shares(i) = Int(raw)
 fracs(i) = raw - shares(i)
 used = used + shares(i)
 Next i
 Else
 Dim base As Long
 base = targetUnits \ n
 For i = 0 To n - 1
 shares(i) = base
 fracs(i) = 0
 Next i
 used = base * n
 End If

 Dim remaining As Long
 remaining = targetUnits - used

 Dim order() As Long
 ReDim order(0 To n - 1)
 For i = 0 To n - 1
 order(i) = i
 Next i
 Dim j As Long, tmp As Long
 For i = 1 To n - 1
 j = i
 Do While j > 0
 If (fracs(order(j)) > fracs(order(j - 1))) Or _
 (fracs(order(j)) = fracs(order(j - 1)) And order(j) < order(j - 1)) Then
 tmp = order(j): order(j) = order(j - 1): order(j - 1) = tmp
 j = j - 1
 Else
 Exit Do
 End If
 Loop
 Next i

 Dim k As Long
 k = 0
 Do While remaining > 0 And k < n
 shares(order(k)) = shares(order(k)) + 1
 remaining = remaining - 1
 k = k + 1
 Loop
 Dim idx As Long
 idx = 0
 Do While remaining > 0
 shares(idx Mod n) = shares(idx Mod n) + 1
 remaining = remaining - 1
 idx = idx + 1
 Loop

 For i = 0 To n - 1
 result(i) = shares(i) / PRECISION
 Next i
 RedistributeProportionally = result
End Function


' --------------------------- Prompt 6: amount in words -------------------------
' A faithful VBA port of src/lib/numberToWords.ts - the SAME algorithm
' already used by the real app export (PdfExportService.ts), not a
' reimplementation with different wording (Prompt 6, section 4: "Do not
' invent a different wording style"). Indian numbering system
' (Thousand/Lakh/Crore), "and" before sub-hundreds, title-cased, "Only"
' suffix - exactly as the TS source produces.

Private Function ConvertNumberToWordsVba(n As Long) As String
 Dim a(0 To 19) As String
 a(0) = "": a(1) = "One ": a(2) = "Two ": a(3) = "Three ": a(4) = "Four "
 a(5) = "Five ": a(6) = "Six ": a(7) = "Seven ": a(8) = "Eight ": a(9) = "Nine "
 a(10) = "Ten ": a(11) = "Eleven ": a(12) = "Twelve ": a(13) = "Thirteen "
 a(14) = "Fourteen ": a(15) = "Fifteen ": a(16) = "Sixteen ": a(17) = "Seventeen "
 a(18) = "Eighteen ": a(19) = "Nineteen "
 Dim b(0 To 9) As String
 b(0) = "": b(1) = "": b(2) = "Twenty": b(3) = "Thirty": b(4) = "Forty"
 b(5) = "Fifty": b(6) = "Sixty": b(7) = "Seventy": b(8) = "Eighty": b(9) = "Ninety"

 If n < 20 Then
 ConvertNumberToWordsVba = a(n)
 Exit Function
 End If
 Dim digit As Long
 digit = n Mod 10
 If n < 100 Then
 ConvertNumberToWordsVba = b(n \ 10) & IIf(digit <> 0, " " & a(digit), "")
 Exit Function
 End If
 If n < 1000 Then
 ConvertNumberToWordsVba = a(n \ 100) & "Hundred " & IIf(n Mod 100 = 0, "", "and " & ConvertNumberToWordsVba(n Mod 100))
 Exit Function
 End If
 If n < 100000 Then
 ConvertNumberToWordsVba = ConvertNumberToWordsVba(n \ 1000) & "Thousand " & IIf(n Mod 1000 = 0, "", ConvertNumberToWordsVba(n Mod 1000))
 Exit Function
 End If
 If n < 10000000 Then
 ConvertNumberToWordsVba = ConvertNumberToWordsVba(n \ 100000) & "Lakh " & IIf(n Mod 100000 = 0, "", ConvertNumberToWordsVba(n Mod 100000))
 Exit Function
 End If
 ConvertNumberToWordsVba = ConvertNumberToWordsVba(n \ 10000000) & "Crore " & IIf(n Mod 10000000 = 0, "", ConvertNumberToWordsVba(n Mod 10000000))
End Function

Public Function NumberToWordsVba(num As Double) As String
 If num = 0 Then
 NumberToWordsVba = "Zero Only"
 Exit Function
 End If

 Dim rupeesNum As Long, paiseNum As Long
 rupeesNum = Int(num)
 paiseNum = CLng(Application.WorksheetFunction.Round((num - rupeesNum) * 100, 0))

 Dim rupeesPart As String, paisePart As String
 rupeesPart = "": paisePart = ""
 If rupeesNum > 0 Then rupeesPart = ConvertNumberToWordsVba(rupeesNum) & "rupees"
 If paiseNum > 0 Then paisePart = " and " & ConvertNumberToWordsVba(paiseNum) & "paise"

 Dim finalStr As String
 finalStr = Trim(rupeesPart & paisePart)
 If Len(finalStr) > 0 Then
 Dim parts() As String
 parts = Split(finalStr, " ")
 Dim i As Long
 For i = LBound(parts) To UBound(parts)
 If Len(parts(i)) > 0 Then
 parts(i) = UCase(Left(parts(i), 1)) & Mid(parts(i), 2)
 End If
 Next i
 finalStr = Join(parts, " ") & " Only"
 End If
 NumberToWordsVba = finalStr
End Function

' Prompt 15: the certification block is now ONE merged cell (Terms &
' Conditions / Certification row, column 5) holding all four lines
' together - matches SummaryWorkbookService.ts's own certCell.value
' template exactly, so a partner rename can reconstruct it verbatim.
Private Function CertificationText(sellerName As String) As String
 CertificationText = "Certified that the particulars given above are true and correct" & Chr(10) & _
 "For " & sellerName & Chr(10) & Chr(10) & Chr(10) & "Authorised Signatory"
End Function

' Recomputes and rewrites the "Amount in Words" cell from the invoice
' sheet's CURRENT Invoice Amount value - called after Application.Calculate
' by every mutation path that can change Invoice Amount (line edits,
' quantity/amount redistribution, adding a product), since Excel has no
' built-in way to turn a number into words via a formula alone.
' Prompt 15: reads the CURRENT "Total Amount Before Tax" cell (the Total
' row's own live SUM formula flows into it), matching
' SummaryWorkbookService.ts's own wording exactly ("Rupees in words: ...",
' the label baked into the same single cell - not a separate label/value
' pair any more).
Private Sub UpdateAmountInWords(ws As Worksheet)
 Dim amount As Double
 amount = ws.Cells(GOODS_DISPATCHED_ROW_VBA, 8).Value
 ws.Cells(AMOUNT_IN_WORDS_ROW, 1).Value = "Rupees in words: " & NumberToWordsVba(amount)
End Sub

' Same trailing-prefix stripping as stripInvoicePrefixForDisplay() in
' WorkbookSyncEngine.ts - DISPLAY ONLY, used solely when writing a Purchase
' invoice sheet's own visible Invoice Number cell (never Purchase
' Summary's column, never _hidden_invoice_data - see section 9).
' Prompt 17: reduces an invoice number down to just its trailing digit run
' (e.g. "AT-2026-27-P-0001193" -> "0001193") - mirrors
' stripInvoicePrefixForDisplay() in WorkbookSyncEngine.ts exactly.
' Prompt 18 (reverting Prompt 17's over-correction): strips only the
' leading alphabetic abbreviation prefix (e.g. "AT-") - mirrors
' stripInvoicePrefixForDisplay() in WorkbookSyncEngine.ts exactly.
Private Function StripInvoicePrefixForDisplayVba(s As String) As String
 Dim i As Long
 i = 1
 Do While i <= Len(s) And Mid(s, i, 1) Like "[A-Za-z]"
 i = i + 1
 Loop
 If i > 1 And i <= Len(s) And Mid(s, i, 1) = "-" Then
 StripInvoicePrefixForDisplayVba = Mid(s, i + 1)
 Else
 StripInvoicePrefixForDisplayVba = s
 End If
End Function


' --------------------------- propagation entry points -------------------------
' Every Public Sub below is the only place that mutates cells for its
' operation, is guarded by gSyncInProgress + EnableEvents (restored in
' CleanFail even on error - section 15), and ends with Application.Calculate.

Public Sub PropagatePartnerRename(partnerId As String, newName As String)
 If gSyncInProgress Then Exit Sub
 If partnerId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim partnerWs As Worksheet, listWs As Worksheet, hws As Worksheet
 Dim r As Long, lastRow As Long
 Set partnerWs = PartnerSummarySheet()
 Set listWs = InvoiceListSheet()
 Set hws = HiddenDataSheet()

 r = PT_DATA_START_ROW
 Do While partnerWs.Cells(r, PT_COL_PARTNER_ID).Value <> ""
 If CStr(partnerWs.Cells(r, PT_COL_PARTNER_ID).Value) = partnerId Then
 partnerWs.Cells(r, PT_COL_NAME).Value = newName
 End If
 r = r + 1
 Loop

 Dim invoiceIdCol As Long, partnerIdCol As Long
 invoiceIdCol = InvoiceIdColumn(listWs)
 partnerIdCol = PartnerIdColumn(listWs)
 r = PS_DATA_START_ROW
 Do While listWs.Cells(r, invoiceIdCol).Value <> ""
 If CStr(listWs.Cells(r, partnerIdCol).Value) = partnerId Then
 listWs.Cells(r, PS_COL_PARTNER_NAME).Value = newName
 End If
 r = r + 1
 Loop

 Dim affectedSheets As New Collection
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(hws.Cells(r, HID_COL_PARTNER_ID).Value) = partnerId Then
 hws.Cells(r, HID_COL_PARTNER_NAME).Value = newName
 AddUnique affectedSheets, CStr(hws.Cells(r, HID_COL_SHEET_NAME).Value)
 End If
 Next r

 ' Prompt 6: for Sales, the partner (customer) is shown at row 7 - for
 ' Purchase, the partner (supplier) is now the TOP-BANNER seller
 ' identity (row 1), since row 7 became "Receiver" = our own company
 ' (section 8's reversal). Renaming a partner must update whichever of
 ' those actually displays it, and also the certification's "For
 ' {name}" line for Purchase, since that's the supplier too.
 Dim isSales As Boolean
 isSales = (listWs.Name = SHEET_SALES_SUMMARY)

 Dim i As Long, ws As Worksheet
 For i = 1 To affectedSheets.Count
 Set ws = Nothing
 On Error Resume Next
 Set ws = ThisWorkbook.Worksheets(CStr(affectedSheets(i)))
 On Error GoTo CleanFail
 If Not ws Is Nothing Then
 If isSales Then
 ws.Cells(INV_PARTNER_ROW, INV_PARTNER_VALUE_COL).Value = newName
 Else
 ws.Cells(1, 1).Value = newName
 ws.Cells(CERTIFICATION_TERMS_ROW_VBA, 5).Value = CertificationText(newName)
 End If
 End If
 Next i

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Date of Supply - the invoice sheet's own value cell (row 7, col 3 -
' WriteReferenceStyleLeft) was edited directly. Columns 1-4 on Purchase/
' Sales Summary are otherwise "fixed" (Invoice Number/Invoice Date/
' Partner never sync back from the summary side), but Date of Supply is
' the one exception - the same field the user can also edit ON the
' summary side (see HandleInvoiceListDateOfSupplyEdit, the reverse
' direction), so both must actually agree.
Public Sub PropagateDateOfSupply(invoiceId As String, newValue As String)
 If gSyncInProgress Then Exit Sub
 If invoiceId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim listWs As Worksheet, r As Long
 Set listWs = InvoiceListSheet()
 If listWs Is Nothing Then GoTo CleanFail
 r = FindInvoiceListRowByInvoiceId(invoiceId)
 If r > 0 Then
 listWs.Cells(r, 3).Value = newValue
 End If

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Prompt 15: blockIdx is now a ROW offset from INV_PRODUCT_DATA_ROW, not a
' column-block index - one product per row, name and HSN in their own
' separate cells (columns 2 and 4), never joined into one parenthesized
' string the way the old horizontal layout did.
Private Sub WriteProductBlockDisplay(sheetName As String, blockIdx As Long, name As String, hsn As String)
 Dim ws As Worksheet
 On Error Resume Next
 Set ws = ThisWorkbook.Worksheets(sheetName)
 On Error GoTo 0
 If ws Is Nothing Then Exit Sub
 If blockIdx < 0 Then Exit Sub
 Dim r As Long
 r = INV_PRODUCT_DATA_ROW + blockIdx
 ws.Cells(r, 2).Value = name
 ws.Cells(r, 4).Value = hsn
End Sub

Public Sub PropagateProductRename(productId As String, newName As String, newHsn As String)
 If gSyncInProgress Then Exit Sub
 If productId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim prodWs As Worksheet, hws As Worksheet, r As Long, lastRow As Long
 Set prodWs = ProductSummarySheet()
 Set hws = HiddenDataSheet()

 r = FindProductSummaryRow(productId)
 If r > 0 Then
 prodWs.Cells(r, PR_COL_NAME).Value = newName
 prodWs.Cells(r, PR_COL_HSN).Value = newHsn
 End If

 Dim listWs As Worksheet
 Set listWs = InvoiceListSheet()

 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(hws.Cells(r, HID_COL_PRODUCT_ID).Value) = productId Then
 hws.Cells(r, HID_COL_PRODUCT_NAME).Value = newName
 hws.Cells(r, HID_COL_HSN).Value = newHsn
 Dim blockIdxRename As Long
 blockIdxRename = CLng(hws.Cells(r, HID_COL_BLOCK_INDEX).Value)
 WriteProductBlockDisplay CStr(hws.Cells(r, HID_COL_SHEET_NAME).Value), _
 blockIdxRename, newName, newHsn

 ' Mirror the same rename onto Purchase/Sales Summary's own product
 ' block for this invoice - WriteProductBlockDisplay above only
 ' reaches the invoice sheet itself, never the summary (this was a
 ' real gap: a rename used to show on Product Summary and the
 ' invoice sheet, but never here).
 Dim listRowRename As Long
 listRowRename = FindInvoiceListRowByInvoiceId(CStr(hws.Cells(r, HID_COL_INVOICE_ID).Value))
 If listRowRename > 0 And blockIdxRename >= 0 Then
 Dim listBaseRename As Long
 listBaseRename = PS_PRODUCT_BLOCK_START_COL + blockIdxRename * 4
 listWs.Cells(listRowRename, listBaseRename).Value = _
 IIf(newHsn <> "", newName & " (" & newHsn & ")", newName)
 End If
 End If
 Next r

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

Public Sub PropagateQuantityRedistribution(productId As String, newTotalQty As Double)
 If gSyncInProgress Then Exit Sub
 If productId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 Dim rows As Collection
 Set rows = FindHiddenRowsByProduct(productId)
 If rows.Count = 0 Then GoTo CleanFail

 Dim weights() As Double
 ReDim weights(0 To rows.Count - 1)
 Dim i As Long
 For i = 1 To rows.Count
 weights(i - 1) = hws.Cells(rows(i), HID_COL_QTY).Value
 Next i

 Dim newQtys() As Double
 newQtys = RedistributeProportionally(weights, newTotalQty)

 Dim ws As Worksheet, r As Long, rate As Double, newAmt As Double, blockIdx As Long, hRow As Long, sName As String
 Dim affectedSheets As New Collection
 For i = 1 To rows.Count
 hRow = rows(i)
 rate = hws.Cells(hRow, HID_COL_RATE).Value
 newAmt = newQtys(i - 1) * rate
 hws.Cells(hRow, HID_COL_QTY).Value = newQtys(i - 1)
 hws.Cells(hRow, HID_COL_AMOUNT).Value = newAmt

 sName = CStr(hws.Cells(hRow, HID_COL_SHEET_NAME).Value)
 blockIdx = CLng(hws.Cells(hRow, HID_COL_BLOCK_INDEX).Value)
 Set ws = Nothing
 On Error Resume Next
 Set ws = ThisWorkbook.Worksheets(sName)
 On Error GoTo CleanFail
 If Not ws Is Nothing And blockIdx >= 0 Then
 ' Prompt 15: only Qty (column 5) is written - Total Amount
 ' (column 8) is a live formula (=IF(AND(E<>"",F<>""),E*F,""))
 ' already in place from generation, so it recomputes on its own.
 r = INV_PRODUCT_DATA_ROW + blockIdx
 ws.Cells(r, 5).Value = newQtys(i - 1)
 AddUnique affectedSheets, sName
 End If

 ' Prompt 20: mirror the same new quantity onto Purchase/Sales
 ' Summary's own product block for this invoice - Total Price
 ' there is a live Qty*Rate formula, so it recomputes on its own.
 Dim listWs2 As Worksheet, listRow2 As Long
 Set listWs2 = InvoiceListSheet()
 listRow2 = FindInvoiceListRowByInvoiceId(CStr(hws.Cells(hRow, HID_COL_INVOICE_ID).Value))
 If listRow2 > 0 And blockIdx >= 0 Then
 listWs2.Cells(listRow2, PS_PRODUCT_BLOCK_START_COL + blockIdx * 4 + 1).Value = newQtys(i - 1)
 EnsureSummaryTotalPriceFormula listWs2, listRow2, PS_PRODUCT_BLOCK_START_COL + blockIdx * 4
 End If
 Next i

 Dim psRow As Long
 psRow = FindProductSummaryRow(productId)
 If psRow > 0 Then WriteProductSummaryFormulas psRow ' restore formula after the manual trigger value

 Application.Calculate
 ' Amount in Words (Prompt 6) - recomputed from the now-current Invoice
 ' Amount, for every invoice sheet this redistribution actually touched.
 Dim j As Long, uws As Worksheet
 For j = 1 To affectedSheets.Count
 Set uws = Nothing
 On Error Resume Next
 Set uws = ThisWorkbook.Worksheets(CStr(affectedSheets(j)))
 On Error GoTo CleanFail
 If Not uws Is Nothing Then UpdateAmountInWords uws
 Next j
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

Public Sub PropagateAmountRedistribution(productId As String, newTotalAmount As Double)
 If gSyncInProgress Then Exit Sub
 If productId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 Dim rows As Collection
 Set rows = FindHiddenRowsByProduct(productId)
 If rows.Count = 0 Then GoTo CleanFail

 Dim weights() As Double
 ReDim weights(0 To rows.Count - 1)
 Dim i As Long
 For i = 1 To rows.Count
 weights(i - 1) = hws.Cells(rows(i), HID_COL_AMOUNT).Value
 Next i

 Dim newAmts() As Double
 newAmts = RedistributeProportionally(weights, newTotalAmount)

 Dim ws As Worksheet, r As Long, qty As Double, newRate As Double, blockIdx As Long, hRow As Long, sName As String
 Dim affectedSheets As New Collection
 For i = 1 To rows.Count
 hRow = rows(i)
 qty = hws.Cells(hRow, HID_COL_QTY).Value
 If qty > 0 Then
 newRate = newAmts(i - 1) / qty
 Else
 newRate = hws.Cells(hRow, HID_COL_RATE).Value
 End If
 hws.Cells(hRow, HID_COL_AMOUNT).Value = newAmts(i - 1)
 hws.Cells(hRow, HID_COL_RATE).Value = newRate

 sName = CStr(hws.Cells(hRow, HID_COL_SHEET_NAME).Value)
 blockIdx = CLng(hws.Cells(hRow, HID_COL_BLOCK_INDEX).Value)
 Set ws = Nothing
 On Error Resume Next
 Set ws = ThisWorkbook.Worksheets(sName)
 On Error GoTo CleanFail
 If Not ws Is Nothing And blockIdx >= 0 Then
 ' Prompt 15: only Rate (column 6) is written - Total Amount
 ' (column 8) recomputes on its own via the live formula.
 r = INV_PRODUCT_DATA_ROW + blockIdx
 ws.Cells(r, 6).Value = newRate
 AddUnique affectedSheets, sName
 End If

 ' Prompt 20: mirror the same new rate onto Purchase/Sales
 ' Summary's own product block for this invoice.
 Dim listWs3 As Worksheet, listRow3 As Long
 Set listWs3 = InvoiceListSheet()
 listRow3 = FindInvoiceListRowByInvoiceId(CStr(hws.Cells(hRow, HID_COL_INVOICE_ID).Value))
 If listRow3 > 0 And blockIdx >= 0 Then
 listWs3.Cells(listRow3, PS_PRODUCT_BLOCK_START_COL + blockIdx * 4 + 2).Value = newRate
 EnsureSummaryTotalPriceFormula listWs3, listRow3, PS_PRODUCT_BLOCK_START_COL + blockIdx * 4
 End If
 Next i

 Dim psRow As Long
 psRow = FindProductSummaryRow(productId)
 If psRow > 0 Then WriteProductSummaryFormulas psRow

 Application.Calculate
 Dim j As Long, uws As Worksheet
 For j = 1 To affectedSheets.Count
 Set uws = Nothing
 On Error Resume Next
 Set uws = ThisWorkbook.Worksheets(CStr(affectedSheets(j)))
 On Error GoTo CleanFail
 If Not uws Is Nothing Then UpdateAmountInWords uws
 Next j
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' A user edited the Name, HSN, Qty, or Rate cell directly on one product
' row of the vertical table (section 11 - the visible cell is the edit
' source in this direction; never overwritten by stale data). Prompt 15:
' `productRow` is the actual invoice-sheet row (INV_PRODUCT_DATA_ROW and
' up), one product per row - name (column 2) and HSN (column 4) are their
' own separate cells now, never joined into one parenthesized string.
Private Sub HandleInvoiceLineEdit(ws As Worksheet, productRow As Long)
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim blockIdx As Long
 blockIdx = productRow - INV_PRODUCT_DATA_ROW

 Dim hRow As Long
 hRow = FindHiddenRowBySheetAndBlock(ws.Name, blockIdx)
 Dim productId As String
 productId = ""
 If hRow > 0 Then productId = CStr(HiddenDataSheet().Cells(hRow, HID_COL_PRODUCT_ID).Value)

 Dim prodName As String, hsn As String
 prodName = CStr(ws.Cells(productRow, 2).Value)
 hsn = CStr(ws.Cells(productRow, 4).Value)

 ' Sl. No. (column 1) is auto-numbered from the row position whenever a
 ' row genuinely holds a product, and cleared again if the user empties
 ' a row out - keeps the visible numbering gap-free without requiring
 ' every row above it to already be filled in order.
 If prodName <> "" Then
 ws.Cells(productRow, 1).Value = blockIdx + 1
 Else
 ws.Cells(productRow, 1).Value = ""
 End If

 Dim qty As Double, rate As Double, amount As Double
 qty = ws.Cells(productRow, 5).Value
 rate = ws.Cells(productRow, 6).Value
 amount = qty * rate ' Total Amount (column 8) is already a live formula - never overwritten here.

 If hRow > 0 Then
 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 hws.Cells(hRow, HID_COL_PRODUCT_NAME).Value = prodName
 hws.Cells(hRow, HID_COL_HSN).Value = hsn
 hws.Cells(hRow, HID_COL_QTY).Value = qty
 hws.Cells(hRow, HID_COL_RATE).Value = rate
 hws.Cells(hRow, HID_COL_AMOUNT).Value = amount

 If productId <> "" Then
 Dim psRow As Long
 psRow = FindProductSummaryRow(productId)
 If psRow > 0 Then
 ProductSummarySheet().Cells(psRow, PR_COL_NAME).Value = prodName
 ProductSummarySheet().Cells(psRow, PR_COL_HSN).Value = hsn
 End If
 End If

 ' Prompt 18: mirror the same correction onto Purchase/Sales
 ' Summary's own product block for this invoice - Total Price
 ' there is a live Qty*Rate formula (SummaryWorkbookService.ts,
 ' Prompt 18), so only Name/Qty/Rate need writing.
 Dim listWs As Worksheet, listRow As Long
 Set listWs = InvoiceListSheet()
 listRow = FindInvoiceListRowByInvoiceId(CStr(hws.Cells(hRow, HID_COL_INVOICE_ID).Value))
 If listRow > 0 Then
 Dim listBase As Long
 listBase = PS_PRODUCT_BLOCK_START_COL + blockIdx * 4
 listWs.Cells(listRow, listBase).Value = IIf(hsn <> "", prodName & " (" & hsn & ")", prodName)
 listWs.Cells(listRow, listBase + 1).Value = qty
 listWs.Cells(listRow, listBase + 2).Value = rate
 EnsureSummaryTotalPriceFormula listWs, listRow, listBase
 End If
 End If
 ' hRow = 0 means this row wasn't part of the batch at generation time -
 ' a brand-new product typed directly into a blank row. Its own totals
 ' and Amount in Words still update below (live formulas), it just
 ' doesn't retroactively appear in Product/Supplier Summary, which stay
 ' a snapshot of the batch as of download time.

 Application.Calculate
 UpdateAmountInWords ws
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Entry point called by clsSheetWatcher.Sheet_Change for every non-summary
' (invoice) sheet. Handles a multi-cell Target by grouping it into the
' distinct product ROWS touched, processing each exactly once (section
' 11/12/14) - the "Target.Cells.Count > 1 -> Exit Sub" restriction from
' Prompt 4 is removed per Prompt 4B, section 10. Prompt 15: there is no
' more "ADD PRODUCT" trigger cell to check for - every one of the
' MIN_PRODUCT_ROWS_VBA rows is already live and editable from generation.
Public Sub HandleInvoiceSheetChange(ws As Worksheet, Target As Range)
 If gSyncInProgress Then Exit Sub
 ' No real batch open (e.g. the master template itself, which has no
 ' Purchase/Sales Summary sheet at all) - nothing to sync against.
 If InvoiceListSheet() Is Nothing Then Exit Sub

 ' Prompt 6: on a Sales sheet, the partner (customer) is edited at row
 ' 9. On a Purchase sheet, row 9 became "Receiver" = our own company
 ' (section 8) - the partner (supplier) is now the top-banner seller
 ' identity at row 1, col 1, so that's the cell a rename edit comes
 ' from there instead.
 Dim isSalesSheet As Boolean
 isSalesSheet = (InvoiceListSheet().Name = SHEET_SALES_SUMMARY)
 Dim partnerNameCellRow As Long, partnerNameCellCol As Long
 If isSalesSheet Then
 partnerNameCellRow = INV_PARTNER_ROW
 partnerNameCellCol = INV_PARTNER_VALUE_COL
 Else
 partnerNameCellRow = 1
 partnerNameCellCol = 1
 End If

 If Not Application.Intersect(Target, ws.Cells(partnerNameCellRow, partnerNameCellCol)) Is Nothing Then
 Dim batchId As String, invoiceId As String, invNum As String, partnerId As String, partnerName As String
 GetSheetIdentity ws, batchId, invoiceId, invNum, partnerId, partnerName
 If partnerId <> "" Then
 PropagatePartnerRename partnerId, CStr(ws.Cells(partnerNameCellRow, partnerNameCellCol).Value)
 End If
 End If

 ' Date of Supply (row 7, col 3 - WriteReferenceStyleLeft) is two-way
 ' synced with Purchase/Sales Summary's own Date of Supply column - the
 ' one exception to columns 1-4 there otherwise being fixed/reference-only.
 If Not Application.Intersect(Target, ws.Cells(7, 3)) Is Nothing Then
 GetSheetIdentity ws, batchId, invoiceId, invNum, partnerId, partnerName
 If invoiceId <> "" Then
 PropagateDateOfSupply invoiceId, CStr(ws.Cells(7, 3).Value)
 End If
 End If

 ' "ADD PRODUCT" dropdown - picking an existing product fills the next
 ' blank product row with its Name+HSN.
 If Not Application.Intersect(Target, ws.Cells(ADD_PRODUCT_TRIGGER_ROW, ADD_PRODUCT_TRIGGER_COL)) Is Nothing Then
 Dim pickedName As String
 pickedName = Trim(CStr(ws.Cells(ADD_PRODUCT_TRIGGER_ROW, ADD_PRODUCT_TRIGGER_COL).Value))
 gSyncInProgress = True
 Application.EnableEvents = False
 ws.Cells(ADD_PRODUCT_TRIGGER_ROW, ADD_PRODUCT_TRIGGER_COL).Value = ADD_PRODUCT_PLACEHOLDER
 Application.EnableEvents = True
 gSyncInProgress = False
 If pickedName <> "" And pickedName <> ADD_PRODUCT_PLACEHOLDER Then
 Dim pickedId As String, pickedHsn As String
 If FindProductByName(pickedName, pickedId, pickedHsn) Then
 PlaceProductOnInvoice ws, pickedId, pickedName, pickedHsn
 End If
 End If
 Exit Sub
 End If

 Dim productRange As Range
 Set productRange = ws.Range(ws.Rows(INV_PRODUCT_DATA_ROW), ws.Rows(LastProductRowVba()))
 Dim rowIntersect As Range
 Set rowIntersect = Application.Intersect(Target, productRange)
 If rowIntersect Is Nothing Then Exit Sub

 Dim touchedRows As New Collection, area As Range, c As Range, i As Long, r As Long
 For Each area In rowIntersect.Areas
 For Each c In area.Cells
 ' Only Name (2)/HSN (4)/Qty (5)/Rate (6 or 7, merged) columns
 ' drive a re-sync - Sl. No. (1) is auto-numbered, and Total
 ' Amount (8) is derived, never an independent edit source.
 Select Case c.Column
 Case 2, 3, 4, 5, 6, 7
 AddUnique touchedRows, CStr(c.Row)
 End Select
 Next c
 Next area

 For i = 1 To touchedRows.Count
 r = CLng(touchedRows(i))
 HandleInvoiceLineEdit ws, r
 Next i
End Sub

' Prompt 18: the reverse direction of HandleInvoiceLineEdit - a user
' edited a product's Name/Qty/Rate directly inside its 4-column block on
' Purchase/Sales Summary. Writes the correction into the corresponding
' invoice sheet's own product row (matched by Invoice ID + block index,
' via _hidden_invoice_data), keeping both sides showing the same values.
Private Sub HandleInvoiceListProductEdit(listWs As Worksheet, rowNum As Long, blockIdx As Long)
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim base As Long
 base = PS_PRODUCT_BLOCK_START_COL + blockIdx * 4

 Dim idCol As Long, invoiceId As String
 idCol = InvoiceIdColumn(listWs)
 invoiceId = CStr(listWs.Cells(rowNum, idCol).Value)
 If invoiceId = "" Then GoTo CleanFail

 ' A runtime-appended invoice row (AppendInvoiceListRow) has no Total
 ' Price formula in its product blocks at all until something puts one
 ' there - if the user is editing this block directly for the first
 ' time, that's here.
 EnsureSummaryTotalPriceFormula listWs, rowNum, base

 ' Purchase/Sales Summary still joins HSN into the product name as
 ' "Name (HSN)" - its own horizontal-block layout wasn't part of
 ' Prompt 15's invoice-sheet rewrite - so split it back apart for the
 ' invoice sheet's own separate Name/HSN cells.
 Dim rawName As String, prodName As String, hsn As String
 rawName = CStr(listWs.Cells(rowNum, base).Value)
 If Right(rawName, 1) = ")" And InStr(rawName, "(") > 0 Then
 Dim openPos As Long
 openPos = InStrRev(rawName, "(")
 prodName = Trim(Left(rawName, openPos - 1))
 hsn = Mid(rawName, openPos + 1, Len(rawName) - openPos - 1)
 Else
 prodName = rawName
 hsn = ""
 End If

 Dim qty As Double, rate As Double
 qty = listWs.Cells(rowNum, base + 1).Value
 rate = listWs.Cells(rowNum, base + 2).Value

 Dim hRow As Long
 hRow = FindHiddenRowByInvoiceAndBlock(invoiceId, blockIdx)
 If hRow = 0 Then GoTo CleanFail ' not a real, generated line - nothing to sync

 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 ' If this edit only touched Qty/Rate and left the Name/HSN cell alone,
 ' rawName still holds the existing "Name (HSN)" text, so hsn is
 ' already correct - never silently blanked.
 hws.Cells(hRow, HID_COL_PRODUCT_NAME).Value = prodName
 hws.Cells(hRow, HID_COL_HSN).Value = hsn
 hws.Cells(hRow, HID_COL_QTY).Value = qty
 hws.Cells(hRow, HID_COL_RATE).Value = rate
 hws.Cells(hRow, HID_COL_AMOUNT).Value = qty * rate

 Dim sheetName As String
 sheetName = CStr(hws.Cells(hRow, HID_COL_SHEET_NAME).Value)
 Dim invWs As Worksheet
 Set invWs = Nothing
 On Error Resume Next
 Set invWs = ThisWorkbook.Worksheets(sheetName)
 On Error GoTo CleanFail
 If Not invWs Is Nothing Then
 Dim invRow As Long
 invRow = INV_PRODUCT_DATA_ROW + blockIdx
 invWs.Cells(invRow, 1).Value = IIf(prodName <> "", blockIdx + 1, "")
 invWs.Cells(invRow, 2).Value = prodName
 invWs.Cells(invRow, 4).Value = hsn
 invWs.Cells(invRow, 5).Value = qty
 invWs.Cells(invRow, 6).Value = rate
 End If

 Dim productId As String
 productId = CStr(hws.Cells(hRow, HID_COL_PRODUCT_ID).Value)
 If productId <> "" Then
 Dim psRow As Long
 psRow = FindProductSummaryRow(productId)
 If psRow > 0 Then
 ProductSummarySheet().Cells(psRow, PR_COL_NAME).Value = prodName
 ProductSummarySheet().Cells(psRow, PR_COL_HSN).Value = hsn
 End If
 End If

 Application.Calculate
 If Not invWs Is Nothing Then UpdateAmountInWords invWs
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Entry point called by clsSheetWatcher.Sheet_Change for Purchase/Sales
' Summary, for any edit outside the two lifecycle trigger cells (row 2).
' Groups a multi-cell Target into the distinct (row, blockIdx) product
' blocks touched, same dedupe pattern as HandleInvoiceSheetChange.
Public Sub HandleInvoiceListRowChange(listWs As Worksheet, Target As Range)
 If gSyncInProgress Then Exit Sub

 ' A row (or several) may have just been deleted directly - if so,
 ' clean up and renumber, and don't also try to reinterpret this same
 ' Target range as a normal per-cell product edit below.
 If ReconcileDeletedInvoiceRows(listWs) Then Exit Sub

 Dim tailStartCol As Long
 tailStartCol = InvoiceAmountColumnOnSummary(listWs)
 If tailStartCol = 0 Then Exit Sub

 Dim touched As New Collection, area As Range, c As Range
 Dim dosRows As New Collection
 For Each area In Target.Areas
 For Each c In area.Cells
 If c.Row >= PS_DATA_START_ROW And c.Column >= PS_PRODUCT_BLOCK_START_COL And c.Column < tailStartCol Then
 Dim offsetInBlock As Long
 offsetInBlock = (c.Column - PS_PRODUCT_BLOCK_START_COL) Mod 4
 ' Only Name (0)/Qty (1)/Rate (2) drive a re-sync - Total
 ' Price (3) is a derived formula, never an edit source.
 If offsetInBlock <= 2 Then
 Dim blockIdx As Long
 blockIdx = (c.Column - PS_PRODUCT_BLOCK_START_COL) \ 4
 AddUnique touched, c.Row & "|" & blockIdx
 End If
 ' Date of Supply (column 3) is the one exception to columns 1-4
 ' otherwise being fixed/reference-only on this sheet - two-way
 ' synced with the invoice sheet's own Date of Supply cell (see
 ' PropagateDateOfSupply for the reverse direction).
 ElseIf c.Row >= PS_DATA_START_ROW And c.Column = 3 Then
 AddUnique dosRows, CStr(c.Row)
 End If
 Next c
 Next area

 Dim i As Long, parts() As String
 For i = 1 To touched.Count
 parts = Split(CStr(touched(i)), "|")
 HandleInvoiceListProductEdit listWs, CLng(parts(0)), CLng(parts(1))
 Next i

 Dim j As Long
 For j = 1 To dosRows.Count
 HandleInvoiceListDateOfSupplyEdit listWs, CLng(dosRows(j))
 Next j
End Sub

' Reverse direction of PropagateDateOfSupply - a user edited Date of
' Supply directly on Purchase/Sales Summary. Writes the correction into
' the corresponding invoice sheet's own Date of Supply cell (row 7, col
' 3), matched by Invoice ID via _hidden_invoice_data.
Private Sub HandleInvoiceListDateOfSupplyEdit(listWs As Worksheet, rowNum As Long)
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim sheetName As String
 sheetName = SheetNameForInvoiceRow(rowNum)
 If sheetName = "" Then GoTo CleanFail

 Dim ws As Worksheet
 On Error Resume Next
 Set ws = ThisWorkbook.Worksheets(sheetName)
 On Error GoTo CleanFail
 If ws Is Nothing Then GoTo CleanFail

 ws.Cells(7, 3).Value = listWs.Cells(rowNum, 3).Value

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Called by Product Summary's own Worksheet_Change (SummarySheetHandlers,
' below) once per distinct affected row - dedupe/looping across a
' multi-row paste happens in that handler via CollectDistinctRows.
Public Sub HandleProductSummaryRowChange(ws As Worksheet, Target As Range, r As Long)
 If r < PR_DATA_START_ROW Then Exit Sub
 If ws.Cells(r, PR_COL_PRODUCT_ID).Value = "" Then Exit Sub
 Dim productId As String
 productId = CStr(ws.Cells(r, PR_COL_PRODUCT_ID).Value)

 Dim touchedThisRow As Range
 Set touchedThisRow = Application.Intersect(Target, ws.Rows(r))
 If touchedThisRow Is Nothing Then Exit Sub

 Dim nameOrHsnTouched As Boolean, qtyTouched As Boolean, amtTouched As Boolean
 nameOrHsnTouched = Not Application.Intersect(touchedThisRow, ws.Cells(r, PR_COL_NAME)) Is Nothing Or _
 Not Application.Intersect(touchedThisRow, ws.Cells(r, PR_COL_HSN)) Is Nothing
 qtyTouched = Not Application.Intersect(touchedThisRow, ws.Cells(r, PR_COL_QTY)) Is Nothing
 amtTouched = Not Application.Intersect(touchedThisRow, ws.Cells(r, PR_COL_AMOUNT)) Is Nothing

 ' Read the FINAL current values - Change fires after the paste has
 ' already landed, never intermediate state (section 14).
 If nameOrHsnTouched Then
 PropagateProductRename productId, CStr(ws.Cells(r, PR_COL_NAME).Value), CStr(ws.Cells(r, PR_COL_HSN).Value)
 End If
 If qtyTouched And Not ws.Cells(r, PR_COL_QTY).HasFormula Then
 PropagateQuantityRedistribution productId, CDbl(ws.Cells(r, PR_COL_QTY).Value)
 End If
 If amtTouched And Not ws.Cells(r, PR_COL_AMOUNT).HasFormula Then
 PropagateAmountRedistribution productId, CDbl(ws.Cells(r, PR_COL_AMOUNT).Value)
 End If
End Sub

' Called by Supplier/Customer Summary's own Worksheet_Change, once per
' distinct affected row.
Public Sub HandlePartnerSummaryRowChange(ws As Worksheet, Target As Range, r As Long)
 If r < PT_DATA_START_ROW Then Exit Sub
 If ws.Cells(r, PT_COL_PARTNER_ID).Value = "" Then Exit Sub
 Dim touchedThisRow As Range
 Set touchedThisRow = Application.Intersect(Target, ws.Rows(r))
 If touchedThisRow Is Nothing Then Exit Sub
 If Not Application.Intersect(touchedThisRow, ws.Cells(r, PT_COL_NAME)) Is Nothing Then
 PropagatePartnerRename CStr(ws.Cells(r, PT_COL_PARTNER_ID).Value), CStr(ws.Cells(r, PT_COL_NAME).Value)
 End If
End Sub


' --------------------------- Prompt 5: invoice list helpers -------------------
' Prompt 15: the old "dynamic product addition" section (AddProductBlock - 
' a column-insert triggered by an "ADD PRODUCT" cell) is gone. Every
' invoice sheet's product table is already padded to MIN_PRODUCT_ROWS_VBA
' blank, live, formatted rows at generation time - a new product is just
' typed directly into the next blank row, and HandleInvoiceSheetChange
' above picks it up like any other edit. No trigger cell, no InputBox
' prompts, no column-insert to get wrong.

Private Function InvoiceListRowCount() As Long
 Dim ws As Worksheet, r As Long, idCol As Long
 Set ws = InvoiceListSheet()
 idCol = InvoiceIdColumn(ws)
 r = PS_DATA_START_ROW
 Do While ws.Cells(r, idCol).Value <> ""
 r = r + 1
 Loop
 InvoiceListRowCount = r - PS_DATA_START_ROW
End Function

Private Function FindInvoiceListRowByInvoiceId(invoiceId As String) As Long
 Dim ws As Worksheet, r As Long, n As Long, idCol As Long
 Set ws = InvoiceListSheet()
 n = InvoiceListRowCount()
 idCol = InvoiceIdColumn(ws)
 For r = PS_DATA_START_ROW To PS_DATA_START_ROW + n - 1
 If CStr(ws.Cells(r, idCol).Value) = invoiceId Then
 FindInvoiceListRowByInvoiceId = r
 Exit Function
 End If
 Next r
 FindInvoiceListRowByInvoiceId = 0
End Function

' Appends a new invoice row just above the TOTAL row - same
' insert-then-rewrite-total pattern as AppendProductSummaryRow /
' AppendPartnerSummaryRow.
Private Sub AppendInvoiceListRow(invoiceNumber As String, isSales As Boolean, invoiceId As String, _
 partnerId As String, partnerName As String, sheetNameForRow As String)
 Dim listWs As Worksheet, n As Long, newRow As Long, totalRow As Long
 Set listWs = InvoiceListSheet()
 n = InvoiceListRowCount()
 newRow = PS_DATA_START_ROW + n

 listWs.Rows(newRow).Insert Shift:=xlDown, CopyOrigin:=xlFormatFromLeftOrAbove
 ' Prompt 6 (latest revision): Purchase Summary's own column is now
 ' ALSO the prefix-stripped display number - `invoiceNumber` here is
 ' always the FULL real number (matching AppendHiddenDataRow's own
 ' full number below), so it must be stripped here for Purchase too.
 If isSales Then
 listWs.Cells(newRow, 1).Value = invoiceNumber
 Else
 listWs.Cells(newRow, 1).Value = StripInvoicePrefixForDisplayVba(invoiceNumber)
 End If
 listWs.Cells(newRow, 2).Value = "" ' Invoice Date - user fills in on the sheet
 listWs.Cells(newRow, 3).Value = "" ' Date of Supply
 listWs.Cells(newRow, PS_COL_PARTNER_NAME).Value = partnerName

 ' Prompt 11: Invoice Amount/Transport Mode/Vehicle Number/Invoice ID/
 ' Partner ID no longer sit at a fixed column - the product blocks now
 ' come immediately after Supplier (section 4), so each is found
 ' dynamically by its header text, same as everywhere else in this
 ' module now does it.
 Dim amountCol As Long, transportCol As Long, vehicleCol As Long, idCol As Long, partnerIdCol As Long
 amountCol = InvoiceAmountColumnOnSummary(listWs)
 transportCol = TransportModeColumn(listWs)
 vehicleCol = VehicleNumberColumn(listWs)
 idCol = InvoiceIdColumn(listWs)
 partnerIdCol = PartnerIdColumn(listWs)

 ' Prompt 10/11: a same-row SUMIF over this row's own "Total Price"
 ' product-block cells - matching SummaryWorkbookService.ts's own
 ' generation-time formula exactly. A brand-new invoice has no product
 ' blocks filled in yet, so this correctly evaluates to 0 until "ADD
 ' PRODUCT" is used on its invoice sheet.
 listWs.Cells(newRow, amountCol).Formula = _
 "=SUMIF(" & PS_HEADER_ROW & ":" & PS_HEADER_ROW & ",""Total Price""," & newRow & ":" & newRow & ")"
 listWs.Cells(newRow, transportCol).Value = "" ' Transport Mode
 listWs.Cells(newRow, vehicleCol).Value = "" ' Vehicle Number
 listWs.Cells(newRow, idCol).Value = invoiceId
 listWs.Cells(newRow, partnerIdCol).Value = partnerId

 ' A batch can run to hundreds of invoice sheets - a per-row jump
 ' straight to this new invoice's own sheet. Header only exists on
 ' files generated after this feature shipped; older files just skip it
 ' rather than erroring.
 Dim viewInvoiceCol As Long
 viewInvoiceCol = FindColumnByHeader(listWs, PS_HEADER_ROW, "View Invoice")
 If viewInvoiceCol > 0 Then
 listWs.Cells(newRow, viewInvoiceCol).Formula = _
 "=HYPERLINK(""#'" & sheetNameForRow & "'!A1"",""View Invoice"")"
 End If

 totalRow = newRow + 1
 Dim amountLetter As String
 amountLetter = ColLetter(amountCol)
 listWs.Cells(totalRow, amountCol).Formula = "=SUM(" & amountLetter & PS_DATA_START_ROW & ":" & amountLetter & newRow & ")"
End Sub

Private Function PartnerSummaryRowCount() As Long
 Dim ws As Worksheet, r As Long
 Set ws = PartnerSummarySheet()
 r = PT_DATA_START_ROW
 Do While ws.Cells(r, PT_COL_PARTNER_ID).Value <> ""
 r = r + 1
 Loop
 PartnerSummaryRowCount = r - PT_DATA_START_ROW
End Function

Private Function FindPartnerSummaryRowByName(name As String) As Long
 Dim ws As Worksheet, r As Long, n As Long
 Set ws = PartnerSummarySheet()
 n = PartnerSummaryRowCount()
 For r = PT_DATA_START_ROW To PT_DATA_START_ROW + n - 1
 If LCase(Trim(CStr(ws.Cells(r, PT_COL_NAME).Value))) = LCase(Trim(name)) Then
 FindPartnerSummaryRowByName = r
 Exit Function
 End If
 Next r
 FindPartnerSummaryRowByName = 0
End Function

' Creates exactly one new Supplier/Customer Summary row for a genuinely new
' partner (section 6) - never called when an existing partner already
' matched by name in the caller.
Private Sub AppendPartnerSummaryRow(partnerId As String, name As String)
 Dim ws As Worksheet, listWs As Worksheet, n As Long, newRow As Long, totalRow As Long
 Set ws = PartnerSummarySheet()
 Set listWs = InvoiceListSheet()
 n = PartnerSummaryRowCount()
 newRow = PT_DATA_START_ROW + n

 ws.Rows(newRow).Insert Shift:=xlDown, CopyOrigin:=xlFormatFromLeftOrAbove
 ws.Cells(newRow, PT_COL_NAME).Value = name
 ws.Cells(newRow, PT_COL_PARTNER_ID).Value = partnerId

 ' Prompt 11: whole-column references (not a range bounded to today's
 ' invoice count) - the same robustness fix SummaryWorkbookService.ts
 ' already applies at generation time (Prompt 9, section 8), now also
 ' applied here so a partner row VBA creates at runtime is exactly as
 ' durable as one the generator wrote. The referenced columns are no
 ' longer fixed at I/E either - they move with the batch's widest
 ' invoice, so they're found the same dynamic way as everywhere else.
 Dim partnerIdColLetter As String, amountColLetter As String
 partnerIdColLetter = ColLetter(PartnerIdColumn(listWs))
 amountColLetter = ColLetter(InvoiceAmountColumnOnSummary(listWs))
 Dim partnerIdRange As String, amountRange As String
 partnerIdRange = "'" & listWs.Name & "'!$" & partnerIdColLetter & ":$" & partnerIdColLetter
 amountRange = "'" & listWs.Name & "'!$" & amountColLetter & ":$" & amountColLetter
 ws.Cells(newRow, 2).Formula = "=COUNTIF(" & partnerIdRange & ",D" & newRow & ")"
 ws.Cells(newRow, 3).Formula = "=SUMIF(" & partnerIdRange & ",D" & newRow & "," & amountRange & ")"

 totalRow = newRow + 1
 ws.Cells(totalRow, 2).Formula = "=SUM(B" & PT_DATA_START_ROW & ":B" & newRow & ")"
 ws.Cells(totalRow, 3).Formula = "=SUM(C" & PT_DATA_START_ROW & ":C" & newRow & ")"
End Sub

Private Function CurrentBatchId() As String
 Dim ws As Worksheet, lastRow As Long
 Set ws = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 If lastRow >= HID_DATA_START_ROW Then
 CurrentBatchId = CStr(ws.Cells(HID_DATA_START_ROW, HID_COL_BATCH_ID).Value)
 Else
 CurrentBatchId = ""
 End If
End Function

Private Function FindAnyExistingInvoiceSheet() As Worksheet
 Dim ws As Worksheet
 For Each ws In ThisWorkbook.Worksheets
 If Not IsSummarySheet(ws) Then
 Set FindAnyExistingInvoiceSheet = ws
 Exit Function
 End If
 Next ws
 Set FindAnyExistingInvoiceSheet = Nothing
End Function

' Finds a real invoice sheet already belonging to this specific partner
' (by their stable Partner ID) - used so a new invoice added for an
' EXISTING supplier/customer starts from THEIR own past invoice (their
' real GSTIN/Address/State, not just whichever invoice happens to be
' first in the workbook). Deliberately walks HiddenDataLastRow()'s
' row-by-row scan rather than any .End() navigation - see
' FindColumnByHeader's own note on why .End() proved unreliable here.
Private Function FindExistingInvoiceSheetForPartner(partnerId As String) As Worksheet
 Set FindExistingInvoiceSheetForPartner = Nothing
 If partnerId = "" Then Exit Function
 Dim hd As Worksheet, r As Long, lastRow As Long
 Set hd = HiddenDataSheet()
 lastRow = HiddenDataLastRow()
 For r = HID_DATA_START_ROW To lastRow
 If CStr(hd.Cells(r, HID_COL_PARTNER_ID).Value) = partnerId Then
 Dim candidate As Worksheet
 On Error Resume Next
 Set candidate = ThisWorkbook.Worksheets(CStr(hd.Cells(r, HID_COL_SHEET_NAME).Value))
 On Error GoTo 0
 If Not candidate Is Nothing Then
 Set FindExistingInvoiceSheetForPartner = candidate
 Exit Function
 End If
 End If
 Next r
End Function

' Safely reads a template sheet's cell as text, or returns fallback if
' template is Nothing. Deliberately NOT written as
' IIf(Not template Is Nothing, CStr(template.Cells(r,c).Value), fallback)
' - IIf is a real function, so VBA evaluates BOTH of its arguments
' unconditionally before choosing one, meaning that exact pattern still
' evaluates template.Cells(...) even when template genuinely is Nothing,
' crashing with "Object variable not set" right there and silently
' aborting the rest of whatever Sub/Function called it. This is a real If/
' Else instead, which only ever evaluates the branch it actually needs.
Private Function TemplateCellText(template As Worksheet, r As Long, c As Long, Optional fallback As String = "") As String
 If template Is Nothing Then
 TemplateCellText = fallback
 Else
 TemplateCellText = CStr(template.Cells(r, c).Value)
 End If
End Function

' VBA port of safeSheetName() in SummaryWorkbookService.ts - same
' character-stripping, 31-char truncation, and de-dupe-with-suffix rules,
' so a workbook-created invoice's sheet name is never invalid and never
' collides with an existing one.
Private Function NameIsUsed(usedNames As Collection, name As String) As Boolean
 Dim probe As Variant
 On Error Resume Next
 probe = usedNames(UCase(name))
 NameIsUsed = (Err.Number = 0)
 Err.Clear
 On Error GoTo 0
End Function

Private Function SafeSheetNameVba(rawName As String, usedNames As Collection) As String
 Dim base As String
 base = rawName
 Dim invalidChars As String
 invalidChars = "\/?*[]:"
 Dim i As Long
 For i = 1 To Len(invalidChars)
 base = Replace(base, Mid(invalidChars, i, 1), "-")
 Next i
 base = Trim(base)
 Do While Left(base, 1) = "'"
 base = Mid(base, 2)
 Loop
 Do While Right(base, 1) = "'"
 base = Left(base, Len(base) - 1)
 Loop
 base = Trim(base)
 If Len(base) = 0 Then base = "Sheet"
 If Len(base) > 31 Then base = Left(base, 31)

 Dim candidate As String
 candidate = base
 Dim suffix As Long
 suffix = 1
 Do While NameIsUsed(usedNames, candidate)
 suffix = suffix + 1
 Dim suffixStr As String
 suffixStr = " (" & suffix & ")"
 Dim maxBaseLen As Long
 maxBaseLen = 31 - Len(suffixStr)
 If maxBaseLen < 1 Then maxBaseLen = 1
 candidate = Left(base, maxBaseLen) & suffixStr
 Loop
 AddUnique usedNames, UCase(candidate)
 SafeSheetNameVba = candidate
End Function

' PROMPT 13: mirrors SummaryWorkbookService.ts's addReferenceStyleRow
' exactly - label|colon|value as three single-column cells on the left
' (columns 1-3), or a merged 2-col label|1-col colon|merged 2-col value
' on the right (columns 4-8). Matches the reference invoice's own actual
' merge geometry (verified against its mergeCells list), not an
' approximation.
Private Sub WriteReferenceStyleLeft(ws As Worksheet, r As Long, label As String, value As String)
 ws.Cells(r, 1).Value = label
 ws.Cells(r, 1).Font.Bold = True
 ws.Cells(r, 2).Value = ":"
 ws.Cells(r, 3).Value = value
End Sub

Private Sub WriteReferenceStyleRight(ws As Worksheet, r As Long, label As String, value As String)
 ws.Range(ws.Cells(r, 4), ws.Cells(r, 5)).Merge
 ws.Cells(r, 4).Value = label
 ws.Cells(r, 4).Font.Bold = True
 ws.Cells(r, 6).Value = ":"
 ws.Range(ws.Cells(r, 7), ws.Cells(r, 8)).Merge
 ws.Cells(r, 7).Value = value
End Sub

' Prompt 15: rows 5-7 and 11/13's right side are each a SINGLE merged
' cell (columns 4-8) holding "Label : value" as one concatenated string - 
' matches SummaryWorkbookService.ts's own row5/6/7/11/13 geometry exactly
' (distinct from WriteReferenceStyleRight's split label|colon|value, which
' only rows 9/10 actually use).
Private Sub WriteConcatRight(ws As Worksheet, r As Long, text As String)
 ws.Range(ws.Cells(r, 4), ws.Cells(r, 8)).Merge
 ws.Cells(r, 4).Value = text
 ws.Cells(r, 4).Font.Bold = True
End Sub

' A row of two paired section-title cells (e.g. "Delivery Details"
' merged A:C, "Seller Details" merged D:H) - matches
' SummaryWorkbookService.ts's addSectionHeaderRow exactly.
Private Sub WriteSectionHeaderPair(ws As Worksheet, r As Long, leftTitle As String, rightTitle As String)
 ws.Range(ws.Cells(r, 1), ws.Cells(r, 3)).Merge
 ws.Cells(r, 1).Value = leftTitle
 ws.Cells(r, 1).Font.Bold = True
 ws.Range(ws.Cells(r, 4), ws.Cells(r, 8)).Merge
 ws.Cells(r, 4).Value = rightTitle
 ws.Cells(r, 4).Font.Bold = True
End Sub

' Builds a brand-new, zero-product invoice sheet using the same visible
' layout SummaryWorkbookService.ts's buildInvoiceSheet produces (Prompt 15)
' - banner rows copied from an existing invoice sheet if one exists (so
' the issuing-company header matches), label-value rows 5-13, the full
' MIN_PRODUCT_ROWS_VBA-row blank product table (every row already carrying
' its own live Total Amount formula, exactly like a freshly generated
' invoice with zero real products), and the whole footer chain.
Private Function BuildBlankInvoiceSheet(sheetName As String, isSales As Boolean, invoiceNumber As String, _
 partnerLabel As String, partnerName As String, partnerId As String) As Worksheet
 ' Deliberately NOT cloning an existing invoice sheet's VALUES - that
 ' approach (tried and reverted) proved unreliable in practice, landing
 ' the new sheet with the template invoice's own stale invoice number/
 ' products still showing. Formatting (borders/fills/column widths) IS
 ' still copied below, just via PasteSpecial-formats-only, never the
 ' sheet's actual content - so this sheet visually matches without the
 ' bug that copying content along with it caused.
 ' Two different templates, never mixed: partnerTemplate is THIS
 ' specific partner's own most recent invoice (Nothing for a genuinely
 ' new partner) - the only thing safe to source their own GSTIN/
 ' Address/State from. anyTemplate is any existing invoice at all - 
 ' safe ONLY for whichever side of the invoice is US (consistent
 ' across the whole batch regardless of partner): Sales's seller
 ' banner, Purchase's receiver block.
 Dim partnerTemplate As Worksheet
 Set partnerTemplate = FindExistingInvoiceSheetForPartner(partnerId)
 Dim anyTemplate As Worksheet
 Set anyTemplate = FindAnyExistingInvoiceSheet()

 Dim ws As Worksheet
 Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
 ws.Name = sheetName

 ' Column widths - same as SummaryWorkbookService.ts's own invoice
 ' layout, so a VBA-built sheet is never narrower/wider than a
 ' generated one.
 Dim widths As Variant, wc As Long
 widths = Array(18, 3, 24, 15, 10, 3, 12, 18)
 For wc = 0 To 7
 ws.Columns(wc + 1).ColumnWidth = widths(wc)
 Next wc

 ' Borders/fills only (never values) from any real invoice sheet, so
 ' this new sheet visually matches without inheriting any of that
 ' sheet's actual data - cloning the whole sheet (tried and reverted)
 ' brought the data along with it, which is exactly what broke.
 If Not anyTemplate Is Nothing Then
 anyTemplate.UsedRange.Copy
 ws.Range("A1").PasteSpecial Paste:=xlPasteFormats
 Application.CutCopyMode = False
 End If

 Dim totalCols As Long
 totalCols = 8

 ws.Range(ws.Cells(1, 1), ws.Cells(1, totalCols)).Merge
 ws.Range(ws.Cells(2, 1), ws.Cells(2, totalCols)).Merge
 ws.Range(ws.Cells(3, 1), ws.Cells(3, totalCols)).Merge

 ' A batch can run to hundreds of invoice sheets - one click back to
 ' Batch Overview from wherever the user currently is. Column 9 sits
 ' just past the invoice sheet's own 8-column layout.
 On Error Resume Next
 Dim homeCell As Range
 Set homeCell = ws.Cells(1, 9)
 ' U+1F3E0 (house emoji) is outside the Basic Multilingual Plane - 
 ' ChrW alone can only hold a single UTF-16 code unit, so it needs an
 ' explicit surrogate pair (high D83C, low DFE0), not one ChrW call.
 homeCell.Formula = "=HYPERLINK(""#'" & BATCH_OVERVIEW_SHEET_NAME_VBA & "'!A1"",""" & ChrW(&HD83C) & ChrW(&HDFE0) & " Home"")"
 homeCell.Font.Bold = True
 homeCell.Font.Underline = True
 On Error GoTo 0

 ' Row 1-3: seller identity (Prompt 6 reversal). Sales -> our own
 ' company, the same on every Sales invoice, safe to copy from ANY
 ' existing invoice. Purchase -> the specific supplier just named - 
 ' only safe to copy from THAT supplier's own past invoice
 ' (partnerTemplate); a genuinely new supplier has no such invoice, so
 ' only the name is known - address left blank, never invented or
 ' borrowed from a different supplier.
 If isSales Then
 If Not anyTemplate Is Nothing Then
 ws.Cells(1, 1).Value = anyTemplate.Cells(1, 1).Value
 ws.Cells(2, 1).Value = anyTemplate.Cells(2, 1).Value
 ws.Cells(1, 1).Font.Size = anyTemplate.Cells(1, 1).Font.Size
 End If
 Else
 ws.Cells(1, 1).Value = partnerName
 If Not partnerTemplate Is Nothing Then ws.Cells(2, 1).Value = partnerTemplate.Cells(2, 1).Value
 End If
 ws.Cells(1, 1).Font.Bold = True
 ws.Cells(3, 1).Value = "INVOICE" ' matches the real reference exactly, for both directions
 ws.Cells(3, 1).Font.Bold = True
 ws.Cells(3, 1).Font.Underline = True
 ws.Cells(1, 1).HorizontalAlignment = xlCenter
 ws.Cells(2, 1).HorizontalAlignment = xlCenter
 ws.Cells(3, 1).HorizontalAlignment = xlCenter

 ' Row 4: paired section headers, matching the reference exactly.
 WriteSectionHeaderPair ws, 4, "Delivery Details", "Seller Details"

 ' Rows 5-7: Delivery Details (left, always blank - per-invoice, never
 ' known ahead of time) paired with Seller Details (right). Sales's
 ' seller is always us (anyTemplate). Purchase's seller is the named
 ' supplier - their own GSTIN/Phone only if they're a RETURNING
 ' supplier with a real past invoice (partnerTemplate); a genuinely new
 ' supplier's aren't known via this name-only InputBox workflow, so
 ' those stay blank rather than guessed or borrowed from someone else.
 WriteReferenceStyleLeft ws, 5, "Transport Mode", ""
 If isSales Then
 WriteConcatRight ws, 5, TemplateCellText(anyTemplate, 5, 4, "GSTIN : ")
 Else
 WriteConcatRight ws, 5, TemplateCellText(partnerTemplate, 5, 4, "GSTIN : ")
 End If
 WriteReferenceStyleLeft ws, 6, "Vehicle Number", ""
 WriteReferenceStyleLeft ws, 7, "Date of Supply", ""
 If isSales Then
 WriteConcatRight ws, 7, TemplateCellText(anyTemplate, 7, 4)
 Else
 WriteConcatRight ws, 7, TemplateCellText(partnerTemplate, 7, 4)
 End If

 ' Row 8: paired section headers, matching the reference exactly.
 WriteSectionHeaderPair ws, 8, "Details of Receiver / Billed to :", "Original for Recipient"

 ' Rows 9-13: the full 5-field receiver block paired with Invoice No/
 ' Date/Financial Year. Sales -> the customer just named - their own
 ' Address/GSTIN/PAN/State only if they're returning (partnerTemplate).
 ' Purchase -> our own company, the same on every Purchase invoice in
 ' this batch, safe to copy from ANY existing invoice's own
 ' (already-reversed) receiver block (anyTemplate).
 Dim displayNumber As String
 displayNumber = IIf(isSales, invoiceNumber, StripInvoicePrefixForDisplayVba(invoiceNumber))
 If isSales Then
 WriteReferenceStyleLeft ws, INV_PARTNER_ROW, "Name", partnerName
 WriteReferenceStyleRight ws, INV_PARTNER_ROW, "Invoice No", displayNumber
 WriteReferenceStyleLeft ws, 10, "Address", TemplateCellText(partnerTemplate, 10, 3)
 WriteReferenceStyleRight ws, 10, "Date", ""
 WriteReferenceStyleLeft ws, 11, "GSTIN", TemplateCellText(partnerTemplate, 11, 3, "N/A")
 Dim financialYear As String
 financialYear = ""
 If Not anyTemplate Is Nothing Then financialYear = CStr(anyTemplate.Cells(11, 4).Value)
 WriteConcatRight ws, 11, financialYear
 WriteReferenceStyleLeft ws, 12, "PAN", TemplateCellText(partnerTemplate, 12, 3)
 WriteReferenceStyleLeft ws, 13, "State", TemplateCellText(partnerTemplate, 13, 3)
 WriteConcatRight ws, 13, TemplateCellText(partnerTemplate, 13, 4)
 Else
 WriteReferenceStyleLeft ws, INV_PARTNER_ROW, "Name", TemplateCellText(anyTemplate, INV_PARTNER_ROW, 3)
 WriteReferenceStyleRight ws, INV_PARTNER_ROW, "Invoice No", displayNumber
 WriteReferenceStyleLeft ws, 10, "Address", TemplateCellText(anyTemplate, 10, 3)
 WriteReferenceStyleRight ws, 10, "Date", ""
 WriteReferenceStyleLeft ws, 11, "GSTIN", TemplateCellText(anyTemplate, 11, 3)
 WriteConcatRight ws, 11, TemplateCellText(anyTemplate, 11, 4)
 WriteReferenceStyleLeft ws, 12, "PAN", TemplateCellText(anyTemplate, 12, 3)
 WriteReferenceStyleLeft ws, 13, "State", TemplateCellText(anyTemplate, 13, 3)
 WriteConcatRight ws, 13, TemplateCellText(anyTemplate, 13, 4)
 End If

 ' Rows 14-15: the vertical product table header - same two-row merge
 ' as the generator's own INV_PRODUCT_HEADER_ROW.
 ws.Range(ws.Cells(14, 1), ws.Cells(15, 1)).Merge
 ws.Cells(14, 1).Value = "Sl." & Chr(10) & "No."
 ws.Range(ws.Cells(14, 2), ws.Cells(15, 3)).Merge
 ws.Cells(14, 2).Value = "Name of the Product / Service"
 ws.Range(ws.Cells(14, 4), ws.Cells(15, 4)).Merge
 ws.Cells(14, 4).Value = "HSN/ ACS"
 ws.Range(ws.Cells(14, 5), ws.Cells(15, 5)).Merge
 ws.Cells(14, 5).Value = "Qty in KG"
 ws.Range(ws.Cells(14, 6), ws.Cells(14, 7)).Merge
 ws.Cells(14, 6).Value = "Rate Per KG"
 ws.Range(ws.Cells(15, 6), ws.Cells(15, 7)).Merge
 ws.Cells(15, 6).Value = "Rs."
 ws.Range(ws.Cells(14, 8), ws.Cells(15, 8)).Merge
 ws.Cells(14, 8).Value = "Total Amount"
 Dim hc As Long
 For hc = 1 To 8
 ws.Cells(14, hc).Font.Bold = True
 ws.Cells(15, hc).Font.Bold = True
 Next hc

 ' Rows 16+: MIN_PRODUCT_ROWS_VBA blank product rows, every one already
 ' carrying its own live Total Amount formula - a new product is typed
 ' straight into the next blank row, exactly like a freshly generated,
 ' zero-product invoice from SummaryWorkbookService.ts.
 Dim pr As Long, r As Long
 For pr = 0 To MIN_PRODUCT_ROWS_VBA - 1
 r = INV_PRODUCT_DATA_ROW + pr
 ws.Range(ws.Cells(r, 2), ws.Cells(r, 3)).Merge
 ws.Range(ws.Cells(r, 6), ws.Cells(r, 7)).Merge
 ws.Cells(r, 8).Formula = "=IF(AND(E" & r & "<>"""",F" & r & "<>""""),E" & r & "*F" & r & ","""")"
 Next pr

 ' Total row.
 ws.Range(ws.Cells(TOTAL_ROW_VBA, 1), ws.Cells(TOTAL_ROW_VBA, 7)).Merge
 ws.Cells(TOTAL_ROW_VBA, 1).Value = "Total"
 ws.Cells(TOTAL_ROW_VBA, 1).Font.Bold = True
 ws.Cells(TOTAL_ROW_VBA, 8).Formula = "=SUM(H" & INV_PRODUCT_DATA_ROW & ":H" & LastProductRowVba() & ")"
 ws.Cells(TOTAL_ROW_VBA, 8).Font.Bold = True

 ' Goods Dispatched / Total Amount Before Tax.
 ws.Range(ws.Cells(GOODS_DISPATCHED_ROW_VBA, 1), ws.Cells(GOODS_DISPATCHED_ROW_VBA, 3)).Merge
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 1).Value = ChrW(&H2705) & " GOODS DISPATCHED"
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 1).Font.Bold = True
 ws.Range(ws.Cells(GOODS_DISPATCHED_ROW_VBA, 4), ws.Cells(GOODS_DISPATCHED_ROW_VBA, 5)).Merge
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 4).Value = "Total Amount Before Tax"
 ws.Range(ws.Cells(GOODS_DISPATCHED_ROW_VBA, 6), ws.Cells(GOODS_DISPATCHED_ROW_VBA, 7)).Merge
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 6).Value = "Rs."
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 8).Formula = "=H" & TOTAL_ROW_VBA
 ws.Cells(GOODS_DISPATCHED_ROW_VBA, 8).Font.Bold = True

 ' Rupees in words (spans 2 rows) / CGST, then SGST on the row below.
 Dim sgstRow As Long, bankHeaderRow As Long
 sgstRow = AMOUNT_IN_WORDS_ROW + 1
 bankHeaderRow = BANK_DETAILS_HEADER_ROW_VBA
 ws.Range(ws.Cells(AMOUNT_IN_WORDS_ROW, 1), ws.Cells(sgstRow, 3)).Merge
 ws.Cells(AMOUNT_IN_WORDS_ROW, 1).Value = "Rupees in words: " & NumberToWordsVba(0)
 ws.Range(ws.Cells(AMOUNT_IN_WORDS_ROW, 4), ws.Cells(AMOUNT_IN_WORDS_ROW, 5)).Merge
 ws.Cells(AMOUNT_IN_WORDS_ROW, 4).Value = "Add : CGST*"
 ws.Range(ws.Cells(AMOUNT_IN_WORDS_ROW, 6), ws.Cells(AMOUNT_IN_WORDS_ROW, 7)).Merge
 ws.Cells(AMOUNT_IN_WORDS_ROW, 6).Value = "Rs."
 ws.Cells(AMOUNT_IN_WORDS_ROW, 8).Value = "Nil"
 ws.Range(ws.Cells(sgstRow, 4), ws.Cells(sgstRow, 5)).Merge
 ws.Cells(sgstRow, 4).Value = "Add : SGST*"
 ws.Range(ws.Cells(sgstRow, 6), ws.Cells(sgstRow, 7)).Merge
 ws.Cells(sgstRow, 6).Value = "Rs."
 ws.Cells(sgstRow, 8).Value = "Nil"

 ' Company's Bank Details header / Total Amount After GST. Purchase
 ' invoices get zero labels here - just bordered blank boxes, matching
 ' SummaryWorkbookService.ts's own isSales-gated bank-details section.
 If isSales Then
 ws.Cells(bankHeaderRow, 1).Value = "Company's Bank Details :"
 ws.Cells(bankHeaderRow, 1).Font.Bold = True
 End If
 ws.Range(ws.Cells(bankHeaderRow, 4), ws.Cells(bankHeaderRow, 5)).Merge
 ws.Cells(bankHeaderRow, 4).Value = "Total Amount After GST"
 ws.Range(ws.Cells(bankHeaderRow, 6), ws.Cells(bankHeaderRow, 7)).Merge
 ws.Cells(bankHeaderRow, 6).Value = "Rs."
 ws.Cells(bankHeaderRow, 8).Formula = "=H" & GOODS_DISPATCHED_ROW_VBA
 ws.Cells(bankHeaderRow, 8).Font.Bold = True

 ' Bank detail rows paired with Forwarding/Postage/Other charges/
 ' Rounded off, then IFSC paired with the Net Total formula.
 Dim bankLabels(0 To 5) As String, chargeLabels(0 To 3) As String
 bankLabels(0) = "Name of Account": bankLabels(1) = "Name of Bank": bankLabels(2) = "Branch Name"
 bankLabels(3) = "Account No.": bankLabels(4) = "IFSC Code": bankLabels(5) = "PAN"
 chargeLabels(0) = "Forwarding": chargeLabels(1) = "Postage"
 chargeLabels(2) = "Other charges if any": chargeLabels(3) = "Ps.Rounded Off"
 Dim bankRow As Long, bankCellRow As Long
 For bankRow = 0 To 5
 bankCellRow = BANK_DETAILS_NAME_OF_ACCOUNT_ROW + bankRow
 If isSales Then
 ws.Cells(bankCellRow, 1).Value = bankLabels(bankRow)
 ws.Cells(bankCellRow, 1).Font.Bold = True
 ws.Cells(bankCellRow, 2).Value = ":"
 ' Prompt 16: Batch Overview's bank-detail rows moved from 4-9
 ' to 7-12 (its own hero-cards redesign pushed them down).
 ws.Cells(bankCellRow, 3).Formula = "='" & BATCH_OVERVIEW_SHEET_NAME_VBA & "'!C" & (7 + bankRow)
 Else
 ws.Cells(bankCellRow, 3).Value = "" ' section 12 - always blank for Purchase
 End If
 If bankRow <= 3 Then
 ws.Range(ws.Cells(bankCellRow, 4), ws.Cells(bankCellRow, 5)).Merge
 ws.Cells(bankCellRow, 4).Value = chargeLabels(bankRow)
 ws.Range(ws.Cells(bankCellRow, 6), ws.Cells(bankCellRow, 7)).Merge
 ws.Cells(bankCellRow, 6).Value = "Rs."
 ws.Cells(bankCellRow, 8).Value = 0
 End If
 Next bankRow

 ' Net Total, on the IFSC Code row.
 ws.Range(ws.Cells(BANK_DETAILS_IFSC_ROW, 4), ws.Cells(BANK_DETAILS_IFSC_ROW, 7)).Merge
 ws.Cells(BANK_DETAILS_IFSC_ROW, 4).Value = "Net Total"
 ws.Cells(BANK_DETAILS_IFSC_ROW, 4).Font.Bold = True
 ws.Cells(BANK_DETAILS_IFSC_ROW, 8).Formula = "=H" & bankHeaderRow & "+H" & BANK_DETAILS_NAME_OF_ACCOUNT_ROW & _
 "+H" & (BANK_DETAILS_NAME_OF_ACCOUNT_ROW + 1) & "+H" & (BANK_DETAILS_NAME_OF_ACCOUNT_ROW + 2) & "+H" & (BANK_DETAILS_NAME_OF_ACCOUNT_ROW + 3)
 ws.Cells(BANK_DETAILS_IFSC_ROW, 8).Font.Bold = True

 Dim panRow As Long, termsRow As Long, certRowEnd As Long
 panRow = BANK_DETAILS_IFSC_ROW + 1
 ws.Range(ws.Cells(panRow, 4), ws.Cells(panRow, 8)).Merge

 ' Terms & Conditions (left) / Certification (right).
 termsRow = CERTIFICATION_TERMS_ROW_VBA
 certRowEnd = termsRow + 3
 ws.Range(ws.Cells(termsRow, 1), ws.Cells(certRowEnd, 4)).Merge
 ws.Cells(termsRow, 1).Value = "Terms & Conditions :" & Chr(10) & _
 "1. Interest @ 24% p.a. Will be charged for overdue bills (more than 30 days)." & Chr(10) & _
 "2. All disputes are subject to Chennai Jurisdiction"
 ws.Range(ws.Cells(termsRow, 5), ws.Cells(certRowEnd, 8)).Merge
 Dim certName As String
 certName = IIf(isSales, TemplateCellText(anyTemplate, 1, 1), partnerName)
 ws.Cells(termsRow, 5).Value = CertificationText(certName)

 Set BuildBlankInvoiceSheet = ws
End Function

' --------------------------- Add Product dropdown ---------------------------
' A fixed pair of cells, column 9 (past the invoice's own 8-column layout
' - the same area the Home link at row 1 sits in), applied to EVERY
' invoice sheet by EnsureAddProductControls, called for every sheet from
' ThisWorkbook.RegisterInvoiceSheetWatcher (both at file-open, via
' Workbook_Open/ActivateSync, and right after a brand-new invoice sheet
' is created) - so this works uniformly whether the sheet was built by
' SummaryWorkbookService.ts or BuildBlankInvoiceSheet, with no separate
' TS-side implementation needed. (Its own Const declarations are grouped
' with all the others at the top of the module, not here.)

' Applies a Data Validation rule that rejects every possible entry, with
' a custom message - the standard Excel technique for "this cell can be
' read but never typed into", without Sheet Protection (which would also
' have to fight every OTHER cell on the sheet that needs to stay
' editable). Deliberately swallows any error: called from
' LockDerivedTotalColumns, which itself must never be the reason a file
' fails to open (see that Sub's own note).
Private Sub LockRangeAgainstEditing(rng As Range)
 On Error Resume Next
 rng.Validation.Delete
 rng.Validation.Add Type:=xlValidateCustom, AlertStyle:=xlValidAlertStop, Formula1:="=FALSE"
 rng.Validation.ErrorTitle = "Read-only"
 rng.Validation.ErrorMessage = "This is a calculated total - it can't be edited directly."
 On Error GoTo 0
End Sub

' Locks Purchase/Sales Summary's per-block "Total Price" columns and
' Product Summary's "Total Amount" column against direct editing - both
' are always derived (Qty*Rate, or a live SUMIF), never a real entry
' point (Product Summary's "Total Quantity" column deliberately stays
' editable - that's the one designed redistribution trigger). Applied to
' a generous fixed row range (not just currently-used rows) so a row
' inserted later - AppendInvoiceListRow/AppendProductSummaryRow - lands
' inside the already-validated range and inherits the lock the same way
' it inherits borders/number formats from an Insert.
'
' Called once from ThisWorkbook.ActivateSync, not per-sheet like
' EnsureAddProductControls - this operates on the two summary sheets
' directly, not every invoice sheet. Wrapped in On Error Resume Next
' throughout deliberately: this is a cosmetic safety feature, and must
' never be the reason ActivateSync - which every real batch file's
' Workbook_Open depends on - fails partway through on a file that
' happens to be missing one of these sheets (e.g. the master template
' itself, which has neither Purchase/Sales Summary nor Product Summary).
Public Sub LockDerivedTotalColumns()
 On Error Resume Next

 Dim listWs As Worksheet
 Set listWs = InvoiceListSheet()
 If Not listWs Is Nothing Then
 Dim tailStartCol As Long
 tailStartCol = InvoiceAmountColumnOnSummary(listWs)
 If tailStartCol > PS_PRODUCT_BLOCK_START_COL Then
 Dim numBlocks As Long, i As Long
 numBlocks = (tailStartCol - PS_PRODUCT_BLOCK_START_COL) \ 4
 For i = 0 To numBlocks - 1
 Dim totalPriceCol As Long
 totalPriceCol = PS_PRODUCT_BLOCK_START_COL + i * 4 + 3
 LockRangeAgainstEditing listWs.Range(listWs.Cells(PS_DATA_START_ROW, totalPriceCol), listWs.Cells(5000, totalPriceCol))
 Next i
 End If
 End If

 Dim prodWs As Worksheet
 Set prodWs = ProductSummarySheet()
 If Not prodWs Is Nothing Then
 LockRangeAgainstEditing prodWs.Range(prodWs.Cells(PR_DATA_START_ROW, PR_COL_AMOUNT), prodWs.Cells(5000, PR_COL_AMOUNT))
 End If

 On Error GoTo 0
End Sub

' Idempotent - safe to call repeatedly (every file open re-applies the
' same validation/labels to every sheet). Skips summary sheets entirely.
Public Sub EnsureAddProductControls(ws As Worksheet)
 If IsSummarySheet(ws) Then Exit Sub

 ' Every write below is styling/setup, never a real user edit - but
 ' without suppressing events it fires this very sheet's own Change
 ' handler immediately and re-entrantly (discovered when opening the
 ' master template directly, which has no real Purchase/Sales Summary
 ' sheet for that handler to look up, and crashed on exactly this).
 Application.EnableEvents = False

 Dim pickCell As Range, newCell As Range
 Set pickCell = ws.Cells(ADD_PRODUCT_TRIGGER_ROW, ADD_PRODUCT_TRIGGER_COL)
 Set newCell = ws.Cells(ADD_NEW_PRODUCT_TRIGGER_ROW, ADD_NEW_PRODUCT_TRIGGER_COL)

 On Error Resume Next
 pickCell.Validation.Delete
 ' A dynamic exact-fit range (no blank trailing rows in the dropdown) - 
 ' OFFSET/COUNTA are standard, well-supported functions, unlike the
 ' .End(xlToLeft) navigation that proved unreliable elsewhere on this
 ' build (see FindColumnByHeader's own note).
 pickCell.Validation.Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
 Formula1:="=OFFSET('" & SHEET_PRODUCT_SUMMARY & "'!$A$" & PR_DATA_START_ROW & _
 ",0,0,MAX(COUNTA('" & SHEET_PRODUCT_SUMMARY & "'!$A$" & PR_DATA_START_ROW & ":$A$1000)-1,1),1)"
 On Error GoTo 0
 pickCell.Value = ADD_PRODUCT_PLACEHOLDER
 pickCell.Font.Bold = True
 pickCell.Font.Color = RGB(27, 94, 32)
 pickCell.Interior.Color = RGB(223, 245, 225)
 pickCell.Borders.LineStyle = xlContinuous
 pickCell.Borders.Weight = xlThin
 pickCell.HorizontalAlignment = xlCenter
 pickCell.VerticalAlignment = xlCenter
 ws.Rows(ADD_PRODUCT_TRIGGER_ROW).RowHeight = 20
 ws.Columns(ADD_PRODUCT_TRIGGER_COL).ColumnWidth = 24

 newCell.Value = ADD_NEW_PRODUCT_LABEL
 newCell.Font.Bold = True
 newCell.Font.Color = RGB(27, 94, 32)
 newCell.Interior.Color = RGB(223, 245, 225)
 newCell.Borders.LineStyle = xlContinuous
 newCell.Borders.Weight = xlThin
 newCell.HorizontalAlignment = xlCenter
 newCell.VerticalAlignment = xlCenter
 ws.Rows(ADD_NEW_PRODUCT_TRIGGER_ROW).RowHeight = 20

 Application.EnableEvents = True
End Sub

' Finds an existing product by exact Name match - returns True and its
' Product ID/HSN if found. (AppendProductSummaryRow - the (productId,
' name, hsn) one, above - already exists for CREATING a new row; this
' feature only needed a name-based lookup on top of it.)
Private Function FindProductByName(productName As String, ByRef productId As String, ByRef hsn As String) As Boolean
 Dim ws As Worksheet, n As Long, r As Long
 Set ws = ProductSummarySheet()
 n = ProductSummaryRowCount()
 For r = PR_DATA_START_ROW To PR_DATA_START_ROW + n - 1
 If CStr(ws.Cells(r, PR_COL_NAME).Value) = productName Then
 productId = CStr(ws.Cells(r, PR_COL_PRODUCT_ID).Value)
 hsn = CStr(ws.Cells(r, PR_COL_HSN).Value)
 FindProductByName = True
 Exit Function
 End If
 Next r
 FindProductByName = False
End Function

' Finds this invoice's next blank product row (Name cell empty). Returns
' 0 (and warns) if every row already has a product.
Private Function NextBlankProductRow(ws As Worksheet) As Long
 Dim r As Long
 For r = INV_PRODUCT_DATA_ROW To LastProductRowVba()
 If Trim(CStr(ws.Cells(r, 2).Value)) = "" Then
 NextBlankProductRow = r
 Exit Function
 End If
 Next r
 NextBlankProductRow = 0
 MsgBox "No blank product row left on this invoice - every row already has a product.", vbExclamation
End Function

' Places productId/name/hsn into this invoice's next blank product row
' AND links it into _hidden_invoice_data - without that link,
' HandleInvoiceLineEdit's own documented behavior for a genuinely blank
' row ("wasn't part of the batch at generation time") skips every
' cross-sync step, which would silently defeat the whole point of this
' feature. Qty/Rate start blank - the user types those directly, exactly
' like any other product row, and that edit's own normal Change event
' carries them the rest of the way through the existing sync.
Private Sub PlaceProductOnInvoice(ws As Worksheet, productId As String, productName As String, hsn As String)
 Dim r As Long
 r = NextBlankProductRow(ws)
 If r = 0 Then Exit Sub

 Dim batchId As String, invoiceId As String, invNum As String, partnerId As String, partnerName As String
 GetSheetIdentity ws, batchId, invoiceId, invNum, partnerId, partnerName

 gSyncInProgress = True
 Application.EnableEvents = False
 ws.Cells(r, 2).Value = productName
 ws.Cells(r, 4).Value = hsn
 AppendHiddenDataRow batchId, invoiceId, invNum, productId, productName, hsn, "", 0, 0, 0, _
 partnerId, partnerName, ws.Name, r - INV_PRODUCT_DATA_ROW
 Application.EnableEvents = True
 gSyncInProgress = False

 HandleInvoiceLineEdit ws, r
End Sub

' Entry point for the "+ ADD NEW PRODUCT" trigger cell (row 3, col 9) - 
' fired from Sheet_SelectionChange, same click pattern as "+ ADD NEW
' INVOICE". Prompts for a name, creates it in Product Summary (via the
' existing AppendProductSummaryRow above), places it into this invoice's
' next blank product row.
Public Sub AddNewProductToCurrentInvoice(ws As Worksheet)
 If IsSummarySheet(ws) Then Exit Sub

 Dim rawName As Variant
 rawName = Application.InputBox("New product name:", "Add New Product", Type:=2)
 If VarType(rawName) = vbBoolean Then Exit Sub ' cancelled - no changes made
 Dim productName As String
 productName = Trim(CStr(rawName))
 If productName = "" Then Exit Sub

 Dim newId As String
 newId = "WBLOCAL-PRODUCT-" & Format(Now, "yyyymmddhhnnss") & "-" & (ProductSummaryRowCount() + 1)

 gSyncInProgress = True
 Application.EnableEvents = False
 AppendProductSummaryRow newId, productName, ""
 Application.EnableEvents = True
 gSyncInProgress = False

 PlaceProductOnInvoice ws, newId, productName, ""
End Sub

' Section 1: the full "+ ADD NEW INVOICE" workflow.
Public Sub AddNewInvoice()
 If gSyncInProgress Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim listWs As Worksheet
 Set listWs = InvoiceListSheet()
 Dim isSales As Boolean
 isSales = (listWs.Name = SHEET_SALES_SUMMARY)
 Dim partnerLabel As String
 partnerLabel = IIf(isSales, "Customer", "Supplier")

 Dim n As Long
 n = InvoiceListRowCount()
 Dim lastNumber As String
 lastNumber = ""
 ' Prompt 6 (latest revision): sourced from _hidden_invoice_data's FULL
 ' number, never from listWs's own column1 - that's now display-only
 ' (prefix-stripped) text for Purchase and would permanently corrupt
 ' the real prefix pattern for every subsequently-added invoice.
 If n > 0 Then lastNumber = FullInvoiceNumberForRow(PS_DATA_START_ROW + n - 1)
 Dim newNumber As String
 newNumber = NextInvoiceNumberVba(lastNumber)

 Dim rawName As Variant
 rawName = Application.InputBox(partnerLabel & " name (existing or new):", "Add New Invoice", Type:=2)
 If VarType(rawName) = vbBoolean Then GoTo CleanFail ' cancelled - no changes made
 Dim partnerName As String
 partnerName = Trim(CStr(rawName))
 If partnerName = "" Then GoTo CleanFail

 Dim partnerId As String, isNewPartner As Boolean
 Dim existingPartnerRow As Long
 existingPartnerRow = FindPartnerSummaryRowByName(partnerName)
 If existingPartnerRow > 0 Then
 partnerId = CStr(PartnerSummarySheet().Cells(existingPartnerRow, PT_COL_PARTNER_ID).Value)
 partnerName = CStr(PartnerSummarySheet().Cells(existingPartnerRow, PT_COL_NAME).Value)
 isNewPartner = False
 Else
 partnerId = "WBLOCAL-PARTNER-" & Format(Now, "yyyymmddhhnnss") & "-" & (PartnerSummaryRowCount() + 1)
 isNewPartner = True
 End If

 Dim usedNames As New Collection
 Dim wsExisting As Worksheet
 For Each wsExisting In ThisWorkbook.Worksheets
 AddUnique usedNames, UCase(wsExisting.Name)
 Next wsExisting
 Dim sheetName As String
 ' Sheet tab = exactly the invoice number as displayed everywhere else
 ' (prefix-stripped for Purchase, full for Sales) - never the internal
 ' full number with its abbreviation prefix.
 sheetName = SafeSheetNameVba(IIf(isSales, newNumber, StripInvoicePrefixForDisplayVba(newNumber)), usedNames)

 Dim newWs As Worksheet
 Set newWs = BuildBlankInvoiceSheet(sheetName, isSales, newNumber, partnerLabel, partnerName, partnerId)

 Dim invoiceId As String
 invoiceId = "WBLOCAL-INV-" & Format(Now, "yyyymmddhhnnss") & "-" & (n + 1)
 Dim batchId As String
 batchId = CurrentBatchId()

 AppendInvoiceListRow newNumber, isSales, invoiceId, partnerId, partnerName, sheetName
 ' Sentinel row (zero products so far) - the same pattern the generator
 ' already uses for a product-less invoice, so GetSheetIdentity works
 ' immediately for this brand-new sheet.
 AppendHiddenDataRow batchId, invoiceId, newNumber, "", "", "", "", 0, 0, 0, partnerId, partnerName, sheetName, -1

 If isNewPartner Then AppendPartnerSummaryRow partnerId, partnerName

 ThisWorkbook.RegisterInvoiceSheetWatcher newWs

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub


' --------------------------- Prompt 5: invoice renumbering ---------------------

' Same trailing-digit-preserving renumbering as nextInvoiceNumber() /
' formatInvoiceNumber() in WorkbookSyncEngine.ts.
Private Function ExtractTrailingDigits(invoiceNumber As String, ByRef prefix As String, ByRef width As Long) As Long
 Dim i As Long
 i = Len(invoiceNumber)
 Do While i > 0 And Mid(invoiceNumber, i, 1) >= "0" And Mid(invoiceNumber, i, 1) <= "9"
 i = i - 1
 Loop
 If i = Len(invoiceNumber) Then
 ExtractTrailingDigits = -1 ' no trailing digits at all
 Exit Function
 End If
 prefix = Left(invoiceNumber, i)
 Dim digits As String
 digits = Mid(invoiceNumber, i + 1)
 width = Len(digits)
 ExtractTrailingDigits = CLng(digits)
End Function

Private Function FormatInvoiceNumberVba(invoiceNumber As String, newSequence As Long) As String
 Dim prefix As String, width As Long
 Dim value As Long
 value = ExtractTrailingDigits(invoiceNumber, prefix, width)
 If value = -1 Then
 FormatInvoiceNumberVba = invoiceNumber
 Exit Function
 End If
 FormatInvoiceNumberVba = prefix & Format(newSequence, String(width, "0"))
End Function

Private Function NextInvoiceNumberVba(lastInvoiceNumber As String) As String
 If lastInvoiceNumber = "" Then
 NextInvoiceNumberVba = "INV-0000001"
 Exit Function
 End If
 Dim prefix As String, width As Long
 Dim value As Long
 value = ExtractTrailingDigits(lastInvoiceNumber, prefix, width)
 If value = -1 Then
 NextInvoiceNumberVba = lastInvoiceNumber & "-2"
 Exit Function
 End If
 NextInvoiceNumberVba = FormatInvoiceNumberVba(lastInvoiceNumber, value + 1)
End Function

' Section 2/3/4: reassigns every remaining invoice's display Invoice
' Number to a gap-free 1..N sequence, in Purchase/Sales Summary's current
' top-to-bottom row order. Invoice IDs are never touched - only display
' text (Invoice Number, sheet name) changes. Uses a two-phase rename
' (every sheet to a unique temp name FIRST, then every temp name to its
' final name) so no intermediate collision is ever possible (section 4).
Public Sub RenumberAllInvoices()
 Dim listWs As Worksheet, hws As Worksheet
 Set listWs = InvoiceListSheet()
 Set hws = HiddenDataSheet()
 Dim isSales As Boolean
 isSales = (listWs.Name = SHEET_SALES_SUMMARY)
 Dim n As Long
 n = InvoiceListRowCount()
 If n = 0 Then Exit Sub

 Dim oldSheetNames() As String, newNumbers() As String, newSheetNames() As String, tempSheetNames() As String
 ReDim oldSheetNames(1 To n)
 ReDim newNumbers(1 To n)
 ReDim newSheetNames(1 To n)
 ReDim tempSheetNames(1 To n)

 Dim usedNames As New Collection
 Dim wsAll As Worksheet
 For Each wsAll In ThisWorkbook.Worksheets
 AddUnique usedNames, UCase(wsAll.Name)
 Next wsAll

 Dim r As Long, i As Long
 For i = 1 To n
 r = PS_DATA_START_ROW + i - 1
 Dim curNumber As String
 ' Prompt 6 (latest revision): Purchase Summary's own column now
 ' DISPLAYS the prefix-stripped number for Purchase, so it can no
 ' longer be used as the basis for renumbering math (that would
 ' permanently lose the real prefix after the first renumber).
 ' _hidden_invoice_data always keeps the FULL real number - that is
 ' the one true source for this computation, for both batch types.
 curNumber = FullInvoiceNumberForRow(r)
 oldSheetNames(i) = SheetNameForInvoiceRow(r)
 newNumbers(i) = FormatInvoiceNumberVba(curNumber, i)
 Next i

 ' Phase 1: every affected sheet to a unique temporary name.
 For i = 1 To n
 If oldSheetNames(i) <> "" Then
 Dim tempName As String
 tempName = "__tmp_renum_" & i
 On Error Resume Next
 ThisWorkbook.Worksheets(oldSheetNames(i)).Name = tempName
 On Error GoTo 0
 tempSheetNames(i) = tempName
 End If
 Next i

 ' Phase 2: temp names to final, collision-free names.
 Dim finalUsed As New Collection
 AddUnique finalUsed, UCase(SHEET_PURCHASE_SUMMARY)
 AddUnique finalUsed, UCase(SHEET_SALES_SUMMARY)
 AddUnique finalUsed, UCase(SHEET_SUPPLIER_SUMMARY)
 AddUnique finalUsed, UCase(SHEET_CUSTOMER_SUMMARY)
 AddUnique finalUsed, UCase(SHEET_PRODUCT_SUMMARY)
 AddUnique finalUsed, UCase(SHEET_HIDDEN_DATA)
 For i = 1 To n
 If tempSheetNames(i) <> "" Then
 ' Sheet tab = exactly the invoice number as displayed everywhere
 ' else (prefix-stripped for Purchase, full for Sales) - never
 ' the internal full number with its abbreviation prefix.
 Dim sheetNumberForTab As String
 sheetNumberForTab = IIf(isSales, newNumbers(i), StripInvoicePrefixForDisplayVba(newNumbers(i)))
 newSheetNames(i) = SafeSheetNameVba(sheetNumberForTab, finalUsed)
 On Error Resume Next
 ThisWorkbook.Worksheets(tempSheetNames(i)).Name = newSheetNames(i)
 On Error GoTo 0
 End If
 Next i

 ' Update Purchase/Sales Summary's own Invoice Number cell, the
 ' invoice sheet's own visible Invoice Number cell, and every matching
 ' _hidden_invoice_data row's InvoiceNumber/SheetName columns.
 Dim hLastRow As Long
 hLastRow = HiddenDataLastRow()
 For i = 1 To n
 r = PS_DATA_START_ROW + i - 1
 ' Prompt 6 (latest revision): Purchase Summary's own column is now
 ' ALSO the prefix-stripped display number, same as the invoice
 ' sheet - only _hidden_invoice_data (below) keeps the full, real
 ' number, which is never user-facing and is the one source the
 ' renumbering math above is based on.
 If isSales Then
 listWs.Cells(r, 1).Value = newNumbers(i)
 Else
 listWs.Cells(r, 1).Value = StripInvoicePrefixForDisplayVba(newNumbers(i))
 End If

 If newSheetNames(i) <> "" Then
 Dim invWs As Worksheet
 Set invWs = Nothing
 On Error Resume Next
 Set invWs = ThisWorkbook.Worksheets(newSheetNames(i))
 On Error GoTo 0
 If Not invWs Is Nothing Then
 If isSales Then
 invWs.Cells(INV_INVOICE_NUMBER_ROW, INV_INVOICE_NUMBER_VALUE_COL).Value = newNumbers(i)
 Else
 invWs.Cells(INV_INVOICE_NUMBER_ROW, INV_INVOICE_NUMBER_VALUE_COL).Value = StripInvoicePrefixForDisplayVba(newNumbers(i))
 End If
 End If

 Dim hr As Long
 For hr = HID_DATA_START_ROW To hLastRow
 If CStr(hws.Cells(hr, HID_COL_SHEET_NAME).Value) = tempSheetNames(i) Or _
 CStr(hws.Cells(hr, HID_COL_SHEET_NAME).Value) = oldSheetNames(i) Then
 hws.Cells(hr, HID_COL_INVOICE_NUMBER).Value = newNumbers(i)
 hws.Cells(hr, HID_COL_SHEET_NAME).Value = newSheetNames(i)
 End If
 Next hr
 End If
 Next i

 ' Prompt 11: Purchase/Sales Summary's own Invoice Amount is now a
 ' same-row SUMIF over that row's own product-block cells (section 7)
 ' - it never references an invoice sheet by name, so renaming sheets
 ' during renumbering needs no formula rewrite here any more (this used
 ' to rewrite a cross-sheet INDEX/MATCH formula; that formula no longer
 ' exists).

 Application.Calculate
End Sub

' Finds the invoice sheet name for a given Purchase/Sales Summary row via
' its hidden Invoice ID, by cross-referencing _hidden_invoice_data.
Private Function SheetNameForInvoiceRow(r As Long) As String
 Dim listWs As Worksheet, hws As Worksheet, invoiceId As String, hr As Long, lastRow As Long
 Set listWs = InvoiceListSheet()
 Set hws = HiddenDataSheet()
 invoiceId = CStr(listWs.Cells(r, InvoiceIdColumn(listWs)).Value)
 lastRow = HiddenDataLastRow()
 For hr = HID_DATA_START_ROW To lastRow
 If CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value) = invoiceId Then
 SheetNameForInvoiceRow = CStr(hws.Cells(hr, HID_COL_SHEET_NAME).Value)
 Exit Function
 End If
 Next hr
 SheetNameForInvoiceRow = ""
End Function

' Finds the FULL, real (never display-stripped) invoice number for a given
' Purchase/Sales Summary row, by cross-referencing _hidden_invoice_data via
' its hidden Invoice ID - the one true source for renumbering/next-number
' math, since Purchase Summary's own column1 is now display-only text
' (Prompt 6, latest revision).
Private Function FullInvoiceNumberForRow(r As Long) As String
 Dim listWs As Worksheet, hws As Worksheet, invoiceId As String, hr As Long, lastRow As Long
 Set listWs = InvoiceListSheet()
 Set hws = HiddenDataSheet()
 invoiceId = CStr(listWs.Cells(r, InvoiceIdColumn(listWs)).Value)
 lastRow = HiddenDataLastRow()
 For hr = HID_DATA_START_ROW To lastRow
 If CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value) = invoiceId Then
 FullInvoiceNumberForRow = CStr(hws.Cells(hr, HID_COL_INVOICE_NUMBER).Value)
 Exit Function
 End If
 Next hr
 FullInvoiceNumberForRow = ""
End Function


' --------------------------- Prompt 5: invoice deletion ------------------------

' Section 3: deletes one invoice by its stable Invoice ID, then renumbers
' the remaining ones. Product/Partner Summary totals need no separate
' recalculation step (section 8) - their SUMIF/COUNTIF formulas already
' read live from _hidden_invoice_data / Purchase Summary, which just lost
' this invoice's rows, so they recompute correctly the moment
' Application.Calculate runs. Master rows whose total becomes zero are
' deliberately left in place (section 8's own explicit instruction).
Public Sub DeleteInvoiceByStableId(invoiceId As String)
 If gSyncInProgress Then Exit Sub
 If invoiceId = "" Then Exit Sub
 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim listWs As Worksheet, hws As Worksheet
 Set listWs = InvoiceListSheet()
 Set hws = HiddenDataSheet()

 Dim r As Long
 r = FindInvoiceListRowByInvoiceId(invoiceId)
 If r = 0 Then GoTo CleanFail

 Dim sheetName As String
 sheetName = SheetNameForInvoiceRow(r)

 If sheetName <> "" Then
 On Error Resume Next
 Dim delWs As Worksheet
 Set delWs = ThisWorkbook.Worksheets(sheetName)
 If Not delWs Is Nothing Then
 Application.DisplayAlerts = False
 delWs.Delete
 Application.DisplayAlerts = True
 End If
 On Error GoTo CleanFail
 End If

 listWs.Rows(r).Delete

 ' Delete every _hidden_invoice_data row for this invoice, bottom-to-top
 ' so deleting a row never shifts the index of a row not yet visited.
 Dim hr As Long, lastRow As Long
 lastRow = HiddenDataLastRow()
 For hr = lastRow To HID_DATA_START_ROW Step -1
 If CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value) = invoiceId Then
 hws.Rows(hr).Delete
 End If
 Next hr

 RenumberAllInvoices

 Application.Calculate
CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' Section 5 (revised): deletion is no longer a trigger cell - the user
' just deletes the invoice's row directly in Purchase/Sales Summary, or
' deletes the invoice's own sheet tab. Both are handled below:
' ReconcileDeletedInvoiceRows (called from HandleInvoiceListRowChange,
' below) catches a row deletion the moment the summary sheet changes;
' HandleInvoiceSheetBeforeDelete (called from ThisWorkbook's
' Workbook_SheetBeforeDelete) catches a sheet-tab deletion immediately,
' before Excel finishes removing it.

' Detects any invoice whose stable Invoice ID no longer appears anywhere
' in the summary sheet (its row was deleted directly) - cleans up its
' invoice sheet + every _hidden_invoice_data row, then renumbers what's
' left. Returns True if it found and cleaned up at least one deletion, so
' the caller can skip re-interpreting the same Target range as a normal
' per-cell product edit.
Public Function ReconcileDeletedInvoiceRows(listWs As Worksheet) As Boolean
 ReconcileDeletedInvoiceRows = False
 Dim idCol As Long
 idCol = InvoiceIdColumn(listWs)
 If idCol = 0 Then Exit Function

 Dim stillPresent As New Collection
 Dim n As Long, r As Long
 n = InvoiceListRowCount()
 For r = PS_DATA_START_ROW To PS_DATA_START_ROW + n - 1
 Dim idVal As String
 idVal = CStr(listWs.Cells(r, idCol).Value)
 If idVal <> "" Then AddUnique stillPresent, idVal
 Next r

 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 Dim lastRow As Long
 lastRow = HiddenDataLastRow()
 Dim toDelete As New Collection
 Dim hr As Long
 For hr = HID_DATA_START_ROW To lastRow
 Dim hId As String
 hId = CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value)
 If hId <> "" Then
 Dim found As Boolean, itm As Variant
 found = False
 For Each itm In stillPresent
 If CStr(itm) = hId Then found = True: Exit For
 Next itm
 If Not found Then AddUnique toDelete, hId
 End If
 Next hr

 If toDelete.Count = 0 Then Exit Function

 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim delId As Variant
 For Each delId In toDelete
 RemoveInvoiceArtifacts CStr(delId)
 Next delId

 RenumberAllInvoices
 Application.Calculate
 ReconcileDeletedInvoiceRows = True

CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Function

' Deletes the invoice sheet (if it still exists) and every
' _hidden_invoice_data row for the given stable Invoice ID - the shared
' cleanup step both the row-reconciliation path above and the
' sheet-tab-deletion path below reduce to. Does NOT touch the Purchase/
' Sales Summary row or renumbering - callers are responsible for both,
' since the two call sites need them at different times (before vs. the
' row is already gone).
Private Sub RemoveInvoiceArtifacts(invoiceId As String)
 Dim hws As Worksheet
 Set hws = HiddenDataSheet()
 Dim sheetNm As String
 sheetNm = ""
 Dim hr As Long
 For hr = HID_DATA_START_ROW To HiddenDataLastRow()
 If CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value) = invoiceId Then
 sheetNm = CStr(hws.Cells(hr, HID_COL_SHEET_NAME).Value)
 Exit For
 End If
 Next hr

 If sheetNm <> "" Then
 On Error Resume Next
 Dim delWs As Worksheet
 Set delWs = ThisWorkbook.Worksheets(sheetNm)
 If Not delWs Is Nothing Then
 Dim prevAlerts As Boolean
 prevAlerts = Application.DisplayAlerts
 Application.DisplayAlerts = False
 delWs.Delete
 Application.DisplayAlerts = prevAlerts
 End If
 On Error GoTo 0
 End If

 Dim hr2 As Long
 For hr2 = HiddenDataLastRow() To HID_DATA_START_ROW Step -1
 If CStr(hws.Cells(hr2, HID_COL_INVOICE_ID).Value) = invoiceId Then
 hws.Rows(hr2).Delete
 End If
 Next hr2
End Sub

' Called from ThisWorkbook.Workbook_SheetBeforeDelete for every sheet
' deletion in the workbook - ignores anything that isn't a real invoice
' sheet, and for one that is, removes its Purchase/Sales Summary row +
' hidden-data rows immediately (safe: this never touches the sheet
' currently being deleted, only OTHER sheets/rows), then renumbers what's
' left. The doomed sheet itself is left for Excel's own delete to finish;
' by the time that happens, RenumberAllInvoices no longer knows about it,
' so it's never touched or renamed mid-deletion.
Public Sub HandleInvoiceSheetBeforeDelete(deletedSheetName As String)
 If gSyncInProgress Then Exit Sub
 Select Case deletedSheetName
 Case SHEET_PURCHASE_SUMMARY, SHEET_SALES_SUMMARY, SHEET_SUPPLIER_SUMMARY, _
 SHEET_CUSTOMER_SUMMARY, SHEET_PRODUCT_SUMMARY, SHEET_HIDDEN_DATA, _
 BATCH_OVERVIEW_SHEET_NAME_VBA
 Exit Sub ' only a real invoice sheet triggers cleanup
 End Select

 Dim hws As Worksheet, listWs As Worksheet
 Set hws = HiddenDataSheet()
 Set listWs = InvoiceListSheet()

 Dim invoiceId As String
 invoiceId = ""
 Dim hr As Long
 For hr = HID_DATA_START_ROW To HiddenDataLastRow()
 If CStr(hws.Cells(hr, HID_COL_SHEET_NAME).Value) = deletedSheetName Then
 invoiceId = CStr(hws.Cells(hr, HID_COL_INVOICE_ID).Value)
 Exit For
 End If
 Next hr
 If invoiceId = "" Then Exit Sub ' not a tracked invoice sheet - nothing to reconcile

 gSyncInProgress = True
 Application.EnableEvents = False
 On Error GoTo CleanFail

 Dim r As Long
 r = FindInvoiceListRowByInvoiceId(invoiceId)
 If r > 0 Then listWs.Rows(r).Delete

 Dim hr2 As Long
 For hr2 = HiddenDataLastRow() To HID_DATA_START_ROW Step -1
 If CStr(hws.Cells(hr2, HID_COL_INVOICE_ID).Value) = invoiceId Then
 hws.Rows(hr2).Delete
 End If
 Next hr2

 RenumberAllInvoices
 Application.Calculate

CleanFail:
 Application.EnableEvents = True
 gSyncInProgress = False
End Sub

' ========================= END MODULE: SyncEngine ===========================
'
' Prompt 20: clsSheetWatcher and ThisWorkbook are no longer reproduced below
' as commented-out text in this same file (pasting them verbatim, leading
' "'" and all, silently produced a class module that was 100% comments and
' 0% real code - every button and every sync path stayed dead with no
' compile error to reveal why). They now live as their own real,
' directly-importable files:
' - templates/vba/clsSheetWatcher.cls (a real .cls, with the VERSION/
' Attribute header a class module needs - VBComponents.Import-ready)
' - templates/vba/ThisWorkbook.bas (plain code, no header - ThisWorkbook
' is a fixed document component that can't be removed/re-imported like
' a normal module, so this gets loaded via CodeModule.AddFromString
' instead; see ImportLatestVBA in templates/vba/ImportLatestVBA.bas)
' templates/vba/ImportLatestVBA.bas is a one-time bootstrap macro: paste it
' into any standard module once (Trust access to the VBA project object
' model must be enabled), and from then on it can reload all three of
' SyncEngine/clsSheetWatcher/ThisWorkbook straight from these files on
' disk - no manual copy-pasting for any future update.
