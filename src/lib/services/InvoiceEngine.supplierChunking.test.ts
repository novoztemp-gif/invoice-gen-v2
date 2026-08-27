import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";

/**
 * Real bug: generateAndSaveInvoices fetches every selected supplier's
 * category in ONE `.in("id", [...])` query, with no error handling. A
 * real batch had 469 selected suppliers — a ~17KB filter value, well
 * past common request/URL length limits (Node's own default max header
 * size is 16KB) — and the query failed silently (no `error` was even
 * checked). supplierCategoryMap came back empty, which made
 * generatePurchaseInvoiceSplitupsInternal's own classification
 * (`supplierCategoryMap?.get(id) || "Meat"`) default EVERY supplier to
 * Meat, including real Fruits suppliers. The batch then generated 100%
 * Meat invoices and 0 Fruits ones despite Fruits products being
 * configured with a real occurrence share — failing the occurrence gate
 * on every one of 30 retries, deterministically, because the underlying
 * category data was never fetched, not because of any random variance.
 *
 * Fix: fetch suppliers in chunks (150 ids at a time) and check `error`.
 * This test simulates a backend that fails any `.in()` call with more
 * than 200 ids (well above the real 150-id chunk size, so the fix has
 * real margin) — a single unchunked call with 320 ids fails; three
 * chunked calls (150/150/20) all succeed.
 */

const MEAT_SUPPLIER_COUNT = 200;
const FRUIT_SUPPLIER_COUNT = 120;
const ALL_SUPPLIERS = [
  ...Array.from({ length: MEAT_SUPPLIER_COUNT }, (_, i) => ({
    id: `meat-sup-${i + 1}`,
    category: "Meat",
  })),
  ...Array.from({ length: FRUIT_SUPPLIER_COUNT }, (_, i) => ({
    id: `fruit-sup-${i + 1}`,
    category: "Fruits",
  })),
];

function products() {
  const meat = Array.from({ length: 5 }, (_, i) => ({
    product_id: `meat-p${i + 1}`,
    product_name: `meat-p${i + 1}`,
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "150",
    perDayRateMin: "50",
    perDayRateMax: "300",
    occurrencePercentage: 12,
    category: "Meat",
  }));
  const fruits = Array.from({ length: 5 }, (_, i) => ({
    product_id: `fruit-p${i + 1}`,
    product_name: `fruit-p${i + 1}`,
    hsn_code: "0810",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "150",
    perDayRateMin: "50",
    perDayRateMax: "300",
    occurrencePercentage: 8,
    category: "Fruits",
  }));
  return [...meat, ...fruits];
}

function makeBatchRow() {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    batch_status: "draft",
    batch_type: "PURCHASE",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-31",
    minimum_invoice_amount: 1000,
    maximum_invoice_amount: 3000,
    total_amount: 500000,
    products: products(),
    selected_customers: ALL_SUPPLIERS.map((s) => s.id),
    major_customers: [],
    category_allocation: null,
    occurrence_semantics: "GLOBAL",
  };
}

/**
 * A backend that fails any `.in("id", ids)` call on `suppliers` with
 * more than `chunkLimit` ids — simulating the real URL-length failure —
 * and otherwise returns the real matching rows.
 */
function makeMockSupabase(chunkLimit: number) {
  const batchRow = makeBatchRow();
  let invoiceBatchCalls = 0;

  const passthroughBuilder = (response: { data: any; error: any }) => {
    const builder: any = {};
    const chain = () => builder;
    for (const m of [
      "select",
      "eq",
      "like",
      "order",
      "range",
      "in",
      "update",
      "insert",
      "delete",
      "limit",
    ]) {
      builder[m] = chain;
    }
    builder.single = () => Promise.resolve(response);
    builder.then = (onF: any, onR: any) =>
      Promise.resolve(response).then(onF, onR);
    return builder;
  };

  const supabase = {
    from(table: string) {
      if (table === "invoice_batch") {
        invoiceBatchCalls++;
        return passthroughBuilder({
          data: invoiceBatchCalls === 1 ? batchRow : null,
          error: null,
        });
      }
      if (table === "issuing_companies") {
        return passthroughBuilder({
          data: { abbreviation: "TST", company_name: "Test Co" },
          error: null,
        });
      }
      if (table === "invoice") {
        return passthroughBuilder({ data: [], error: null });
      }
      if (table === "suppliers") {
        const builder: any = {};
        let idsFilter: string[] = [];
        builder.select = () => builder;
        builder.in = (_col: string, ids: string[]) => {
          idsFilter = ids;
          return builder;
        };
        builder.then = (onF: any, onR: any) => {
          if (idsFilter.length > chunkLimit) {
            return Promise.resolve({
              data: null,
              error: { message: "URI Too Long (simulated)" },
            }).then(onF, onR);
          }
          const matched = ALL_SUPPLIERS.filter((s) =>
            idsFilter.includes(s.id),
          );
          return Promise.resolve({ data: matched, error: null }).then(
            onF,
            onR,
          );
        };
        return builder;
      }
      return passthroughBuilder({ data: [], error: null });
    },
    rpc(_fnName: string, args: any) {
      const invoices = args.p_invoices as any[];
      return Promise.resolve({
        data: invoices.map((_inv, i) => ({
          invoice_number: `PB-${String(i + 1).padStart(7, "0")}`,
          sequence_number: i + 1,
        })),
        error: null,
      });
    },
  };

  return supabase as any;
}

describe("generateAndSaveInvoices — chunked supplier category fetch", () => {
  it("passes the occurrence gate when the supplier list is chunked (backend rejects any single call over 200 ids -- above the real 150-id chunk size, so every real chunk fits with margin, but the old single unchunked 320-id call would not)", async () => {
    const supabase = makeMockSupabase(200);
    await expect(
      InvoiceEngine.generateAndSaveInvoices(supabase, "batch-1"),
    ).resolves.toBeDefined();
  }, 30000);
});
