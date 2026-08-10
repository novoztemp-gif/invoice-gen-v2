import { NextRequest, NextResponse } from "next/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only diagnostic: for a given Sales batch + product, reports the
 * product's configured quantity/rate rules, every invoice line currently
 * holding it (with date + quantity), and the source purchase batch's
 * daily_stock_ledger availability per date — to see whether a redistribution
 * failure is a genuine capacity limit or a computation bug.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const batchId = searchParams.get("batchId");
    const productId = searchParams.get("productId");
    if (!batchId || !productId) {
      return NextResponse.json(
        { message: "batchId and productId are required" },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { data: batch } = await supabase
      .from("invoice_batch")
      .select("id, stock_source_batch_id, maximum_invoice_amount")
      .eq("id", batchId)
      .single();

    const { data: rule } = await supabase
      .from("product_rules")
      .select("product_id, quantity_min, quantity_max, rate_min, rate_max")
      .eq("product_id", productId)
      .maybeSingle();

    const invoices = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice")
        .select("id, invoice_number, invoice_date, products, total_amount")
        .eq("invoice_batch_id", batchId)
        .range(from, to),
    );

    const linesForProduct = invoices
      .map((inv: any) => {
        const lines = (inv.products || []).filter(
          (p: any) => p.product_id === productId,
        );
        if (lines.length === 0) return null;
        return {
          invoice_number: inv.invoice_number,
          invoice_date: inv.invoice_date,
          invoice_total: inv.total_amount,
          lines: lines.map((l: any) => ({
            quantity: l.quantity,
            rate: l.rate,
            amount: l.amount,
          })),
        };
      })
      .filter(Boolean);

    const totalQty = linesForProduct.reduce(
      (sum: number, inv: any) =>
        sum + inv.lines.reduce((s: number, l: any) => s + l.quantity, 0),
      0,
    );

    let ledgerRows: any[] = [];
    if (batch?.stock_source_batch_id) {
      const stockBatchIds = String(batch.stock_source_batch_id)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      ledgerRows = await fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select("ledger_date, opening_stock, purchased_quantity, sold_quantity")
          .in("purchase_batch_id", stockBatchIds)
          .eq("product_id", productId)
          .order("ledger_date", { ascending: true })
          .range(from, to),
        // Single product_id already, so no tie-break needed here.
      );
    }

    return NextResponse.json({
      productId,
      rule,
      maximum_invoice_amount: batch?.maximum_invoice_amount,
      totalInvoicesHoldingProduct: linesForProduct.length,
      totalQuantityAcrossBatch: totalQty,
      linesForProduct,
      ledgerRows,
    });
  } catch (error: any) {
    return NextResponse.json(
      { message: error.message || "Failed" },
      { status: 500 },
    );
  }
}
