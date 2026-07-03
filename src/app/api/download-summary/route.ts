import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("id");

    if (!batchId) {
      return NextResponse.json(
        { message: "Batch ID is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Verify session
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // Fetch batch details
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      return NextResponse.json({ message: "Batch not found" }, { status: 404 });
    }

    // Verify it is finalized
    if (batch.batch_status !== "FINALIZED") {
      return NextResponse.json(
        {
          message: "Summary download is only available for finalized batches.",
        },
        { status: 403 },
      );
    }

    // Fetch all final saved invoice data from this batch
    const { data: invoices, error: invoicesError } = await supabase
      .from("invoice")
      .select("*")
      .eq("invoice_batch_id", batchId)
      .order("invoice_date", { ascending: true })
      .order("invoice_number", { ascending: true });

    if (invoicesError || !invoices || invoices.length === 0) {
      return NextResponse.json(
        { message: "No invoices found for this batch" },
        { status: 404 },
      );
    }

    // Fetch receiving companies to map names & GSTINs
    const { data: receivingCompaniesList } = await supabase
      .from("receiving_companies")
      .select("*");

    const receivingCompaniesMap = new Map();
    if (receivingCompaniesList) {
      for (const comp of receivingCompaniesList) {
        receivingCompaniesMap.set(comp.id, comp);
      }
    }

    // --- Data Processing for Summaries ---

    // 1. Batch Overview Metrics
    const invoiceCount = invoices.length;
    const customerIds = new Set(
      invoices
        .map(
          (inv) => inv.products?.[0]?.customer_id || batch.receiving_company_id,
        )
        .filter(Boolean),
    );
    const customerCount = customerIds.size;

    const productIds = new Set();
    invoices.forEach((inv) => {
      inv.products?.forEach((p: any) => {
        if (p.product_id) productIds.add(p.product_id);
      });
    });
    const totalProductsUsed = productIds.size;

    const invoiceAmounts = invoices.map((inv) => Number(inv.total_amount || 0));
    const grandTotal = invoiceAmounts.reduce((sum, amt) => sum + amt, 0);
    const averageInvoice = invoiceCount > 0 ? grandTotal / invoiceCount : 0;
    const highestInvoice = invoiceCount > 0 ? Math.max(...invoiceAmounts) : 0;
    const lowestInvoice = invoiceCount > 0 ? Math.min(...invoiceAmounts) : 0;

    // 2. Product Summary Aggregation
    const productSummaryMap = new Map();
    invoices.forEach((inv) => {
      const seenProductsInInvoice = new Set();
      inv.products?.forEach((p: any) => {
        const key = p.product_id || p.product_name;
        if (!productSummaryMap.has(key)) {
          productSummaryMap.set(key, {
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            totalQuantity: 0,
            totalAmount: 0,
            invoiceCount: 0,
          });
        }
        const item = productSummaryMap.get(key);
        item.totalQuantity += Number(p.quantity || 0);
        item.totalAmount += Number(p.amount || 0);

        if (!seenProductsInInvoice.has(key)) {
          item.invoiceCount += 1;
          seenProductsInInvoice.add(key);
        }
      });
    });

    // 3. Customer / Supplier Summary Aggregation
    const customerSummaryMap = new Map();
    invoices.forEach((inv) => {
      const customerId =
        inv.products?.[0]?.customer_id || batch.receiving_company_id;
      const key = customerId || "unknown";

      const company = receivingCompaniesMap.get(customerId) || {
        company_name: "Unknown Company",
        gstin: "N/A",
      };

      if (!customerSummaryMap.has(key)) {
        customerSummaryMap.set(key, {
          company_name: company.company_name,
          gstin: company.gstin || "N/A",
          invoiceCount: 0,
          totalAmount: 0,
        });
      }

      const item = customerSummaryMap.get(key);
      item.invoiceCount += 1;
      item.totalAmount += Number(inv.total_amount || 0);
    });

    const workbook = new ExcelJS.Workbook();

    // --- Common Formatting and Styling Definitions ---
    const thinBorder = {
      top: { style: "thin", color: { argb: "FF000000" } },
      left: { style: "thin", color: { argb: "FF000000" } },
      bottom: { style: "thin", color: { argb: "FF000000" } },
      right: { style: "thin", color: { argb: "FF000000" } },
    } as const;

    const styleHeaderCell = (cell: any) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4A4A4A" }, // Dark Grey
      };
      cell.font = {
        name: "Calibri",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = thinBorder;
    };

    const styleDataCell = (
      cell: any,
      isOdd: boolean,
      align: "left" | "right" | "center" = "left",
      numFmt?: string,
    ) => {
      cell.font = { name: "Calibri", size: 11 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isOdd ? "FFF2F2F2" : "FFFFFFFF" }, // Light Grey / White
      };
      cell.alignment = { horizontal: align, vertical: "middle" };
      cell.border = thinBorder;
      if (numFmt) cell.numFmt = numFmt;
    };

    const styleTotalCell = (
      cell: any,
      align: "left" | "right" | "center" = "left",
      numFmt?: string,
    ) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF595959" }, // Medium Dark Grey
      };
      cell.font = {
        name: "Calibri",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.alignment = { horizontal: align, vertical: "middle" };
      cell.border = thinBorder;
      if (numFmt) cell.numFmt = numFmt;
    };

    const configurePage = (sheet: ExcelJS.Worksheet, repeatRow?: string) => {
      sheet.pageSetup = {
        orientation: "landscape",
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.7,
          right: 0.7,
          top: 0.75,
          bottom: 0.75,
          header: 0.3,
          footer: 0.3,
        },
        horizontalCentered: true,
        showGridLines: true,
      };
      if (repeatRow && sheet.pageSetup) {
        sheet.pageSetup.printTitlesRow = repeatRow;
      }
    };

    const autoFitWidths = (sheet: ExcelJS.Worksheet) => {
      sheet.columns?.forEach((column) => {
        if (!column) return;
        let maxLength = 0;
        column.eachCell?.({ includeEmpty: true }, (cell, rowIdx) => {
          if (rowIdx === 1) return; // skip header banner title
          const val = cell.value;
          if (val !== null && val !== undefined) {
            let strVal = String(val);
            if (typeof val === "object" && "formula" in val) {
              strVal = String(val.result || "");
            }
            if (strVal.length > maxLength) {
              maxLength = strVal.length;
            }
          }
        });
        column.width = Math.max(maxLength + 4, 12);
      });
    };

    // Determine terminology config
    const isSales = batch.batch_type === "SALES";
    const titleTerm = isSales ? "SALES" : "PURCHASE";
    const partnerSingleTerm = isSales ? "Customer" : "Supplier";
    const partnerPluralTerm = isSales ? "Customers" : "Suppliers";

    // ----------------------------------------------------
    // Sheet 1: Batch Overview (Dashboard)
    // ----------------------------------------------------
    const sheet1 = workbook.addWorksheet("Batch Overview");
    configurePage(sheet1);

    // Top Banner
    sheet1.mergeCells("A1:H1");
    const titleCell = sheet1.getCell("A1");
    titleCell.value = `${titleTerm} INVOICE BATCH SUMMARY`;
    titleCell.font = {
      name: "Calibri",
      size: 18,
      bold: true,
      color: { argb: "FF000000" },
    };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    titleCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };
    titleCell.border = thinBorder;
    sheet1.getRow(1).height = 40;

    sheet1.addRow([]); // Blank Row

    // KPI Horizontal row
    const styleKPICard = (
      colHead: string,
      colVal: string,
      title: string,
      value: any,
      isCurrency = false,
    ) => {
      sheet1.getCell(colHead).value = title;
      sheet1.getCell(colHead).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4A4A4A" },
      };
      sheet1.getCell(colHead).font = {
        name: "Calibri",
        size: 10,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      sheet1.getCell(colHead).alignment = {
        horizontal: "center",
        vertical: "middle",
      };
      sheet1.getCell(colHead).border = thinBorder;

      sheet1.getCell(colVal).value = value;
      sheet1.getCell(colVal).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF2F2F2" },
      };
      sheet1.getCell(colVal).font = {
        name: "Calibri",
        size: 14,
        bold: true,
        color: { argb: "FF000000" },
      };
      sheet1.getCell(colVal).alignment = {
        horizontal: "center",
        vertical: "middle",
      };
      sheet1.getCell(colVal).border = thinBorder;
      if (isCurrency) sheet1.getCell(colVal).numFmt = "₹#,##0.00";
    };

    styleKPICard("A3", "A4", "Grand Total", grandTotal, true);
    styleKPICard(
      "C3",
      "C4",
      `${titleTerm === "SALES" ? "Total Invoices" : "Total Invoices"}`,
      invoiceCount,
    );
    styleKPICard("E3", "E4", `Total ${partnerPluralTerm}`, customerCount);
    styleKPICard("G3", "G4", "Products Used", totalProductsUsed);

    sheet1.getRow(3).height = 18;
    sheet1.getRow(4).height = 28;

    sheet1.addRow([]); // Blank row

    let currentRow = 6;
    const addBoxedSection = (
      sectionTitle: string,
      data: [string, any, string?][],
    ) => {
      sheet1.mergeCells(`A${currentRow}:D${currentRow}`);
      const secHeader = sheet1.getCell(`A${currentRow}`);
      secHeader.value = sectionTitle;
      secHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4A4A4A" },
      };
      secHeader.font = {
        name: "Calibri",
        size: 11,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      secHeader.alignment = { horizontal: "left", vertical: "middle" };
      secHeader.border = thinBorder;
      sheet1.getRow(currentRow).height = 20;
      currentRow++;

      data.forEach(([label, val, format]) => {
        sheet1.mergeCells(`A${currentRow}:B${currentRow}`);
        sheet1.mergeCells(`C${currentRow}:D${currentRow}`);

        const cellL = sheet1.getCell(`A${currentRow}`);
        cellL.value = label;
        cellL.font = { name: "Calibri", size: 10, bold: true };
        cellL.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF2F2F2" },
        };
        cellL.alignment = { horizontal: "left", vertical: "middle" };
        cellL.border = thinBorder;

        const cellV = sheet1.getCell(`C${currentRow}`);
        cellV.value = val;
        cellV.font = { name: "Calibri", size: 10 };
        cellV.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFFFF" },
        };
        cellV.alignment = {
          horizontal: typeof val === "number" ? "right" : "left",
          vertical: "middle",
        };
        cellV.border = thinBorder;
        if (format) cellV.numFmt = format;

        sheet1.getRow(currentRow).height = 18;
        currentRow++;
      });

      sheet1.addRow([]); // Blank row
      currentRow++;
    };

    addBoxedSection("Batch Information", [
      ["Batch Number", batch.id.substring(0, 8)],
      ["Status", batch.batch_status || "N/A"],
      ["Financial Year", batch.financial_year || "N/A"],
    ]);

    addBoxedSection("Financial Summary", [
      ["Grand Total", grandTotal, "₹#,##0.00"],
      ["Average Invoice", averageInvoice, "₹#,##0.00"],
    ]);

    addBoxedSection("Invoice Statistics", [
      ["Invoice Count", invoiceCount],
      ["Highest Invoice", highestInvoice, "₹#,##0.00"],
      ["Lowest Invoice", lowestInvoice, "₹#,##0.00"],
    ]);

    addBoxedSection(`${partnerSingleTerm} Statistics`, [
      [`${partnerSingleTerm} Count`, customerCount],
    ]);

    addBoxedSection("Product Statistics", [
      ["Total Products Used", totalProductsUsed],
    ]);

    addBoxedSection("Generation Configuration", [
      ["Batch Type", batch.batch_type],
      ["Transport Mode", batch.transport_mode],
      ["Vehicle Number", batch.vehicle_number],
      ["Date Range", `${batch.invoice_date_from} to ${batch.invoice_date_to}`],
    ]);

    addBoxedSection("Validation Summary", [
      [
        "Generated On",
        batch.created_at ? new Date(batch.created_at).toISOString() : "N/A",
      ],
      [
        "Finalized On",
        batch.finalized_at ? new Date(batch.finalized_at).toISOString() : "N/A",
      ],
    ]);

    autoFitWidths(sheet1);
    // Extra override for sheet 1 column dimensions so it looks like structured boxes
    sheet1.getColumn(1).width = 18;
    sheet1.getColumn(2).width = 18;
    sheet1.getColumn(3).width = 18;
    sheet1.getColumn(4).width = 18;

    // ----------------------------------------------------
    // Sheet 2: Invoice Summary
    // ----------------------------------------------------
    const sheet2 = workbook.addWorksheet("Invoice Summary");
    configurePage(sheet2, "3:3");

    sheet2.mergeCells("A1:J1");
    const s2Title = sheet2.getCell("A1");
    s2Title.value = "INVOICE SUMMARY";
    s2Title.font = {
      name: "Calibri",
      size: 16,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    s2Title.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4A4A4A" },
    };
    s2Title.alignment = { horizontal: "center", vertical: "middle" };
    s2Title.border = thinBorder;
    sheet2.getRow(1).height = 35;

    sheet2.addRow([]);

    const headerRow2 = sheet2.addRow([
      "Sl No",
      "Invoice Number",
      "Invoice Date",
      "Customer / Supplier",
      "GSTIN",
      "Number Of Products",
      "Invoice Amount",
      "Transport Mode",
      "Vehicle Number",
      "Status",
    ]);
    headerRow2.height = 25;
    for (let c = 1; c <= 10; c++) {
      styleHeaderCell(headerRow2.getCell(c));
    }

    invoices.forEach((inv, index) => {
      const customerId =
        inv.products?.[0]?.customer_id || batch.receiving_company_id;
      const company = receivingCompaniesMap.get(customerId) || {};
      const companyName = company.company_name || "Unknown Company";
      const gstin = company.gstin || "N/A";
      const isOdd = index % 2 === 1;

      const row = sheet2.addRow([
        index + 1,
        inv.invoice_number,
        inv.invoice_date,
        companyName,
        gstin,
        inv.products?.length || 0,
        Number(inv.total_amount || 0),
        inv.transport_mode || batch.transport_mode || "In hand Delivery",
        inv.vehicle_number || batch.vehicle_number || "NA",
        inv.status || "N/A",
      ]);
      row.height = 20;

      styleDataCell(row.getCell(1), isOdd, "center");
      styleDataCell(row.getCell(2), isOdd, "center");
      styleDataCell(row.getCell(3), isOdd, "center");
      styleDataCell(row.getCell(4), isOdd, "left");
      styleDataCell(row.getCell(5), isOdd, "center");
      styleDataCell(row.getCell(6), isOdd, "right");
      styleDataCell(row.getCell(7), isOdd, "right", "₹#,##0.00");
      styleDataCell(row.getCell(8), isOdd, "left");
      styleDataCell(row.getCell(9), isOdd, "center");
      styleDataCell(row.getCell(10), isOdd, "center");
    });

    const totalsRowIndex2 = invoices.length + 4;
    const totalsRow2 = sheet2.addRow([
      "TOTAL",
      "",
      "",
      "",
      "",
      "",
      { formula: `=SUM(G4:G${totalsRowIndex2 - 1})` },
      "",
      "",
      "",
    ]);
    totalsRow2.height = 22;
    for (let c = 1; c <= 10; c++) {
      styleTotalCell(
        totalsRow2.getCell(c),
        c === 7 ? "right" : "center",
        c === 7 ? "₹#,##0.00" : undefined,
      );
    }
    sheet2.mergeCells(`A${totalsRowIndex2}:F${totalsRowIndex2}`);
    for (let c = 2; c <= 6; c++) totalsRow2.getCell(c).value = "";
    sheet2.getCell(`A${totalsRowIndex2}`).value = "TOTAL";

    sheet2.autoFilter = { from: "A3", to: "J3" };
    sheet2.views = [{ state: "frozen", ySplit: 3 }];
    autoFitWidths(sheet2);

    // ----------------------------------------------------
    // Sheet 3: Product Summary
    // ----------------------------------------------------
    const sheet3 = workbook.addWorksheet("Product Summary");
    configurePage(sheet3, "3:3");

    sheet3.mergeCells("A1:G1");
    const s3Title = sheet3.getCell("A1");
    s3Title.value = "PRODUCT SUMMARY";
    s3Title.font = {
      name: "Calibri",
      size: 16,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    s3Title.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4A4A4A" },
    };
    s3Title.alignment = { horizontal: "center", vertical: "middle" };
    s3Title.border = thinBorder;
    sheet3.getRow(1).height = 35;

    sheet3.addRow([]);

    const headerRow3 = sheet3.addRow([
      "Sl No",
      "Product",
      "HSN",
      "Total Quantity",
      "Average Rate",
      "Total Amount",
      "Appeared In Invoice Count",
    ]);
    headerRow3.height = 25;
    for (let c = 1; c <= 7; c++) {
      styleHeaderCell(headerRow3.getCell(c));
    }

    let prodIdx = 1;
    productSummaryMap.forEach((item) => {
      const isOdd = prodIdx % 2 === 0;
      const rowNum = prodIdx + 3;
      const row = sheet3.addRow([
        prodIdx,
        item.product_name,
        item.hsn_code,
        item.totalQuantity,
        { formula: `=F${rowNum}/D${rowNum}` },
        item.totalAmount,
        item.invoiceCount,
      ]);
      row.height = 20;

      styleDataCell(row.getCell(1), isOdd, "center");
      styleDataCell(row.getCell(2), isOdd, "left");
      styleDataCell(row.getCell(3), isOdd, "center");
      styleDataCell(row.getCell(4), isOdd, "right");
      styleDataCell(row.getCell(5), isOdd, "right", "₹#,##0.00");
      styleDataCell(row.getCell(6), isOdd, "right", "₹#,##0.00");
      styleDataCell(row.getCell(7), isOdd, "right");

      prodIdx++;
    });

    const totalsRowIndex3 = productSummaryMap.size + 4;
    const totalsRow3 = sheet3.addRow([
      "TOTAL",
      "",
      "",
      { formula: `=SUM(D4:D${totalsRowIndex3 - 1})` },
      { formula: `=F${totalsRowIndex3}/D${totalsRowIndex3}` },
      { formula: `=SUM(F4:F${totalsRowIndex3 - 1})` },
      "",
    ]);
    totalsRow3.height = 22;
    for (let c = 1; c <= 7; c++) {
      styleTotalCell(
        totalsRow3.getCell(c),
        c === 4 || c === 5 || c === 6 ? "right" : "center",
        c === 5 || c === 6 ? "₹#,##0.00" : undefined,
      );
    }
    sheet3.mergeCells(`A${totalsRowIndex3}:C${totalsRowIndex3}`);
    for (let c = 2; c <= 3; c++) totalsRow3.getCell(c).value = "";
    sheet3.getCell(`A${totalsRowIndex3}`).value = "TOTAL";

    sheet3.autoFilter = { from: "A3", to: "G3" };
    sheet3.views = [{ state: "frozen", ySplit: 3 }];
    autoFitWidths(sheet3);

    // ----------------------------------------------------
    // Sheet 4: Customer / Supplier Summary
    // ----------------------------------------------------
    const sheet4 = workbook.addWorksheet(`${partnerSingleTerm} Summary`);
    configurePage(sheet4, "3:3");

    sheet4.mergeCells("A1:F1");
    const s4Title = sheet4.getCell("A1");
    s4Title.value = `${partnerSingleTerm.toUpperCase()} SUMMARY`;
    s4Title.font = {
      name: "Calibri",
      size: 16,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    s4Title.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4A4A4A" },
    };
    s4Title.alignment = { horizontal: "center", vertical: "middle" };
    s4Title.border = thinBorder;
    sheet4.getRow(1).height = 35;

    sheet4.addRow([]);

    const headerRow4 = sheet4.addRow([
      "Sl No",
      partnerSingleTerm,
      "GSTIN",
      "Invoice Count",
      "Total Amount",
      "Average Invoice",
    ]);
    headerRow4.height = 25;
    for (let c = 1; c <= 6; c++) {
      styleHeaderCell(headerRow4.getCell(c));
    }

    let custIdx = 1;
    customerSummaryMap.forEach((item) => {
      const isOdd = custIdx % 2 === 0;
      const rowNum = custIdx + 3;
      const row = sheet4.addRow([
        custIdx,
        item.company_name,
        item.gstin,
        item.invoiceCount,
        item.totalAmount,
        { formula: `=E${rowNum}/D${rowNum}` },
      ]);
      row.height = 20;

      styleDataCell(row.getCell(1), isOdd, "center");
      styleDataCell(row.getCell(2), isOdd, "left");
      styleDataCell(row.getCell(3), isOdd, "center");
      styleDataCell(row.getCell(4), isOdd, "right");
      styleDataCell(row.getCell(5), isOdd, "right", "₹#,##0.00");
      styleDataCell(row.getCell(6), isOdd, "right", "₹#,##0.00");

      custIdx++;
    });

    const totalsRowIndex4 = customerSummaryMap.size + 4;
    const totalsRow4 = sheet4.addRow([
      "TOTAL",
      "",
      "",
      { formula: `=SUM(D4:D${totalsRowIndex4 - 1})` },
      { formula: `=SUM(E4:E${totalsRowIndex4 - 1})` },
      { formula: `=E${totalsRowIndex4}/D${totalsRowIndex4}` },
    ]);
    totalsRow4.height = 22;
    for (let c = 1; c <= 6; c++) {
      styleTotalCell(
        totalsRow4.getCell(c),
        c === 4 || c === 5 || c === 6 ? "right" : "center",
        c === 5 || c === 6 ? "₹#,##0.00" : undefined,
      );
    }
    sheet4.mergeCells(`A${totalsRowIndex4}:C${totalsRowIndex4}`);
    for (let c = 2; c <= 3; c++) totalsRow4.getCell(c).value = "";
    sheet4.getCell(`A${totalsRowIndex4}`).value = "TOTAL";

    sheet4.autoFilter = { from: "A3", to: "F3" };
    sheet4.views = [{ state: "frozen", ySplit: 3 }];
    autoFitWidths(sheet4);

    // Count how many batches of this type were created before or at the same time as this batch
    const { count, error: countError } = await supabase
      .from("invoice_batch")
      .select("*", { count: "exact", head: true })
      .eq("batch_type", batch.batch_type)
      .lte("created_at", batch.created_at);

    const batchNumber = countError || count === null ? 1 : count;
    const batchNumberStr = String(batchNumber).padStart(2, "0");

    const filename =
      batch.batch_type === "PURCHASE"
        ? `Summary_Purchase_Batch${batchNumberStr}.xlsx`
        : `Summary_Sales_Batch${batchNumberStr}.xlsx`;

    // Generate buffer & set response headers
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(buffer as any, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error: any) {
    console.error("Download Summary Error:", error);
    return NextResponse.json(
      {
        message:
          error.message || "An unexpected error occurred during summary export",
      },
      { status: 500 },
    );
  }
}
