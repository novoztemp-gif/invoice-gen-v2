import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Client-reported bug — a real ~593-invoice Purchase batch consistently
 * failed the post-generation Product Occurrence gate (GLOBAL semantics)
 * with several products landing ABOVE target (never below) by +4/+5/+6,
 * even after `generateWithAutoRetry`'s existing 30 independent attempts
 * (each with its own 5-pass repair) all failed identically.
 *
 * Root cause: the per-invoice product-line-count draw
 * (`targetSubsetCount` in `generatePurchaseInvoiceSplitupsInternal`) was a
 * flat random 3-8, with no awareness of how much occurrence quota
 * actually remained in the category. Once a category's total quota was
 * consumed by earlier invoices, every LATER invoice in that category
 * still forced the same 3-8 line draw — `selectProductsByOccurrence` has
 * no choice but to fall back to already-at-target products once nothing
 * with real quota is left, guaranteeing those products overshoot by
 * however many invoices remained. A systematic bias, not tail variance —
 * consistent with surviving 30 independent randomized attempts.
 *
 * Fix: cap the per-invoice line-count draw by how many products in the
 * category still have real remaining quota (floor of 1, never zero
 * lines). Later invoices in a quota-scarce category now naturally ask for
 * fewer lines instead of forcing overshoot every time.
 *
 * This test builds a deliberately quota-SCARCE, large (~400 invoice)
 * Purchase batch — many products, low individual occurrence percentages
 * relative to how many invoices will be generated, the same shape that
 * produced the real failure — and runs the full production pipeline
 * (`generateAndSaveInvoices`, including its own retry+repair) several
 * times to check it reliably passes the occurrence gate.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
  rpcHandler: (fnName: string, args: any) => { data: any; error: any },
) {
  const counters: Record<string, number> = {};

  const supabase = {
    from(table: string) {
      const idx = counters[table] || 0;
      counters[table] = idx + 1;
      const queue = queues[table] || [];
      const response = queue[idx] || { data: null, error: null };

      const builder: any = {};
      const chain = (..._args: any[]) => builder;
      for (const m of [
        "select",
        "eq",
        "like",
        "order",
        "range",
        "in",
        "update",
        "insert",
        "limit",
      ]) {
        builder[m] = chain;
      }
      builder.delete = (..._args: any[]) => builder;
      builder.single = () => Promise.resolve(response);
      builder.then = (onF: any, onR: any) =>
        Promise.resolve(response).then(onF, onR);
      return builder;
    },
    rpc(fnName: string, args: any) {
      const invoices = args.p_invoices as any[];
      return Promise.resolve(
        rpcHandler(fnName, args) ?? {
          data: invoices.map((_inv, i) => ({
            invoice_number: `PB-${String(i + 1).padStart(7, "0")}`,
            sequence_number: i + 1,
          })),
          error: null,
        },
      );
    },
  };

  return supabase as any;
}

// 50 Meat products with SMALL individual occurrence percentages (2% each,
// summing to 100) — matching the real failure's shape: a small individual
// TARGET (4, 11) means even a modest absolute overshoot (+4, +5) is a huge
// RELATIVE deviation, easily exceeding the gate's tolerance band
// (max(3, ceil(target*0.15))). A handful of large-share products (like the
// first, smaller fixture) keeps targets big enough that the same absolute
// overshoot stays within tolerance — that's why the first attempt at this
// fixture didn't actually reproduce the bug even without the fix.
const PRODUCT_COUNT = 50;
function meatProducts() {
  return Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
    product_id: `M${i + 1}`,
    product_name: `M${i + 1}`,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "150",
    perDayRateMin: "50",
    perDayRateMax: "300",
    occurrencePercentage: 100 / PRODUCT_COUNT,
    category: "Meat",
  }));
}

const SUPPLIER_IDS = ["sup-1", "sup-2", "sup-3", "sup-4", "sup-5"];

function makeLargeScarceBatch() {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    batch_status: "draft",
    batch_type: "PURCHASE",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-31",
    // thresholdMin/Max/total sized to land close to the real ~593-invoice
    // batch that failed.
    minimum_invoice_amount: 1500,
    maximum_invoice_amount: 3500,
    total_amount: 1500000,
    products: meatProducts(),
    selected_customers: SUPPLIER_IDS,
    major_customers: [],
    category_allocation: null,
    occurrence_semantics: "GLOBAL",
  };
}

describe("Purchase occurrence gate — quota-scarce large batch (real-data shape)", () => {
  it("reliably passes the occurrence gate across several full-pipeline runs", async () => {
    const results: Array<{ ok: boolean; message?: string }> = [];

    for (let trial = 0; trial < 5; trial++) {
      const batchRow = makeLargeScarceBatch();
      const supabase = makeMockSupabase(
        {
          invoice_batch: [
            { data: batchRow, error: null },
            { data: null, error: null },
          ],
          issuing_companies: [
            {
              data: { abbreviation: "TST", company_name: "Test Co" },
              error: null,
            },
          ],
          invoice: [
            { data: [], error: null },
            { data: [], error: null },
          ],
          suppliers: [
            {
              data: SUPPLIER_IDS.map((id) => ({ id, category: "Meat" })),
              error: null,
            },
          ],
        },
        () => null as any,
      );

      try {
        await InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1");
        results.push({ ok: true });
      } catch (e: any) {
        results.push({ ok: false, message: e?.message });
      }
    }

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      console.error(
        "FAILURES:",
        failures.map((f) => f.message).join("\n---\n"),
      );
    }
    expect(failures.length).toBe(0);
  }, 60000);
});
