import { readFile } from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { SummaryWorkbookService } from "@/lib/services/SummaryWorkbookService";
import { createClient } from "@/lib/supabase/server";
import { fetchAllInvoicesForBatch, fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { applyXlsmTemplate } from "@/lib/utils/xlsmPackager";

const XLSM_TEMPLATE_PATH = path.join(
  process.cwd(),
  "templates",
  "BLANK EXCEL.xlsm",
);

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

    // Fetch all final saved invoice data from this batch without 1000-row PostgREST truncation
    let invoices: any[] = [];
    try {
      invoices = await fetchAllInvoicesForBatch(supabase, batchId);
    } catch (invoicesError: any) {
      console.error("Error fetching all invoices for summary:", invoicesError);
      return NextResponse.json(
        { message: "Failed to load invoices for summary" },
        { status: 500 },
      );
    }

    if (!invoices || invoices.length === 0) {
      return NextResponse.json(
        { message: "No invoices found for this batch" },
        { status: 404 },
      );
    }

    // Hotfix — both were single unpaginated, unchecked fetches. Once
    // either table crosses PostgREST's default 1000-row page cap (very
    // plausible over years of operation — customers/suppliers accumulate
    // and are rarely deleted), newer companies silently vanished from
    // this export ("Unknown Company"/"N/A" GSTIN) with no error raised.
    const receivingCompaniesList = await fetchAllQueryRows((from, to) =>
      supabase
        .from("receiving_companies")
        .select("*")
        .order("id", { ascending: true })
        .range(from, to),
    );
    const suppliersList = await fetchAllQueryRows((from, to) =>
      supabase
        .from("suppliers")
        .select("*")
        .order("id", { ascending: true })
        .range(from, to),
    );

    const partnerMap = new Map();
    if (receivingCompaniesList) {
      for (const comp of receivingCompaniesList) {
        partnerMap.set(comp.id, comp);
      }
    }
    if (suppliersList) {
      for (const sup of suppliersList) {
        partnerMap.set(sup.id, {
          ...sup,
          company_name: sup.supplier_name || sup.name || sup.company_name,
        });
      }
    }

    // Issuing company details for the invoice sheets' header — the old
    // summary sheets never needed this, so it wasn't fetched before.
    let issuingCompany: any = null;
    if (batch.issuing_company_id) {
      const { data: issuingCompanyRow } = await supabase
        .from("issuing_companies")
        .select("*")
        .eq("id", batch.issuing_company_id)
        .single();
      issuingCompany = issuingCompanyRow || null;
    }

    const xlsxWorkbook = await SummaryWorkbookService.build({
      batch,
      invoices,
      partnerMap,
      issuingCompany,
    });
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
        ? `Summary_Purchase_Batch${batchNumberStr}.xlsm`
        : `Summary_Sales_Batch${batchNumberStr}.xlsm`;

    // Generate the plain xlsx buffer, then graft the macro-enabled typing
    // (and, once one exists, the actual VBA project) from the supplied
    // template onto it — see xlsmPackager.ts for why this has to be a
    // package-level splice rather than something ExcelJS can do directly.
    const xlsxBuffer = await xlsxWorkbook.xlsx.writeBuffer();
    const templateBuffer = await readFile(XLSM_TEMPLATE_PATH);
    const xlsmBuffer = await applyXlsmTemplate(xlsxBuffer, templateBuffer);

    return new NextResponse(xlsmBuffer as any, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "application/vnd.ms-excel.sheet.macroEnabled.12",
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
