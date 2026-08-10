import { NextRequest, NextResponse } from "next/server";
import { PurchaseInvoiceValidator } from "@/lib/services/purchase-balance/PurchaseInvoiceValidator";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only Quick Add hint for the purchase invoice editor: the TOTAL
 * quantity of each product already present across the whole generated
 * batch (every invoice, not just this one) — a fixed reference figure, not
 * a computed "room left" estimate.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { batchId, invoiceId, draftProducts } = body;

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

    const validator = new PurchaseInvoiceValidator(supabase);
    const context = await validator.loadContext(batchId);
    const editedInvoiceFromDb = context.invoices.find(
      (inv) => inv.id === invoiceId,
    );
    if (!editedInvoiceFromDb) {
      return NextResponse.json(
        { message: "Invoice does not belong to this purchase batch." },
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
      capacities[productId] = 0;
    }
    for (const inv of context.invoices) {
      for (const p of inv.products || []) {
        if (!p.product_id) continue;
        capacities[p.product_id] =
          (capacities[p.product_id] || 0) + Number(p.quantity || 0);
      }
    }

    return NextResponse.json({ capacities });
  } catch (error: any) {
    console.error("Purchase invoice product capacity error:", error);
    return NextResponse.json(
      { message: error.message || "Unable to compute product capacity." },
      { status: 500 },
    );
  }
}
