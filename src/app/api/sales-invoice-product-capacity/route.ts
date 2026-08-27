import { NextRequest, NextResponse } from "next/server";
import { SalesInvoiceValidator } from "@/lib/services/sales-balance/SalesInvoiceValidator";
import {
  computeAvailableForEdit,
  loadDayAvailability,
} from "@/lib/services/sales-balance/SalesDayStockAvailability";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only "how much of this product can be added to THIS invoice right
 * now" figure — powers the Quick Add stock hints in InvoiceEditor for
 * Sales batches.
 *
 * Sales invoice editing is day-scoped (see SalesDayScopedEditEngine): an
 * edit can only draw on stock physically available on the edited
 * invoice's own day, no cross-day borrowing. This mirrors exactly what
 * the engine enforces at save time via the same
 * loadDayAvailability/computeAvailableForEdit helpers, so the badge shown
 * here can never drift from what saving will actually allow.
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
    const availableForEdit = computeAvailableForEdit(
      context,
      staticAvailable,
      invoiceDate,
      invoiceId,
    );

    const capacities: Record<string, number> = {};
    for (const productId of batchProductIds) {
      capacities[productId] =
        Math.round((availableForEdit.get(productId) || 0) * 100) / 100;
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
