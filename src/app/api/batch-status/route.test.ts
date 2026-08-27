import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Sprint 1.7R — Gap A regression tests.
 *
 * Before this sprint, the finalize-time invoice-amount-range gate in
 * batch-status/route.ts only ran for `batch_type === "PURCHASE"` — a SALES
 * batch could be finalized while an invoice sat outside
 * [minimum_invoice_amount, maximum_invoice_amount], since Sales editing's
 * own grandfather rule (SalesFinalValidator) never blocks an
 * already-violating invoice from staying that way. The fix widens the
 * existing (already-tested, purely arithmetic) checkPurchaseInvoiceAmountRange
 * gate to also cover SALES, reusing the same code path Purchase already had
 * — no new range logic was written.
 *
 * `createClient` is mocked (this codebase has no established pattern for
 * exercising Next.js route handlers against a live/mocked DB elsewhere —
 * the InvoiceEngine test suite exclusively drives service-layer functions
 * with a mock Supabase client passed as a plain argument). The route
 * handler takes no injectable client, so `@/lib/supabase/server` is mocked
 * at the module level instead, using the same chainable query-builder shape
 * already established throughout the InvoiceEngine test files.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any }>>,
) {
  const counters: Record<string, number> = {};
  const updateCalls: Array<{ table: string; values: any }> = [];

  const supabase = {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
    },
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
      builder.update = (values: any) => {
        updateCalls.push({ table, values });
        return builder;
      };
      builder.single = () => Promise.resolve(response);
      builder.then = (onF: any, onR: any) =>
        Promise.resolve(response).then(onF, onR);
      return builder;
    },
  };

  return { supabase: supabase as any, updateCalls };
}

function makeInvoice(id: string, totalAmount: number) {
  return {
    id,
    invoice_number: `SB-${id}`,
    total_amount: totalAmount,
    status: "generated",
    products: [
      {
        product_id: "p1",
        product_name: "Product 1",
        hsn_code: "1234",
        unit_of_measure: "kg",
        quantity: 1,
        rate: totalAmount,
        amount: totalAmount,
      },
    ],
  };
}

let mockSupabaseInstance: any;

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(mockSupabaseInstance),
}));

vi.mock("@/lib/supabase/fetchAll", () => ({
  fetchAllInvoicesForBatch: (supabase: any, batchId: string) =>
    Promise.resolve(mockFetchedInvoices),
}));

vi.mock("@/lib/services/InvoiceEngine", () => ({
  InvoiceEngine: {
    validateInvoiceData: () => ({ isValid: true, message: "" }),
    updateBatchStatus: vi.fn(async () => ({ batch_type: "SALES" })),
  },
}));

let mockFetchedInvoices: any[] = [];

afterEach(() => {
  vi.clearAllMocks();
});

describe("batch-status route — FINALIZE amount-range gate (Sprint 1.7R Gap A)", () => {
  it("SALES batch with an invoice above maximum_invoice_amount is rejected — no status change occurs", async () => {
    mockFetchedInvoices = [makeInvoice("inv-1", 25000)]; // above max below
    const { supabase, updateCalls } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "SALES",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/outside the batch's configured invoice amount range/);

    // No status-changing update was ever issued (rejected before mutation).
    expect(
      updateCalls.some((c) => c.table === "invoice_batch"),
    ).toBe(false);
  });

  it("SALES batch with an invoice below minimum_invoice_amount is rejected — no status change occurs", async () => {
    mockFetchedInvoices = [makeInvoice("inv-1", 500)]; // below min below
    const { supabase, updateCalls } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "SALES",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/outside the batch's configured invoice amount range/);
    expect(
      updateCalls.some((c) => c.table === "invoice_batch"),
    ).toBe(false);
  });

  it("valid SALES batch (every invoice inside range) still finalizes successfully", async () => {
    mockFetchedInvoices = [makeInvoice("inv-1", 5000)]; // inside [1000, 20000]
    const { supabase } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "SALES",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("PURCHASE behavior is unchanged: an out-of-range invoice is still rejected exactly as before this sprint", async () => {
    mockFetchedInvoices = [makeInvoice("inv-1", 25000)];
    const { supabase, updateCalls } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "PURCHASE",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(
      updateCalls.some((c) => c.table === "invoice_batch"),
    ).toBe(false);
  });
});

describe("batch-status route — major customer own invoice-amount limit (client-reported bug)", () => {
  function makeMajorInvoice(
    id: string,
    totalAmount: number,
    customerId: string,
  ) {
    return {
      id,
      invoice_number: `SB-${id}`,
      total_amount: totalAmount,
      status: "generated",
      customer_id: customerId,
      products: [
        {
          product_id: "p1",
          product_name: "Product 1",
          hsn_code: "1234",
          unit_of_measure: "kg",
          quantity: 1,
          rate: totalAmount,
          customer_id: customerId,
          amount: totalAmount,
        },
      ],
    };
  }

  it("a major customer invoice above the BATCH's max but within its OWN configured max_invoice_amount finalizes successfully", async () => {
    // Batch-wide max is 20000, but this major customer is configured with
    // its own, higher max_invoice_amount (30000) — the invoice sits at
    // 25000, legitimately within the major customer's own limit even
    // though it exceeds the batch-wide range every other invoice follows.
    mockFetchedInvoices = [makeMajorInvoice("inv-1", 25000, "maj-a")];
    const { supabase } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "PURCHASE",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
            major_customers: [
              {
                customer_id: "maj-a",
                amount: 100000,
                invoice_count: 4,
                max_invoice_amount: 30000,
              },
            ],
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("a major customer invoice ABOVE its own configured max_invoice_amount is still rejected", async () => {
    mockFetchedInvoices = [makeMajorInvoice("inv-1", 35000, "maj-a")];
    const { supabase, updateCalls } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "PURCHASE",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
            major_customers: [
              {
                customer_id: "maj-a",
                amount: 100000,
                invoice_count: 4,
                max_invoice_amount: 30000,
              },
            ],
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.[0]).toContain("major customer limit");
    expect(
      updateCalls.some((c) => c.table === "invoice_batch"),
    ).toBe(false);
  });

  it("a non-major invoice below the batch minimum is still rejected even when major_customers are configured", async () => {
    mockFetchedInvoices = [makeInvoice("inv-1", 500)]; // no customer_id -> not a major invoice
    const { supabase, updateCalls } = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            batch_type: "PURCHASE",
            minimum_invoice_amount: 1000,
            maximum_invoice_amount: 20000,
            major_customers: [
              {
                customer_id: "maj-a",
                amount: 100000,
                invoice_count: 4,
                max_invoice_amount: 30000,
              },
            ],
          },
          error: null,
        },
      ],
    });
    mockSupabaseInstance = supabase;

    const { POST } = await import("./route");
    const req = {
      json: () => Promise.resolve({ batchId: "batch-1", action: "FINALIZE" }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(
      updateCalls.some((c) => c.table === "invoice_batch"),
    ).toBe(false);
  });
});
