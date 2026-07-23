import { NextRequest, NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";

export async function POST(request: NextRequest) {
  try {
    const { batchId, action } = await request.json();

    if (!batchId || !action) {
      return NextResponse.json(
        { message: "Missing batchId or action" },
        { status: 400 },
      );
    }

    if (action !== "FINALIZE" && action !== "REOPEN") {
      return NextResponse.json({ message: "Invalid action" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    if (action === "FINALIZE") {
      let invoices: any[] = [];
      try {
        invoices = await fetchAllInvoicesForBatch(supabase, batchId);
      } catch (fetchError: any) {
        return NextResponse.json(
          { message: "Failed to fetch invoices for finalization check." },
          { status: 500 },
        );
      }

      if (!invoices || invoices.length === 0) {
        return NextResponse.json(
          { message: "Cannot finalize a batch with no invoices." },
          { status: 400 },
        );
      }

      const invalidInvoices: string[] = [];
      for (const inv of invoices) {
        const validation = InvoiceEngine.validateInvoiceData(inv);
        if (!validation.isValid) {
          invalidInvoices.push(
            `${inv.invoice_number || inv.id}: ${validation.message}`,
          );
        }
      }

      if (invalidInvoices.length > 0) {
        return NextResponse.json(
          {
            message:
              "Batch finalization blocked. The following invoices violate accounting rules (negative or zero values found):",
            details: invalidInvoices,
          },
          { status: 400 },
        );
      }
    }

    await InvoiceEngine.updateBatchStatus(supabase, batchId, action, user.id);

    return NextResponse.json({
      success: true,
      message: `Batch successfully ${action === "FINALIZE" ? "finalized" : "reopened"}.`,
    });
  } catch (error: any) {
    console.error("Batch Status API Error:", error);
    return NextResponse.json(
      { message: error.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
