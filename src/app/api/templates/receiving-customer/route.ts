import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

export async function GET() {
  const headers = [
    "Customer Name",
    "Address",
    "GSTIN",
    "PAN",
    "State",
    "State Code",
  ];
  const exampleRow = [
    "ABC Traders",
    "123 Chennai Road",
    "33ABCDE1234F1Z5",
    "ABCDE1234F",
    "Tamil Nadu",
    "33",
  ];
  const exampleRow2 = [
    "XYZ Agency",
    "456 Bengaluru St",
    "", // Blank GSTIN
    "", // Blank PAN
    "Karnataka",
    "29",
  ];

  const worksheet = XLSX.utils.aoa_to_sheet([headers, exampleRow, exampleRow2]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Template");

  // Generate buffer for Excel
  const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buf, {
    headers: {
      "Content-Disposition":
        'attachment; filename="receiving_customer_bulk_upload_template.xlsx"',
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
