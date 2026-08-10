import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
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
      .filter((id) => Boolean(id));

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

    // 2. Sum up purchased quantities across all selected batches. Paginated
    // — a batch with many products/days easily exceeds PostgREST's default
    // 1000-row cap, which would silently drop whichever products' rows
    // fell past the cutoff (no ordering is specified, so it's effectively
    // arbitrary which products go missing).
    let ledgerRows: any[] = [];
    let ledgerError: any = null;
    try {
      ledgerRows = await fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select(
            "purchase_batch_id, product_id, purchased_quantity, sold_quantity",
          )
          .in("purchase_batch_id", batchIds)
          .range(from, to),
      );
    } catch (err: any) {
      ledgerError = err;
    }

    // Paginate through invoice table to fetch ALL purchase invoices without PostgREST 1000-row cap
    const purchaseInvoices: any[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data: pageInvoices } = await supabase
        .from("invoice")
        .select("invoice_batch_id, products")
        .in("invoice_batch_id", batchIds)
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (pageInvoices && pageInvoices.length > 0) {
        purchaseInvoices.push(...pageInvoices);
        if (pageInvoices.length < pageSize) {
          hasMore = false;
        } else {
          page++;
        }
      } else {
        hasMore = false;
      }
    }

    if (ledgerError) {
      return NextResponse.json(
        {
          message: `Failed to load daily stock ledger: ${ledgerError.message}`,
        },
        { status: 500 },
      );
    }

    // A batch counts as "touched" (Leftover Stock semantics) if ANY of its
    // ledger rows show sold_quantity > 0 — recomputed here server-side
    // rather than trusting a client-supplied flag, mirroring the same rule
    // fetchAvailableSources() uses on the frontend to label a card
    // "Leftover Stock". Untouched batches are fresh "Purchase Batch"
    // sources.
    const touchedBatchIds = new Set<string>();
    for (const row of ledgerRows || []) {
      if (Number(row.sold_quantity || 0) > 0.001 && row.purchase_batch_id) {
        touchedBatchIds.add(row.purchase_batch_id);
      }
    }

    const purchasedSums = new Map<string, number>();
    const carryForwardSums = new Map<string, number>();

    // 1. If daily_stock_ledger has rows for these batches, sum each batch's
    // own net remaining (purchased - sold) across days — attributed to
    // "purchased" (fresh) or "carry_forward" (opening, from a touched/
    // leftover batch) per that specific batch's own state, never a global,
    // unscoped carry-forward across the whole system. This is what makes
    // selecting a fresh Purchase Batch alone show purchased-only (no
    // opening stock), while a Leftover Stock source's remaining quantity
    // counts as opening stock — and combining both in one selection sums
    // opening + purchased = total, per product.
    if (ledgerRows && ledgerRows.length > 0) {
      for (const row of ledgerRows) {
        if (!row.product_id) continue;
        const purchased = Number(row.purchased_quantity || 0);
        const sold = Number(row.sold_quantity || 0);
        const net = Math.max(0, purchased - sold);
        const target = touchedBatchIds.has(row.purchase_batch_id)
          ? carryForwardSums
          : purchasedSums;
        target.set(row.product_id, (target.get(row.product_id) || 0) + net);
      }
    }

    // 2. Only fall back to summing ALL purchase invoices when daily_stock_ledger
    // genuinely has no rows for these batches. A net sum of 0 with real ledger
    // rows present means the batch is fully consumed, not unposted — that must
    // NOT fall back to showing the original gross purchase amount.
    if (
      (!ledgerRows || ledgerRows.length === 0) &&
      purchaseInvoices &&
      purchaseInvoices.length > 0
    ) {
      purchasedSums.clear();
      for (const inv of purchaseInvoices) {
        for (const p of inv.products || []) {
          if (p.product_id) {
            const qty = Number(p.quantity || 0);
            purchasedSums.set(
              p.product_id,
              (purchasedSums.get(p.product_id) || 0) + qty,
            );
          }
        }
      }
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
      const pId = prod.product_id;
      const carryForward = carryForwardSums.get(pId) || 0;
      const purchased = purchasedSums.get(pId) || 0;
      const totalAvailable = carryForward + purchased;

      return {
        product_id: pId,
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
        products: Array.from(productMap.values()),
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
