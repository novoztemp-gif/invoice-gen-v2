import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Sprint 1.7S — regression tests for the new CATEGORY occurrence config
 * gate in create-sales-batch-transactional/route.ts. This route is the
 * sole authoritative persistence point for a Sales batch (Purchase's batch
 * row is inserted directly from the client instead), so this is where
 * "invalid CATEGORY configuration cannot be persisted" must actually be
 * enforced for Sales.
 *
 * The `invocesOverride` (Daily Stock Review) path is deliberately NOT
 * exercised here — it needs a much larger mock (invoice numbering, stock
 * conservation) unrelated to what this sprint changed. Every test below
 * omits invoicesOverride, which routes through the simpler
 * `InvoiceEngine.generateAndSaveInvoices` branch (mocked) — sufficient to
 * prove the gate's own before/after-persistence behavior, which is what
 * this sprint actually added.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
) {
  const counters: Record<string, number> = {};
  const insertCalls: Array<{ table: string; values: any }> = [];

  const supabase = {
    from(table: string) {
      const idx = counters[table] || 0;
      counters[table] = idx + 1;
      const queue = queues[table] || [];
      const response = queue[idx] || { data: null, error: null };

      const builder: any = {};
      const chain = (..._args: any[]) => builder;
      for (const m of ["select", "eq", "like", "order", "range", "in", "limit"]) {
        builder[m] = chain;
      }
      builder.insert = (values: any) => {
        insertCalls.push({ table, values });
        return builder;
      };
      builder.delete = () => builder;
      builder.single = () => Promise.resolve(response);
      builder.then = (onF: any, onR: any) =>
        Promise.resolve(response).then(onF, onR);
      return builder;
    },
  };

  return { supabase: supabase as any, insertCalls };
}

let mockSupabaseInstance: any;

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(mockSupabaseInstance),
}));

vi.mock("@/lib/services/InvoiceEngine", () => ({
  InvoiceEngine: {
    generateAndSaveInvoices: vi.fn(async () => 0),
    postSalesBatchStockLedger: vi.fn(async () => {}),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

function baseBody(overrides: Record<string, any> = {}) {
  return {
    issuingCompanyId: "co-1",
    receivingCompanyId: "cust-1",
    selectedCustomers: ["cust-1"],
    majorCustomers: [],
    transportMode: "In hand Delivery",
    vehicleNumber: "NA",
    dateOfSupply: "2026-01-05",
    invoiceDateFrom: "2026-01-01",
    invoiceDateTo: "2026-01-05",
    minimumInvoiceAmount: "100",
    maximumInvoiceAmount: "100000",
    totalAmount: "3000",
    financialYearStart: 2026,
    financialYearEnd: 2027,
    products: [
      {
        product_id: "M1",
        product_name: "M1",
        category: "Meat",
        hsn_code: "0207",
        unit_of_measure: "kg",
        perDayQtyMin: "10",
        perDayQtyMax: "100",
        perDayRateMin: "10",
        perDayRateMax: "500",
        occurrencePercentage: 100,
      },
    ],
    recurringProducts: [],
    stockSourceBatchId: "src-batch-1",
    userId: "user-1",
    ...overrides,
  };
}

function makeSupabaseForHappyPath() {
  return makeMockSupabase({
    products: [{ data: [{ id: "M1", category: "Meat" }], error: null }],
    daily_stock_ledger: [{ data: [], error: null }],
    invoice_batch: [{ data: { id: "batch-new-1" }, error: null }],
    invoice: [{ data: [], error: null }],
  });
}

describe("create-sales-batch-transactional route — CATEGORY occurrence config gate (Sprint 1.7S)", () => {
  it("invalid CATEGORY config (percentages don't sum to 100%) is rejected — no invoice_batch insert attempted", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(
          baseBody({
            occurrenceSemantics: "CATEGORY",
            categoryAllocation: { Meat: 40, Fruits: 40 }, // sums to 80
          }),
        ),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/Product Occurrence Configuration Invalid/);
    expect(insertCalls.some((c) => c.table === "invoice_batch")).toBe(false);
  });

  it("invalid CATEGORY config (Rule B — allocated % but no matching products) is rejected — no invoice_batch insert attempted", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(
          baseBody({
            // Only Meat products in this batch, but Fruits is allocated 30%.
            occurrenceSemantics: "CATEGORY",
            categoryAllocation: { Meat: 70, Fruits: 30 },
          }),
        ),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/Product Occurrence Configuration Invalid/);
    expect(insertCalls.some((c) => c.table === "invoice_batch")).toBe(false);
  });

  it("valid CATEGORY config is NOT blocked by the gate — invoice_batch insert is attempted with both fields persisted", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(
          baseBody({
            occurrenceSemantics: "CATEGORY",
            categoryAllocation: { Meat: 100, Fruits: 0 },
          }),
        ),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const batchInsert = insertCalls.find((c) => c.table === "invoice_batch");
    expect(batchInsert).toBeDefined();
    expect(batchInsert!.values.occurrence_semantics).toBe("CATEGORY");
    expect(batchInsert!.values.category_allocation).toEqual({
      Meat: 100,
      Fruits: 0,
    });
  });

  it("legacy/null occurrenceSemantics is unaffected — batch creation succeeds exactly as before this sprint, both fields persisted as null", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve(baseBody()), // no occurrenceSemantics/categoryAllocation at all
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const batchInsert = insertCalls.find((c) => c.table === "invoice_batch");
    expect(batchInsert).toBeDefined();
    expect(batchInsert!.values.occurrence_semantics).toBe(null);
    expect(batchInsert!.values.category_allocation).toBe(null);
  });

  it("GLOBAL occurrenceSemantics persists correctly and is not blocked by the gate", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(baseBody({ occurrenceSemantics: "GLOBAL" })),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const batchInsert = insertCalls.find((c) => c.table === "invoice_batch");
    expect(batchInsert).toBeDefined();
    expect(batchInsert!.values.occurrence_semantics).toBe("GLOBAL");
    expect(batchInsert!.values.category_allocation).toBe(null);
  });

  it("Sprint 1.7T: a bypassed/direct call with GLOBAL semantics and invalid product occurrence percentages (missing entirely) is rejected — no invoice_batch insert attempted", async () => {
    // Simulates a caller that skips the UI's own client-side check
    // entirely (curl/Postman/a buggy client) — this route is the only
    // real persistence boundary for Sales, so GLOBAL/NULL must be
    // validated here too, not just CATEGORY.
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(
          baseBody({
            occurrenceSemantics: "GLOBAL",
            products: [
              {
                product_id: "M1",
                product_name: "M1",
                category: "Meat",
                hsn_code: "0207",
                unit_of_measure: "kg",
                perDayQtyMin: "10",
                perDayQtyMax: "100",
                perDayRateMin: "10",
                perDayRateMax: "500",
                // occurrencePercentage intentionally omitted
              },
            ],
          }),
        ),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/Product Occurrence Configuration Invalid/);
    expect(insertCalls.some((c) => c.table === "invoice_batch")).toBe(false);
  });

  it("Sprint 1.7T: a bypassed/direct call with NULL/legacy semantics and occurrence percentages that don't sum to 100% is rejected", async () => {
    const { supabase, insertCalls } = makeSupabaseForHappyPath();
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () =>
        Promise.resolve(
          baseBody({
            products: [
              {
                product_id: "M1",
                product_name: "M1",
                category: "Meat",
                hsn_code: "0207",
                unit_of_measure: "kg",
                perDayQtyMin: "10",
                perDayQtyMax: "100",
                perDayRateMin: "10",
                perDayRateMax: "500",
                occurrencePercentage: 40,
              },
              {
                product_id: "M2",
                product_name: "M2",
                category: "Meat",
                hsn_code: "0207",
                unit_of_measure: "kg",
                perDayQtyMin: "10",
                perDayQtyMax: "100",
                perDayRateMin: "10",
                perDayRateMax: "500",
                occurrencePercentage: 40, // sums to 80, not 100
              },
            ],
          }),
        ),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/Product Occurrence Configuration Invalid/);
    expect(insertCalls.some((c) => c.table === "invoice_batch")).toBe(false);
  });
});
