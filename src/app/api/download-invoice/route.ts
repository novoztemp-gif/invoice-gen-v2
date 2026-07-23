import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { generatePurchasePDFBuffer } from "@/lib/services/PdfExportService";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const invoiceId = searchParams.get("invoiceId");
  const isChallan = searchParams.get("isChallan") === "true";

  if (!invoiceId) {
    return NextResponse.json(
      { message: "Invoice ID is required" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // 1. Fetch the invoice
  const { data: inv, error: invoiceError } = await supabase
    .from("invoice")
    .select("*")
    .eq("id", invoiceId)
    .single();

  if (invoiceError || !inv) {
    return NextResponse.json({ message: "Invoice not found" }, { status: 404 });
  }

  // 2. Fetch the batch
  const { data: batch, error: batchError } = await supabase
    .from("invoice_batch")
    .select(`
      *,
      issuing_companies (
        id, company_name, address, gstin, phone, bank_account_name, bank_name, account_number, ifsc_code, pan, branch
      )
    `)
    .eq("id", inv.invoice_batch_id)
    .single();

  if (batchError || !batch) {
    return NextResponse.json({ message: "Batch not found" }, { status: 404 });
  }

  // 3. Fetch receiving customer
  const customerId =
    inv.products?.[0]?.customer_id || batch.receiving_company_id;

  const { data: customer } = await supabase
    .from("receiving_companies")
    .select("*")
    .eq("id", customerId)
    .single();

  const numberToWords = (num: number): string => {
    const a = [
      "",
      "One ",
      "Two ",
      "Three ",
      "Four ",
      "Five ",
      "Six ",
      "Seven ",
      "Eight ",
      "Nine ",
      "Ten ",
      "Eleven ",
      "Twelve ",
      "Thirteen ",
      "Fourteen ",
      "Fifteen ",
      "Sixteen ",
      "Seventeen ",
      "Eighteen ",
      "Nineteen ",
    ];
    const b = [
      "",
      "",
      "Twenty",
      "Thirty",
      "Forty",
      "Fifty",
      "Sixty",
      "Seventy",
      "Eighty",
      "Ninety",
    ];

    if ((num = num.toString() as any).length > 9) return "overflow";
    const n = ("000000000" + num)
      .substr(-9)
      .match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return "";
    let str = "";
    str +=
      n[1] != "00"
        ? (a[Number(n[1])] || b[n[1][0] as any] + " " + a[n[1][1] as any]) +
          "Crore "
        : "";
    str +=
      n[2] != "00"
        ? (a[Number(n[2])] || b[n[2][0] as any] + " " + a[n[2][1] as any]) +
          "Lakh "
        : "";
    str +=
      n[3] != "00"
        ? (a[Number(n[3])] || b[n[3][0] as any] + " " + a[n[3][1] as any]) +
          "Thousand "
        : "";
    str +=
      n[4] != "0"
        ? (a[Number(n[4])] || b[n[4][0] as any] + " " + a[n[4][1] as any]) +
          "Hundred "
        : "";
    str +=
      n[5] != "00"
        ? (str != "" ? "and " : "") +
          (a[Number(n[5])] || b[n[5][0] as any] + " " + a[n[5][1] as any]) +
          "Only"
        : "Only";
    return str;
  };

  const generatePurchaseExcelBuffer = async (
    inv: any,
    issuing: any,
    receiving: any,
  ) => {
    const workbook = new ExcelJS.Workbook();
    const sheetName =
      inv.invoice_number.length > 31
        ? inv.invoice_number.substring(0, 31)
        : inv.invoice_number;
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ showGridLines: false }],
      pageSetup: {
        orientation: "landscape",
        paperSize: 9, // A5
      },
    });

    const products = inv.products || [];

    ws.getColumn(1).width = 15;
    ws.getColumn(2).width = 15;
    ws.getColumn(3).width = 15;
    ws.getColumn(4).width = 15;
    ws.getColumn(5).width = 15;
    ws.getColumn(6).width = 15;
    ws.getColumn(7).width = 15;
    ws.getColumn(8).width = 20;

    const applyBorder = (startCell: string, endCell: string) => {
      const sRow = ws.getCell(startCell).row as any as number;
      const eRow = ws.getCell(endCell).row as any as number;
      const sCol = ws.getCell(startCell).col as any as number;
      const eCol = ws.getCell(endCell).col as any as number;
      for (let r = sRow; r <= eRow; r++) {
        for (let c = sCol; c <= eCol; c++) {
          ws.getCell(r, c).border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" },
          };
        }
      }
    };

    const applyOuterBorder = () => {
      for (let r = 1; r <= 24; r++) {
        for (let c = 1; c <= 8; c++) {
          const cell = ws.getCell(r, c);
          const border: any = {};
          if (r === 1) border.top = { style: "medium" };
          if (r === 24) border.bottom = { style: "medium" };
          if (c === 1) border.left = { style: "medium" };
          if (c === 8) border.right = { style: "medium" };
          cell.border = border;
        }
      }
    };

    ws.mergeCells("A2:H2");
    const cellTitle = ws.getCell("A2");
    cellTitle.value = "PURCHASE INVOICE";
    cellTitle.font = { bold: true, size: 18, underline: true };
    cellTitle.alignment = { horizontal: "center", vertical: "middle" };

    ws.getCell("A4").value = "No.";
    ws.getCell("A4").font = { bold: true, size: 11 };
    ws.getCell("B4").value = inv.invoice_number;
    ws.getCell("B4").font = { bold: true, size: 11, underline: true };

    ws.getCell("G4").value = "Date.";
    ws.getCell("G4").font = { bold: true, size: 11 };
    ws.getCell("G4").alignment = { horizontal: "right" };

    const rawDate = inv.invoice_date ? new Date(inv.invoice_date) : new Date();
    const day = String(rawDate.getDate()).padStart(2, "0");
    const month = String(rawDate.getMonth() + 1).padStart(2, "0");
    const year = rawDate.getFullYear();
    ws.getCell("H4").value = `${day}/${month}/${year}`;
    ws.getCell("H4").font = { bold: true, size: 11, underline: true };

    ws.getCell("A6").value = "Rs";
    ws.getCell("A6").font = { bold: true, size: 12 };
    ws.getCell("A6").alignment = { horizontal: "center", vertical: "middle" };
    ws.mergeCells("B6:C6");
    const cellRs = ws.getCell("B6");
    cellRs.value = Number(inv.total_amount).toFixed(2);
    cellRs.font = { bold: true, size: 12 };
    cellRs.alignment = { horizontal: "center", vertical: "middle" };
    applyBorder("B6", "C6");

    ws.getCell("A8").value = "Pay to";
    ws.getCell("A8").font = { bold: true, size: 10 };
    ws.mergeCells("A9:H9");
    const cellPayToVal = ws.getCell("A9");
    cellPayToVal.value = receiving?.company_name || "";
    cellPayToVal.font = { bold: true, size: 12 };
    cellPayToVal.alignment = { vertical: "middle" };
    applyBorder("A9", "H9");

    ws.getCell("A11").value = "Rs. in Words";
    ws.getCell("A11").font = { bold: true, size: 10 };
    ws.mergeCells("A12:H12");
    const cellWordsVal = ws.getCell("A12");
    cellWordsVal.value = `Rupees ${numberToWords(Math.round(inv.total_amount))} Only`;
    cellWordsVal.font = { bold: true, size: 11 };
    cellWordsVal.alignment = { vertical: "middle" };
    applyBorder("A12", "H12");

    ws.getCell("A14").value = "being";
    ws.getCell("A14").font = { bold: true, size: 11 };
    ws.mergeCells("B14:H14");
    const cellBeingVal = ws.getCell("B14");
    const productsList = products.map((p: any) => p.product_name).join(", ");
    cellBeingVal.value = productsList
      ? `Purchase of ${productsList}`
      : "Purchase of raw materials";
    cellBeingVal.font = { italic: true, size: 11 };
    cellBeingVal.border = { bottom: { style: "dashed" } };

    ws.getCell("A15").value = "and debit";
    ws.getCell("A15").font = { bold: true, size: 11 };
    ws.mergeCells("B15:H15");
    ws.getCell("B15").border = { bottom: { style: "dashed" } };

    ws.getCell("A17").value = "Authorised by";
    ws.getCell("A17").font = { bold: true, size: 10 };
    ws.mergeCells("A18:B19");
    applyBorder("A18", "B19");

    ws.mergeCells("F18:G18");
    ws.getCell("F18").value = "Recd. above sum of Rs.";
    ws.getCell("F18").font = { bold: true, size: 11 };
    ws.getCell("F18").alignment = { horizontal: "right" };
    ws.getCell("H18").value = Number(inv.total_amount).toFixed(2);
    ws.getCell("H18").font = { bold: true, size: 11, underline: true };

    ws.mergeCells("A21:E23");
    const cellBankDetails = ws.getCell("A21");
    cellBankDetails.value = `Paid by cash / cheque\nDrawn on Bank: ${issuing?.bank_name || ""}\nA/c No. ${issuing?.account_number || ""}\nIFSC: ${issuing?.ifsc_code || ""}`;
    cellBankDetails.alignment = { wrapText: true, vertical: "middle" };
    cellBankDetails.font = { size: 10, bold: true };
    applyBorder("A21", "E23");

    ws.mergeCells("F21:H23");
    const cellReceiverSig = ws.getCell("F21");
    cellReceiverSig.value = "\n\nReceiver's Signature";
    cellReceiverSig.font = { bold: true, size: 9 };
    cellReceiverSig.alignment = { horizontal: "center", vertical: "bottom" };
    applyBorder("F21", "H23");

    applyOuterBorder();

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as any;
  };

  const generateExcelBuffer = async (
    inv: any,
    issuing: any,
    receiving: any,
  ) => {
    const workbook = new ExcelJS.Workbook();
    const sheetName =
      inv.invoice_number.length > 31
        ? inv.invoice_number.substring(0, 31)
        : inv.invoice_number;
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ showGridLines: false }],
    });

    const transport = {
      mode: batch.transport_mode,
      vehicleNumber: batch.vehicle_number,
    };
    const products = inv.products || [];
    const totalAmountBeforeTax = Number(inv.total_amount);
    const cgst = "Nil";
    const sgst = "Nil";
    const totalAmountAfterTax = Math.round(totalAmountBeforeTax); // Round to nearest rupee

    // Define exact 8-column widths for precision spacing
    ws.getColumn(1).width = 18; // A (Sl No, Name, Bank labels)
    ws.getColumn(2).width = 3; // B (Colon column for alignment)
    ws.getColumn(3).width = 24; // C (Values, Product Name merged with B)
    ws.getColumn(4).width = 15; // D (HSN, Invoice No, Additions)
    ws.getColumn(5).width = 10; // E (Qty, Date, etc.)
    ws.getColumn(6).width = 3; // F (Colon column for right side)
    ws.getColumn(7).width = 12; // G (Rate, values)
    ws.getColumn(8).width = 18; // H (Total Amounts)

    const applyBorder = (startCell: string, endCell: string) => {
      const sRow = ws.getCell(startCell).row as any as number;
      const eRow = ws.getCell(endCell).row as any as number;
      const sCol = ws.getCell(startCell).col as any as number;
      const eCol = ws.getCell(endCell).col as any as number;
      for (let r = sRow; r <= eRow; r++) {
        for (let c = sCol; c <= eCol; c++) {
          ws.getCell(r, c).border = {
            top: { style: "thin" },
            left: { style: "thin" },
            bottom: { style: "thin" },
            right: { style: "thin" },
          };
        }
      }
    };

    const headerStyle = {
      font: { bold: true, color: { argb: "FF000080" }, size: 16 },
      alignment: { horizontal: "center" as any, vertical: "middle" as any },
      fill: {
        type: "pattern" as any,
        pattern: "solid" as any,
        fgColor: { argb: "FFEAEAEA" },
      },
    };

    const grayFill = {
      type: "pattern" as any,
      pattern: "solid" as any,
      fgColor: { argb: "FFEAEAEA" },
    };

    ws.getRow(1).height = 30;
    ws.getRow(2).height = 20;
    ws.getRow(3).height = 20;

    // Row 1: Company Name
    ws.mergeCells("A1:H1");
    const cellA1 = ws.getCell("A1");
    cellA1.value = issuing?.company_name || "";
    cellA1.style = headerStyle;

    // Row 2: Address
    ws.mergeCells("A2:H2");
    const cellA2 = ws.getCell("A2");
    cellA2.value = issuing?.address || "";
    cellA2.font = { size: 10, bold: true };
    cellA2.alignment = { horizontal: "center", vertical: "middle" };
    cellA2.fill = grayFill;

    // Row 3: INVOICE / DELIVERY CHALLAN
    ws.mergeCells("A3:H3");
    const cellA3 = ws.getCell("A3");
    cellA3.value = isChallan ? "DELIVERY CHALLAN" : "INVOICE";
    cellA3.font = { bold: true, underline: true, size: 12 };
    cellA3.alignment = { horizontal: "center", vertical: "middle" };
    cellA3.fill = grayFill;

    applyBorder("A1", "H3");

    // Row 4: Delivery / Seller Details
    ws.mergeCells("A4:C4");
    const cellA4 = ws.getCell("A4");
    cellA4.value = "Delivery Details";
    cellA4.font = { bold: true };
    cellA4.fill = grayFill;

    ws.mergeCells("D4:H4");
    const cellD4 = ws.getCell("D4");
    cellD4.value = "Seller Details";
    cellD4.font = { bold: true };
    cellD4.fill = grayFill;

    applyBorder("A4", "H4");

    // Row 5
    ws.mergeCells("A5:B5");
    ws.getCell("A5").value = "Transport Mode";
    ws.getCell("C5").value =
      inv.transport_mode || transport.mode || "In hand Delivery";
    ws.mergeCells("D5:H5");
    const cellD5 = ws.getCell("D5");
    cellD5.value = `GSTIN : ${issuing?.gstin || ""}`;
    cellD5.font = { bold: true, color: { argb: "FF000080" } };

    // Row 6
    ws.mergeCells("A6:B6");
    ws.getCell("A6").value = "Vehicle Number";
    ws.getCell("C6").value =
      inv.vehicle_number || transport.vehicleNumber || "NA";
    ws.mergeCells("D6:H6");

    // Row 7
    ws.mergeCells("A7:B7");
    ws.getCell("A7").value = "Date of Supply";
    ws.getCell("C7").value = inv.date_of_supply || inv.invoice_date || "";
    ws.mergeCells("D7:H7");
    const cellD7 = ws.getCell("D7");
    cellD7.value = `Phone : ${issuing?.phone || ""}`;
    cellD7.font = { bold: true, color: { argb: "FF000080" } };

    applyBorder("A5", "C7");
    applyBorder("D5", "H7");

    // Row 8
    ws.mergeCells("A8:C8");
    const cellA8 = ws.getCell("A8");
    cellA8.value = "Details of Receiver / Billed to :";
    cellA8.font = { bold: true };
    cellA8.fill = grayFill;

    ws.mergeCells("D8:H8");
    const cellD8 = ws.getCell("D8");
    cellD8.value = "Original for Recipient";
    cellD8.font = { bold: true };
    cellD8.fill = grayFill;

    applyBorder("A8", "H8");

    // Row 9-13
    ws.getCell("A9").value = "Name";
    ws.getCell("B9").value = ":";
    ws.getCell("B9").alignment = { horizontal: "center" };
    ws.getCell("C9").value = receiving?.company_name || "";
    ws.getCell("C9").font = { bold: true };

    ws.mergeCells("D9:E9");
    ws.getCell("D9").value = "Invoice No";
    ws.getCell("F9").value = ":";
    ws.getCell("F9").alignment = { horizontal: "center" };
    ws.mergeCells("G9:H9");
    ws.getCell("G9").value = inv.invoice_number || "";
    ws.getCell("G9").font = { bold: true };

    ws.getCell("A10").value = "Address";
    ws.getCell("B10").value = ":";
    ws.getCell("B10").alignment = { horizontal: "center" };
    ws.getCell("C10").value = receiving?.address || "";
    ws.getCell("C10").alignment = { wrapText: true, vertical: "top" };
    ws.getRow(10).height = 40;

    ws.mergeCells("D10:E10");
    ws.getCell("D10").value = "Date";
    ws.getCell("F10").value = ":";
    ws.getCell("F10").alignment = { horizontal: "center" };
    ws.mergeCells("G10:H10");
    ws.getCell("G10").value = inv.invoice_date || "";
    ws.getCell("G10").font = { bold: true };

    ws.getCell("A11").value = "GSTIN";
    ws.getCell("B11").value = ":";
    ws.getCell("B11").alignment = { horizontal: "center" };
    ws.getCell("C11").value = receiving?.gstin || "Unregistered";
    ws.getCell("C11").font = { bold: true };

    ws.mergeCells("D11:H11");
    ws.getCell("D11").value = `Financial Year: ${batch.financial_year || ""}`;

    ws.getCell("A12").value = "PAN";
    ws.getCell("B12").value = ":";
    ws.getCell("B12").alignment = { horizontal: "center" };
    ws.getCell("C12").value = receiving?.pan || "";
    ws.getCell("C12").font = { bold: true };
    ws.mergeCells("D12:H12");

    ws.getCell("A13").value = "State";
    ws.getCell("B13").value = ":";
    ws.getCell("B13").alignment = { horizontal: "center" };
    ws.getCell("C13").value = receiving?.state || "";
    ws.getCell("C13").font = { bold: true };
    ws.mergeCells("D13:H13");
    if (receiving?.state_code) {
      ws.getCell("D13").value = `State Code : ${receiving.state_code}`;
      ws.getCell("D13").font = { bold: true };
    }

    applyBorder("A9", "C13");
    applyBorder("D9", "H13");

    // Product Headers (Row 14-15)
    ws.mergeCells("A14:A15");
    ws.getCell("A14").value = "Sl.\nNo.";

    ws.mergeCells("B14:C15");
    ws.getCell("B14").value = "Name of the Product / Service";

    ws.mergeCells("D14:D15");
    ws.getCell("D14").value = "HSN/ ACS";

    ws.mergeCells("E14:E15");
    ws.getCell("E14").value = "Qty in KG";

    ws.mergeCells("F14:G14");
    ws.getCell("F14").value = "Rate Per KG";
    ws.mergeCells("F15:G15");
    ws.getCell("F15").value = "Rs.";

    ws.mergeCells("H14:H15");
    ws.getCell("H14").value = "Total Amount";

    for (let c = 1; c <= 8; c++) {
      ws.getCell(14, c).fill = grayFill;
      ws.getCell(14, c).font = { bold: true };
      ws.getCell(14, c).alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
      ws.getCell(15, c).fill = grayFill;
      ws.getCell(15, c).font = { bold: true };
      ws.getCell(15, c).alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    }
    applyBorder("A14", "H15");

    const minProductRows = 16;
    const productRowCount = Math.max(products.length, minProductRows);
    let currentRow = 16;

    for (let i = 0; i < productRowCount; i++) {
      const p = products[i] || {};
      ws.getCell(`A${currentRow}`).value = i < products.length ? i + 1 : "";
      ws.getCell(`A${currentRow}`).alignment = {
        horizontal: "center",
        vertical: "middle",
      };

      ws.mergeCells(`B${currentRow}:C${currentRow}`);
      ws.getCell(`B${currentRow}`).value = p.product_name || "";
      ws.getCell(`B${currentRow}`).alignment = { vertical: "middle" };

      ws.getCell(`D${currentRow}`).value = p.hsn_code || "";
      ws.getCell(`D${currentRow}`).alignment = {
        horizontal: "center",
        vertical: "middle",
      };

      const qty = p.quantity ? Number(p.quantity) : null;
      ws.getCell(`E${currentRow}`).value = qty;
      ws.getCell(`E${currentRow}`).alignment = {
        horizontal: "center",
        vertical: "middle",
      };

      const rate = p.rate ? Number(p.rate) : null;
      ws.mergeCells(`F${currentRow}:G${currentRow}`);
      ws.getCell(`F${currentRow}`).value = rate;
      ws.getCell(`F${currentRow}`).numFmt = "0.00";
      ws.getCell(`F${currentRow}`).alignment = {
        horizontal: "right",
        vertical: "middle",
      };

      const amt = p.amount ? Number(p.amount) : null;
      ws.getCell(`H${currentRow}`).value = amt;
      ws.getCell(`H${currentRow}`).numFmt = "0.00";
      ws.getCell(`H${currentRow}`).alignment = {
        horizontal: "right",
        vertical: "middle",
      };

      currentRow++;
    }

    applyBorder("A16", `H${currentRow - 1}`);

    // Totals row (inside table)
    ws.mergeCells(`A${currentRow}:G${currentRow}`);
    const cellTotalTitle = ws.getCell(`A${currentRow}`);
    cellTotalTitle.value = "Total";
    cellTotalTitle.font = { bold: true };
    cellTotalTitle.alignment = { horizontal: "center" };
    cellTotalTitle.fill = grayFill;

    ws.getCell(`H${currentRow}`).value = totalAmountBeforeTax;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    ws.getCell(`H${currentRow}`).font = { bold: true };
    ws.getCell(`H${currentRow}`).fill = grayFill;
    applyBorder(`A${currentRow}`, `H${currentRow}`);
    currentRow++;

    // Bottom section: Goods Despatched
    ws.mergeCells(`A${currentRow}:C${currentRow}`);
    const cellGoodsTitle = ws.getCell(`A${currentRow}`);
    cellGoodsTitle.value = "✅ GOODS DISPATCHED";
    cellGoodsTitle.font = { bold: true, color: { argb: "FF000080" } };
    cellGoodsTitle.alignment = { horizontal: "center" };

    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Total Amount Before Tax";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = totalAmountBeforeTax;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    ws.getCell(`H${currentRow}`).font = { bold: true };
    currentRow++;

    ws.mergeCells(`A${currentRow}:C${currentRow + 1}`);
    const wordAmount = numberToWords(totalAmountAfterTax);
    const cellWords = ws.getCell(`A${currentRow}`);
    cellWords.value = `Rupees in words: ${wordAmount}`;
    cellWords.font = { bold: true, color: { argb: "FF000080" } };
    cellWords.alignment = { vertical: "top", wrapText: true };

    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Add : CGST*";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = cgst;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    ws.getCell(`H${currentRow}`).font = { bold: true };
    currentRow++;

    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Add : SGST*";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = sgst;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    ws.getCell(`H${currentRow}`).font = { bold: true };
    currentRow++;

    ws.mergeCells(`A${currentRow}:C${currentRow}`);
    const cellBankTitle = ws.getCell(`A${currentRow}`);
    cellBankTitle.value = "Company's Bank Details :";
    cellBankTitle.font = { bold: true };

    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Total Amount After GST";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = totalAmountAfterTax;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    ws.getCell(`H${currentRow}`).font = { bold: true };
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "Name of Account";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.company_name || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };
    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Forwarding";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = 0.0;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "Name of Bank";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.bank_name || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };
    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Postage";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = 0.0;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "Branch Name";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.branch || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };
    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Other charges if any";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = 0.0;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "Account No.";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.account_number || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };
    ws.mergeCells(`D${currentRow}:E${currentRow}`);
    ws.getCell(`D${currentRow}`).value = "Ps.Rounded Off";
    ws.mergeCells(`F${currentRow}:G${currentRow}`);
    ws.getCell(`F${currentRow}`).value = "Rs.";
    ws.getCell(`H${currentRow}`).value = 0.0;
    ws.getCell(`H${currentRow}`).numFmt = "0.00";
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "IFSC Code";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.ifsc_code || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };

    ws.mergeCells(`D${currentRow}:G${currentRow}`);
    const cellNet = ws.getCell(`D${currentRow}`);
    cellNet.value = "Net Total";
    cellNet.font = { bold: true, size: 14 };
    cellNet.fill = grayFill;
    const cellNetTotal = ws.getCell(`H${currentRow}`);
    cellNetTotal.value = totalAmountAfterTax;
    cellNetTotal.numFmt = "0.00";
    cellNetTotal.font = { bold: true, size: 14 };
    cellNetTotal.fill = grayFill;
    currentRow++;

    ws.getCell(`A${currentRow}`).value = "PAN";
    ws.getCell(`B${currentRow}`).value = ":";
    ws.getCell(`B${currentRow}`).alignment = { horizontal: "center" };
    ws.getCell(`C${currentRow}`).value = issuing?.pan || "";
    ws.getCell(`C${currentRow}`).font = { bold: true };
    ws.mergeCells(`D${currentRow}:H${currentRow}`);

    applyBorder("A17", `C${currentRow}`);
    applyBorder("D17", `H${currentRow}`);

    currentRow++;
    ws.mergeCells(`A${currentRow}:D${currentRow + 3}`);
    const tc = ws.getCell(`A${currentRow}`);
    tc.value =
      "Terms & Conditions :\n1. Interest @ 24% p.a. Will be charged for overdue bills (more than 30 days).\n2. All disputes are subject to Chennai Jurisdiction";
    tc.alignment = { vertical: "top", wrapText: true };
    tc.font = { size: 9 };

    ws.mergeCells(`E${currentRow}:H${currentRow + 3}`);
    const sig = ws.getCell(`E${currentRow}`);
    sig.value = `Certified that the particulars given above are true and correct\nFor ${issuing?.company_name || ""}\n\n\nAuthorised Signatory`;
    sig.alignment = { horizontal: "center", vertical: "top", wrapText: true };
    sig.font = { bold: true, color: { argb: "FF000080" } };

    applyBorder(`A${currentRow}`, `H${currentRow + 3}`);

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer as any;
  };

  const docPrefix = isChallan ? "Delivery_Challan_" : "";

  if (batch.batch_type === "PURCHASE") {
    const pdfBuffer = await generatePurchasePDFBuffer(
      inv,
      batch.issuing_companies,
      customer || {},
    );
    return new NextResponse(pdfBuffer as any, {
      status: 200,
      headers: {
        "Content-Disposition": `attachment; filename="${docPrefix}${inv.invoice_number}.pdf"`,
        "Content-Type": "application/pdf",
      },
    });
  }

  const excelBuffer = await generateExcelBuffer(
    inv,
    batch.issuing_companies,
    customer || {},
  );

  return new NextResponse(excelBuffer as any, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="${docPrefix}${inv.invoice_number}.xlsx"`,
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
