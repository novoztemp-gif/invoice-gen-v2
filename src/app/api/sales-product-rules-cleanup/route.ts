import { NextRequest, NextResponse } from "next/server";
import { computeLineAmount, roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";

/**
 * One-time cleanup: corrects every SALES invoice line whose rate/quantity
 * falls outside that product's CURRENT product_rules range, by clamping to
 * the nearest valid bound and recomputing line/invoice/batch totals.
 * Skips batches with batch_status = 'FINALIZED'. This is a real data
 * correction — invoice and batch totals WILL change to reflect valid
 * pricing, unlike the exact-total-preserving edit engine.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { data: rules } = await supabase
      .from("product_rules")
      .select("product_id, quantity_min, quantity_max, rate_min, rate_max");
    const ruleMap = new Map(
      (rules || []).map((r: any) => [
        r.product_id,
        {
          quantityMin: Number(r.quantity_min) || 0,
          quantityMax: Number(r.quantity_max) || Infinity,
          rateMin: Number(r.rate_min) || 1,
          rateMax: Number(r.rate_max) || Infinity,
        },
      ]),
    );

    const { data: batches } = await supabase
      .from("invoice_batch")
      .select("id, batch_status")
      .eq("batch_type", "SALES");
    const eligibleBatchIds = (batches || [])
      .filter((b: any) => b.batch_status !== "FINALIZED")
      .map((b: any) => b.id);

    if (eligibleBatchIds.length === 0) {
      return NextResponse.json({ message: "No eligible batches.", fixed: 0 });
    }

    const salesInvoices = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice")
        .select("id, invoice_batch_id, products, total_amount")
        .in("invoice_batch_id", eligibleBatchIds)
        .range(from, to),
    );

    const batchTotals = new Map<string, number>();
    const invoiceUpdates: { id: string; products: any[]; total_amount: number }[] = [];
    let linesFixed = 0;
    let invoicesFixed = 0;

    for (const inv of salesInvoices) {
      const products = Array.isArray(inv.products) ? inv.products : [];
      let changed = false;
      const newProducts = products.map((p: any) => {
        const rule = ruleMap.get(p.product_id);
        if (!rule) return p;
        let qty = Number(p.quantity || 0);
        let rate = Number(p.rate || 0);
        let lineChanged = false;

        if (qty < rule.quantityMin) {
          qty = rule.quantityMin;
          lineChanged = true;
        } else if (qty > rule.quantityMax) {
          qty = rule.quantityMax;
          lineChanged = true;
        }
        if (lineChanged) qty = roundToQuarterIncrement(qty);

        if (rate < rule.rateMin) {
          rate = rule.rateMin;
          lineChanged = true;
        } else if (rate > rule.rateMax) {
          rate = rule.rateMax;
          lineChanged = true;
        }

        if (!lineChanged) return p;
        linesFixed++;
        changed = true;
        return {
          ...p,
          quantity: qty,
          rate,
          amount: computeLineAmount(qty, rate),
        };
      });

      const newTotal = Math.round(
        newProducts.reduce((s: number, p: any) => s + Math.round(p.amount || 0), 0),
      );

      if (changed) {
        invoicesFixed++;
        invoiceUpdates.push({
          id: inv.id,
          products: newProducts,
          total_amount: newTotal,
        });
        batchTotals.set(
          inv.invoice_batch_id,
          (batchTotals.get(inv.invoice_batch_id) || 0) + newTotal,
        );
      } else {
        batchTotals.set(
          inv.invoice_batch_id,
          (batchTotals.get(inv.invoice_batch_id) || 0) + Math.round(Number(inv.total_amount) || 0),
        );
      }
    }

    // Apply invoice updates in bounded concurrent chunks.
    const CHUNK = 25;
    for (let i = 0; i < invoiceUpdates.length; i += CHUNK) {
      const chunk = invoiceUpdates.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map((u) =>
          supabase
            .from("invoice")
            .update({ products: u.products, total_amount: u.total_amount })
            .eq("id", u.id),
        ),
      );
    }

    // Recompute each affected batch's total_amount to match its invoices.
    const batchUpdates = Array.from(batchTotals.entries());
    for (let i = 0; i < batchUpdates.length; i += CHUNK) {
      const chunk = batchUpdates.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map(([batchId, total]) =>
          supabase
            .from("invoice_batch")
            .update({ total_amount: total })
            .eq("id", batchId),
        ),
      );
    }

    return NextResponse.json({
      eligibleBatches: eligibleBatchIds.length,
      totalInvoicesScanned: salesInvoices.length,
      invoicesFixed,
      linesFixed,
      batchesRecomputed: batchUpdates.length,
    });
  } catch (error: any) {
    console.error("Sales product rules cleanup error:", error);
    return NextResponse.json(
      { message: error.message || "Cleanup failed" },
      { status: 500 },
    );
  }
}
