import { NextRequest, NextResponse } from "next/server";
import { SalesInvoiceValidator } from "@/lib/services/sales-balance/SalesInvoiceValidator";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only "how much of this product is allocated in this Sales batch"
 * figure — powers the Quick Add stock hints in InvoiceEditor for Sales
 * batches.
 *
 * A generated Sales batch is a closed system: every unit of every product
 * was already fully allocated across the batch's invoices at generation/
 * Auto Allocate time (any leftover became carry-forward for the NEXT
 * batch, not something this one can still draw on). Editing never adds or
 * removes stock from that pool — it only moves quantity of the SAME
 * product between invoices, or spins up a new invoice for it — so the
 * number that matters here is the fixed total already allocated to that
 * product across the whole batch (context.originalProductTotals), not any
 * notion of "unsold" or "remaining" stock, which doesn't meaningfully
 * exist inside an already-generated batch.
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

    const capacities: Record<string, number> = {};
    for (const productId of batchProductIds) {
      capacities[productId] =
        Math.round((context.originalProductTotals.get(productId) || 0) * 100) /
        100;
    }

    return NextResponse.json({ capacities });
  } catch (error: any) {
    console.error("Sales invoice product capacity error:", error);
    return NextResponse.json(
      { message: error.message || "Unable to compute product capacity." },
      { status: 500 },
    );
  }
}
