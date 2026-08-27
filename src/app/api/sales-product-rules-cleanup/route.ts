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

    // Hotfix — this fetch's error was never checked. If it failed, ruleMap
    // ended up empty, and every product line in every invoice would then
    // match the `if (!rule) return p;` no-op branch below — the cleanup
    // would silently report "0 fixed" (identical to a healthy run that
    // genuinely found nothing to fix), never revealing that it actually
    // failed to load its own correction rules in the first place.
    const { data: rules, error: rulesError } = await supabase
      .from("product_rules")
      .select("product_id, quantity_min, quantity_max, rate_min, rate_max");
    if (rulesError) throw rulesError;
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

    // Hotfix — was a single unpaginated `.select()` with its error
    // unchecked: on failure, or once total SALES batches (all-time, not
    // just currently-open ones) crossed PostgREST's default 1000-row
    // cap, this silently returned an incomplete/empty list and the route
    // would report "No eligible batches" as if by design rather than a
    // real failure. Paginated via fetchAllQueryRows, same as every other
    // large scan in this codebase.
    const batches = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice_batch")
        .select("id, batch_status")
        .eq("batch_type", "SALES")
        .order("id", { ascending: true })
        .range(from, to),
    );
    const eligibleBatchIds = batches
      .filter((b: any) => b.batch_status !== "FINALIZED")
      .map((b: any) => b.id);

    if (eligibleBatchIds.length === 0) {
      return NextResponse.json({ message: "No eligible batches.", fixed: 0 });
    }

    // Hotfix — eligibleBatchIds (every open SALES batch system-wide) used
    // to be embedded whole into a single `.in()` filter, unbounded — the
    // same growth-risk shape as the 469-supplier bug fixed earlier this
    // session, just scoped to batches instead of suppliers. Chunked here,
    // with each chunk still paginated via fetchAllQueryRows (a chunk of
    // batches can easily have more than 1000 matching invoices on its
    // own).
    const BATCH_ID_CHUNK_SIZE = 150;
    const salesInvoices: any[] = [];
    for (let i = 0; i < eligibleBatchIds.length; i += BATCH_ID_CHUNK_SIZE) {
      const idChunk = eligibleBatchIds.slice(i, i + BATCH_ID_CHUNK_SIZE);
      const rows = await fetchAllQueryRows((from, to) =>
        supabase
          .from("invoice")
          .select("id, invoice_batch_id, products, total_amount")
          .in("invoice_batch_id", idChunk)
          .order("id", { ascending: true })
          .range(from, to),
      );
      salesInvoices.push(...rows);
    }

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
