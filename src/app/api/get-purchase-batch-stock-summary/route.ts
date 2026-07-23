import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const batchIdParam = searchParams.get("batchId");

    if (!batchIdParam) {
      return NextResponse.json(
        { message: "batchId is required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // Support single or multiple comma-separated batch IDs
    const batchIds = batchIdParam
      .split(",")
      .map((id) => id.trim())
      .filter((id) => Boolean(id) && !id.startsWith("CARRY_FORWARD_"));

    if (batchIds.length === 0) {
      // Return carry-forward stock only if no purchase batch ID is passed
      const carryForwardStock = await InvoiceEngine.getCarryForwardStock(
        supabase,
        new Date().toISOString().slice(0, 10),
      );

      const { data: products } = await supabase
        .from("products")
        .select("id, product_name, unit_of_measure");

      const summary = (products || []).map((prod: any) => {
        const carryForward = carryForwardStock.get(prod.id) || 0;
        return {
          product_id: prod.id,
          product_name: prod.product_name || "Unknown Product",
          carry_forward: carryForward,
          purchased: 0,
          total_available: carryForward,
          unit: prod.unit_of_measure || "kg",
        };
      });

      return NextResponse.json({
        success: true,
        summary,
        batchDetails: {
          id: "CARRY_FORWARD",
          total_amount: 0,
          invoice_date_from: "",
          invoice_date_to: "",
          products_count: (products || []).length,
        },
      });
    }

    // 1. Fetch details of all selected Purchase Batches
    const { data: batches, error: batchError } = await supabase
      .from("invoice_batch")
      .select("id, total_amount, invoice_date_from, invoice_date_to, products")
      .in("id", batchIds);

    if (batchError || !batches || batches.length === 0) {
      return NextResponse.json(
        {
          message: `Failed to load purchase batch(es): ${batchError?.message || "Not found"}`,
        },
        { status: 400 },
      );
    }

    const primaryBatch = batches[0];
    const earliestDate = batches.reduce(
      (min, b) => (b.invoice_date_from < min ? b.invoice_date_from : min),
      primaryBatch.invoice_date_from,
    );

    // 2. Compute carry-forward stock from previous finalized batches
    const carryForwardStock = await InvoiceEngine.getCarryForwardStock(
      supabase,
      earliestDate,
    );

    // 3. Sum up purchased quantities across all selected batches in daily_stock_ledger
    const { data: ledgerRows, error: ledgerError } = await supabase
      .from("daily_stock_ledger")
      .select("product_id, purchased_quantity, sold_quantity")
      .in("purchase_batch_id", batchIds);

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
      const purchased = Number(row.purchased_quantity || 0);
      const prevSold = Number(row.sold_quantity || 0);
      const availableFromBatch = Math.max(0, purchased - prevSold);
      purchasedSums.set(
        row.product_id,
        (purchasedSums.get(row.product_id) || 0) + availableFromBatch,
      );
    }

    // Aggregate unique products across selected batches
    const productMap = new Map<string, any>();
    let totalCombinedAmount = 0;

    for (const b of batches) {
      totalCombinedAmount += Number(b.total_amount || 0);
      for (const prod of b.products || []) {
        if (!productMap.has(prod.product_id)) {
          productMap.set(prod.product_id, prod);
        }
      }
    }

    // 4. Group and format products details
    const summary = Array.from(productMap.values()).map((prod: any) => {
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
      batchDetails: {
        id: primaryBatch.id,
        total_amount: Math.round(totalCombinedAmount * 100) / 100,
        invoice_date_from: primaryBatch.invoice_date_from,
        invoice_date_to: primaryBatch.invoice_date_to,
        products_count: summary.length,
      },
    });
  } catch (error: any) {
    console.error("Error fetching purchase batch stock summary:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
