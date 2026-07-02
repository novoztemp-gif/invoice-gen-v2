import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

export async function GET() {
  const headers = [
    "Company Name",
    "Address",
    "GSTIN",
    "Phone",
    "PAN",
    "Branch",
    "Bank Account Name",
    "Bank Name",
    "Account Number",
    "IFSC Code",
  ];
  const exampleRow = [
    "ABC Issuers",
    "123 Delhi Road",
    "07ABCDE1234F1Z5",
    "9876543210",
    "ABCDE1234F",
    "Main Branch",
    "ABC Issuers Pvt Ltd",
    "State Bank of India",
    "12345678901",
    "SBIN0001234",
  ];

  const worksheet = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Template");

  // Generate buffer for Excel
  const buf = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buf, {
    headers: {
      "Content-Disposition":
        'attachment; filename="issuing_company_bulk_upload_template.xlsx"',
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });
}
