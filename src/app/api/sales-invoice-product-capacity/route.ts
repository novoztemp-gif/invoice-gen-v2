import { NextRequest, NextResponse } from "next/server";
import { SalesInvoiceValidator } from "@/lib/services/sales-balance/SalesInvoiceValidator";
import {
  computeEditableDayPool,
  loadDayAvailability,
} from "@/lib/services/sales-balance/SalesDayStockAvailability";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only "available stock" figure shown in InvoiceEditor for Sales
 * batches — the day's total physical stock minus whatever's permanently
 * reserved by Major Customer invoices (never touchable, never an edit
 * target). This is a reference ceiling, not a hard per-line cap: a
 * day-scoped edit can redistribute quantity between regular invoices on
 * the same day (see SalesDayScopedEditEngine), so the real answer to
 * "can I actually make this specific change" depends on live allocations
 * across every invoice that day, not just this one — checked for real at
 * save time, which is why an edit within this figure can still be
 * rejected as "not possible" if the redistribution itself doesn't work
 * out (e.g. a peer's own quantity floor).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { batchId, invoiceId } = body;

    if (!batchId || !invoiceId) {
      return NextResponse.json(
        { message: "batchId and invoiceId are required" },
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

    const context = await SalesInvoiceValidator.loadContext(supabase, batchId);
    const editedInvoiceFromDb = context.invoices.find(
      (inv) => inv.id === invoiceId,
    );
    if (!editedInvoiceFromDb) {
      return NextResponse.json(
        { message: "Invoice does not belong to this sales batch." },
        { status: 404 },
      );
    }

    const { data: batchRow } = await supabase
      .from("invoice_batch")
      .select("products")
      .eq("id", batchId)
      .single();
    const batchProductIds = Array.from(
      new Set(
        ((batchRow?.products as any[]) || [])
          .map((p) => p.product_id)
          .filter(Boolean),
      ),
    );

    const invoiceDate = editedInvoiceFromDb.invoice_date;
    const stockSourceBatchIds = context.stockSourceBatchId
      ? context.stockSourceBatchId
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];
    const staticAvailable = await loadDayAvailability(
      supabase,
      stockSourceBatchIds,
      invoiceDate,
    );
    const editableDayPool = computeEditableDayPool(
      context,
      staticAvailable,
      invoiceDate,
    );

    const capacities: Record<string, number> = {};
    for (const productId of batchProductIds) {
      capacities[productId] =
        Math.round((editableDayPool.get(productId) || 0) * 100) / 100;
    }

    return NextResponse.json({ capacities, date: invoiceDate });
  } catch (error: any) {
    console.error("Sales invoice product capacity error:", error);
    return NextResponse.json(
      { message: error.message || "Unable to compute product capacity." },
      { status: 500 },
    );
  }
}
