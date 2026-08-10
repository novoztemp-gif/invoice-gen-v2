import { NextRequest, NextResponse } from "next/server";
import { fetchAllInvoicesForBatch, fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only diagnostic: for a given SALES batch, compares — per product —
 * the TOTAL quantity ever purchased in the source purchase batch(es)
 * (opening stock of the first ledger row + every purchased_quantity row,
 * summed) against the TOTAL quantity CURRENTLY sold, computed live by
 * summing every sales invoice's product lines directly (not the possibly
 * stale daily_stock_ledger.sold_quantity, which is only updated at
 * generation time, not by later edits). Sorted by the worst overage first.
 */
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
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { data: batch } = await supabase
      .from("invoice_batch")
      .select("id, batch_type, stock_source_batch_id")
      .eq("id", batchId)
      .single();

    if (!batch) {
      return NextResponse.json({ message: "Batch not found" }, { status: 404 });
    }

    const invoices = await fetchAllInvoicesForBatch(supabase, batchId);
    const soldByProduct = new Map<string, number>();
    for (const inv of invoices || []) {
      for (const p of inv.products || []) {
        if (!p.product_id) continue;
        soldByProduct.set(
          p.product_id,
          (soldByProduct.get(p.product_id) || 0) + Number(p.quantity || 0),
        );
      }
    }

    const purchasedByProduct = new Map<string, number>();
    if (batch.stock_source_batch_id) {
      const stockBatchIds = String(batch.stock_source_batch_id)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const ledgerRows = await fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select("ledger_date, product_id, opening_stock, purchased_quantity")
          .in("purchase_batch_id", stockBatchIds)
          .order("ledger_date", { ascending: true })
          .order("product_id", { ascending: true })
          .range(from, to),
      );

      const byProduct = new Map<string, any[]>();
      for (const row of ledgerRows) {
        if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
        byProduct.get(row.product_id)!.push(row);
      }
      for (const [pid, rows] of byProduct.entries()) {
        rows.sort((a, b) => a.ledger_date.localeCompare(b.ledger_date));
        const opening = Number(rows[0]?.opening_stock || 0);
        const purchasedSum = rows.reduce(
          (s, r) => s + Number(r.purchased_quantity || 0),
          0,
        );
        purchasedByProduct.set(pid, opening + purchasedSum);
      }
    }

    const { data: products } = await supabase
      .from("products")
      .select("id, product_name")
      .in("id", Array.from(new Set([...soldByProduct.keys(), ...purchasedByProduct.keys()])));
    const nameById = new Map((products || []).map((p: any) => [String(p.id), p.product_name]));

    const allPids = new Set([...soldByProduct.keys(), ...purchasedByProduct.keys()]);
    const comparison = Array.from(allPids).map((pid) => {
      const purchased = Math.round((purchasedByProduct.get(pid) || 0) * 100) / 100;
      const sold = Math.round((soldByProduct.get(pid) || 0) * 100) / 100;
      return {
        product_id: pid,
        product_name: nameById.get(pid) || pid,
        purchased,
        sold,
        overage: Math.round((sold - purchased) * 100) / 100,
      };
    });

    comparison.sort((a, b) => b.overage - a.overage);

    const totalPurchased = Math.round(
      Array.from(purchasedByProduct.values()).reduce((s, v) => s + v, 0) * 100,
    ) / 100;
    const totalSold = Math.round(
      Array.from(soldByProduct.values()).reduce((s, v) => s + v, 0) * 100,
    ) / 100;

    return NextResponse.json({
      batchId,
      stockSourceBatchId: batch.stock_source_batch_id,
      totalPurchased,
      totalSold,
      totalOverage: Math.round((totalSold - totalPurchased) * 100) / 100,
      comparison,
    });
  } catch (error: any) {
    return NextResponse.json(
      { message: error.message || "Failed" },
      { status: 500 },
    );
  }
}
