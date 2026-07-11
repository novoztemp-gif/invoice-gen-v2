import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("batchId");

    if (!batchId) {
      return NextResponse.json(
        { message: "batchId is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // 1. Fetch the selected Purchase Batch details
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("id, invoice_date_from, products")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      return NextResponse.json(
        {
          message: `Failed to load purchase batch: ${batchError?.message || "Not found"}`,
        },
        { status: 400 },
      );
    }

    // 2. Compute carry-forward stock from previous finalized batches
    const carryForwardStock = await InvoiceEngine.getCarryForwardStock(
      supabase,
      batch.invoice_date_from,
    );

    // 3. Sum up current batch purchased quantities per product in daily_stock_ledger
    const { data: ledgerRows, error: ledgerError } = await supabase
      .from("daily_stock_ledger")
      .select("product_id, purchased_quantity")
      .eq("purchase_batch_id", batchId);

    if (ledgerError) {
      return NextResponse.json(
        {
          message: `Failed to load daily stock ledger: ${ledgerError.message}`,
        },
        { status: 500 },
      );
    }

    const purchasedSums = new Map<string, number>();
    for (const row of ledgerRows || []) {
      purchasedSums.set(
        row.product_id,
        (purchasedSums.get(row.product_id) || 0) +
          Number(row.purchased_quantity || 0),
      );
    }

    // 4. Group and format products details
    const summary = (batch.products || []).map((prod: any) => {
      const carryForward = carryForwardStock.get(prod.product_id) || 0;
      const purchased = purchasedSums.get(prod.product_id) || 0;
      const totalAvailable = carryForward + purchased;

      return {
        product_id: prod.product_id,
        product_name: prod.product_name || "Unknown Product",
        carry_forward: carryForward,
        purchased: purchased,
        total_available: totalAvailable,
        unit: prod.unit_of_measure || "kg",
      };
    });

    return NextResponse.json({
      success: true,
      summary,
    });
  } catch (error: any) {
    console.error("Error fetching purchase batch stock summary:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
