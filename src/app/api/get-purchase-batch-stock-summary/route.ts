import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import {
  getFinalClosingStockByProduct,
  type StockLedgerRow,
} from "@/lib/services/StockCalculationService";
import { fetchAllQueryRows, fetchRowsByIds } from "@/lib/supabase/fetchAll";
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
    const batches = await fetchRowsByIds(
      (chunk) =>
        supabase
          .from("invoice_batch")
          .select(
            "id, total_amount, invoice_date_from, invoice_date_to, financial_year, products",
          )
          .in("id", chunk),
      batchIds,
    );

    if (!batches || batches.length === 0) {
      return NextResponse.json(
        {
          message: `Failed to load purchase batch(es): Not found`,
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
            "purchase_batch_id, product_id, ledger_date, opening_stock, purchased_quantity, sold_quantity",
          )
          .in("purchase_batch_id", batchIds)
          .order("purchase_batch_id", { ascending: true })
          .order("ledger_date", { ascending: true })
          .order("product_id", { ascending: true })
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
        .order("id", { ascending: true })
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

    // 1. If daily_stock_ledger has rows for these batches, compute each
    // batch's own remaining stock per product via the shared
    // StockCalculationService's chronological recurrence, then attribute
    // it to "purchased" (fresh) or "carry_forward" (opening, from a
    // touched/leftover batch) per that specific batch's own state, never
    // a global, unscoped carry-forward across the whole system. This is
    // what makes selecting a fresh Purchase Batch alone show
    // purchased-only (no opening stock), while a Leftover Stock source's
    // remaining quantity counts as opening stock — and combining both in
    // one selection sums opening + purchased = total, per product.
    //
    // Computed per BATCH (not merged across batches first) — each
    // selected purchase batch's own ledger rows are walked chronologically
    // on their own, since a batch's "touched" status decides which bucket
    // (carry_forward vs purchased) its result lands in, and merging
    // multiple batches' rows into one chronological sequence per product
    // would blur that distinction.
    if (ledgerRows && ledgerRows.length > 0) {
      const rowsByBatch = new Map<string, StockLedgerRow[]>();
      for (const row of ledgerRows) {
        if (!row.product_id) continue;
        const list = rowsByBatch.get(row.purchase_batch_id);
        if (list) {
          list.push(row);
        } else {
          rowsByBatch.set(row.purchase_batch_id, [row]);
        }
      }

      for (const [batchId, rows] of rowsByBatch.entries()) {
        const closingByProduct = getFinalClosingStockByProduct(rows);
        const target = touchedBatchIds.has(batchId)
          ? carryForwardSums
          : purchasedSums;
        for (const [productId, closing] of closingByProduct.entries()) {
          target.set(productId, (target.get(productId) || 0) + closing);
        }
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
        // Sourced from invoice_batch.financial_year (the same column the
        // Purchase batch itself was created with, format "FY2025-26") —
        // added for Sprint 1.3B's Sales auto-fill. Same pre-existing
        // pattern as invoice_date_from/to above: reflects primaryBatch
        // (the first selected batch) regardless of how many batches are
        // selected — not a new multi-batch rule, just extending what
        // dates already did.
        financial_year: primaryBatch.financial_year || null,
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
