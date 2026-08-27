import { NextResponse } from "next/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only diagnostic: for every FINALIZED purchase batch, reports total
 * purchased vs total sold (from daily_stock_ledger) plus per-date/product
 * breakdown for the batch with the largest purchased-minus-sold gap, so we
 * can see exactly where a stock consumption mismatch is happening.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    // Hotfix — was a single unpaginated, unchecked `.select()`. Finalized
    // purchase batches only ever accumulate (never shrink), so once the
    // count crosses PostgREST's default 1000-row page cap, this silently
    // returned an incomplete list with no error.
    const batches = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice_batch")
        .select("id, total_amount, invoice_date_from, invoice_date_to, batch_status")
        .eq("batch_type", "PURCHASE")
        .eq("batch_status", "FINALIZED")
        .order("id", { ascending: true })
        .range(from, to),
    );

    const batchIds = batches.map((b: any) => b.id);

    // Hotfix — batchIds (every finalized purchase batch, all-time) used
    // to be embedded whole into one `.in()` filter, unbounded — same
    // growth-risk shape as the 469-supplier bug. Chunked here, each
    // chunk still paginated.
    const BATCH_ID_CHUNK_SIZE = 150;
    const ledgerRows: any[] = [];
    if (batchIds.length > 0) {
      for (let i = 0; i < batchIds.length; i += BATCH_ID_CHUNK_SIZE) {
        const idChunk = batchIds.slice(i, i + BATCH_ID_CHUNK_SIZE);
        const rows = await fetchAllQueryRows((from, to) =>
          supabase
            .from("daily_stock_ledger")
            .select("purchase_batch_id, product_id, ledger_date, opening_stock, purchased_quantity, sold_quantity")
            .in("purchase_batch_id", idChunk)
            .order("purchase_batch_id", { ascending: true })
            .order("ledger_date", { ascending: true })
            .order("product_id", { ascending: true })
            .range(from, to),
        );
        ledgerRows.push(...rows);
      }
    }

    const byBatch = new Map<string, { purchased: number; sold: number; rows: number }>();
    for (const row of ledgerRows) {
      const b = byBatch.get(row.purchase_batch_id) || { purchased: 0, sold: 0, rows: 0 };
      b.purchased += Number(row.purchased_quantity || 0);
      b.sold += Number(row.sold_quantity || 0);
      b.rows += 1;
      byBatch.set(row.purchase_batch_id, b);
    }

    const summary = (batches || []).map((b: any) => {
      const agg = byBatch.get(b.id) || { purchased: 0, sold: 0, rows: 0 };
      return {
        batchId: b.id,
        invoice_date_from: b.invoice_date_from,
        invoice_date_to: b.invoice_date_to,
        total_amount: b.total_amount,
        ledgerRows: agg.rows,
        totalPurchased: Math.round(agg.purchased * 100) / 100,
        totalSold: Math.round(agg.sold * 100) / 100,
        remaining: Math.round((agg.purchased - agg.sold) * 100) / 100,
      };
    });

    summary.sort((a, b) => b.remaining - a.remaining);

    const worst = summary[0];
    let worstBatchDetail: any = null;
    if (worst) {
      const detailRows = ledgerRows
        .filter((r: any) => r.purchase_batch_id === worst.batchId)
        .map((r: any) => ({
          product_id: r.product_id,
          ledger_date: r.ledger_date,
          opening_stock: Number(r.opening_stock || 0),
          purchased_quantity: Number(r.purchased_quantity || 0),
          sold_quantity: Number(r.sold_quantity || 0),
        }))
        .sort((a: any, b: any) => a.ledger_date.localeCompare(b.ledger_date));
      worstBatchDetail = detailRows;
    }

    return NextResponse.json({
      batchSummary: summary,
      worstBatchId: worst?.batchId,
      worstBatchLedgerRows: worstBatchDetail,
    });
  } catch (error: any) {
    console.error("Debug ledger summary error:", error);
    return NextResponse.json(
      { message: error.message || "Failed" },
      { status: 500 },
    );
  }
}
