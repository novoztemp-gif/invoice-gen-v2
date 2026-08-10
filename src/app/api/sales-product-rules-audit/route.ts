import { NextRequest, NextResponse } from "next/server";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";

/**
 * Read-only audit: finds every SALES invoice line whose rate or quantity
 * falls outside that product's CURRENT product_rules range. Used to scope
 * a one-time cleanup — does not modify anything.
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
          rateMin: Number(r.rate_min) || 0,
          rateMax: Number(r.rate_max) || Infinity,
        },
      ]),
    );

    const salesInvoices = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice")
        .select(
          "id, invoice_number, invoice_batch_id, invoice_date, products",
        )
        .eq("batch_type", "SALES")
        .range(from, to),
    );

    const batchIds = Array.from(
      new Set(salesInvoices.map((inv: any) => inv.invoice_batch_id).filter(Boolean)),
    );
    const { data: batches } = await supabase
      .from("invoice_batch")
      .select("id, batch_status, status")
      .in("id", batchIds.length > 0 ? batchIds : ["__none__"]);
    const batchStatusMap = new Map(
      (batches || []).map((b: any) => [b.id, b.batch_status]),
    );

    const violations: any[] = [];
    const batchSummary = new Map<
      string,
      { violationCount: number; invoiceIds: Set<string>; finalized: boolean }
    >();

    for (const inv of salesInvoices) {
      const products = Array.isArray(inv.products) ? inv.products : [];
      for (const p of products) {
        const rule = ruleMap.get(p.product_id);
        if (!rule) continue;
        const qty = Number(p.quantity || 0);
        const rate = Number(p.rate || 0);
        const qtyBad = qty < rule.quantityMin || qty > rule.quantityMax;
        const rateBad = rate < rule.rateMin || rate > rule.rateMax;
        if (!qtyBad && !rateBad) continue;

        violations.push({
          batchId: inv.invoice_batch_id,
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          invoiceDate: inv.invoice_date,
          productId: p.product_id,
          productName: p.product_name,
          quantity: qty,
          rate,
          quantityRange: [rule.quantityMin, rule.quantityMax],
          rateRange: [rule.rateMin, rule.rateMax],
          qtyBad,
          rateBad,
        });

        const summary = batchSummary.get(inv.invoice_batch_id) || {
          violationCount: 0,
          invoiceIds: new Set<string>(),
          finalized: batchStatusMap.get(inv.invoice_batch_id) === "FINALIZED",
        };
        summary.violationCount++;
        summary.invoiceIds.add(inv.id);
        batchSummary.set(inv.invoice_batch_id, summary);
      }
    }

    return NextResponse.json({
      totalSalesInvoicesScanned: salesInvoices.length,
      totalViolations: violations.length,
      batchSummary: Array.from(batchSummary.entries()).map(([batchId, s]) => ({
        batchId,
        violationCount: s.violationCount,
        affectedInvoiceCount: s.invoiceIds.size,
        finalized: s.finalized,
      })),
      violations,
    });
  } catch (error: any) {
    console.error("Sales product rules audit error:", error);
    return NextResponse.json(
      { message: error.message || "Audit failed" },
      { status: 500 },
    );
  }
}
