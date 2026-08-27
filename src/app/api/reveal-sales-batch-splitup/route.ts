import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const { batchId } = await request.json();

    if (!batchId) {
      return NextResponse.json(
        { message: "batchId is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Hotfix — this route had no explicit auth check, unlike most of
    // its siblings, relying entirely on the blanket middleware redirect.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("id, batch_type, status, stock_source_batch_id")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      return NextResponse.json(
        { message: `Failed to load batch: ${batchError?.message || "Not found"}` },
        { status: 400 },
      );
    }

    if (batch.batch_type !== "SALES") {
      return NextResponse.json(
        { message: "This endpoint only reveals SALES batch splitups" },
        { status: 400 },
      );
    }

    if (batch.status !== "pending") {
      return NextResponse.json({
        success: true,
        message: "Batch splitup already revealed.",
      });
    }

    const { error: invoiceUpdateError } = await supabase
      .from("invoice")
      .update({ status: "generated" })
      .eq("invoice_batch_id", batchId);

    if (invoiceUpdateError) {
      return NextResponse.json(
        {
          message: `Failed to reveal invoices: ${invoiceUpdateError.message}`,
        },
        { status: 500 },
      );
    }

    const { error: batchUpdateError } = await supabase
      .from("invoice_batch")
      .update({ status: "generated" })
      .eq("id", batchId);

    if (batchUpdateError) {
      return NextResponse.json(
        { message: `Failed to update batch status: ${batchUpdateError.message}` },
        { status: 500 },
      );
    }

    // The source purchase batch's daily_stock_ledger sold_quantity was
    // already updated when this batch was created/confirmed in the Daily
    // Stock Review modal — postSalesBatchStockLedger is not idempotent
    // (it ADDS to whatever's already recorded), so this endpoint must
    // only ever flip status, never post to the ledger again.

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error revealing sales batch splitup:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
