import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Client asked: an earlier session change made this route auto-retry
 * generation internally (fresh randomness each attempt) when it hits a
 * Major-Customer-related failure, instead of surfacing the error for the
 * user to manually click "Create Batch" again. That change shipped with
 * tsc/build/existing-suite verification only — the retry LOOP itself
 * (does it actually retry, does it stop retrying on a non-retryable
 * error, does it give up cleanly after the cap) was unverified. These
 * tests exercise that loop directly by controlling exactly how many times
 * `InvoiceEngine.generateInvoiceSplitupsInternal` fails before succeeding
 * (or never succeeds at all).
 */

function makeMockSupabase() {
  const builder: any = {};
  const chain = (..._args: any[]) => builder;
  for (const m of ["select", "eq", "order", "range", "in", "limit"]) {
    builder[m] = chain;
  }
  builder.single = () =>
    Promise.resolve({
      data: { abbreviation: "IC", company_name: "Issuing Co" },
      error: null,
    });
  // supabase.from("products").select(...) resolves via thenable, not .single()
  builder.then = (onF: any, onR: any) =>
    Promise.resolve({ data: [], error: null }).then(onF, onR);

  return { from: () => builder } as any;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(makeMockSupabase()),
}));

const mockLedgerData = [
  {
    purchase_batch_id: "pb-1",
    ledger_date: "2026-01-01",
    product_id: "P1",
    opening_stock: 0,
    purchased_quantity: 500,
    sold_quantity: 0,
  },
];

vi.mock("@/lib/supabase/fetchAll", () => ({
  fetchAllQueryRows: vi.fn(async () => mockLedgerData),
}));

vi.mock("@/lib/utils/reconcile-invoice-quantities", () => ({
  // Pass-through (a COPY, not the same reference — the route does
  // `invoices.length = 0; invoices.push(...reconciledInvoices)`, which
  // would empty its own input first if this returned the same array) —
  // these tests are about the generation retry loop, not reconciliation,
  // which already has its own dedicated test coverage.
  reconcileInvoicesToTargets: vi.fn((invoices: any[]) => [...invoices]),
}));

const generateInvoiceSplitupsInternal = vi.fn();
vi.mock("@/lib/services/InvoiceEngine", () => ({
  InvoiceEngine: {
    generateInvoiceSplitupsInternal: (...args: any[]) =>
      generateInvoiceSplitupsInternal(...args),
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
    dateOfSupply: "2026-01-02",
    invoiceDateFrom: "2026-01-01",
    invoiceDateTo: "2026-01-02",
    minimumInvoiceAmount: "100",
    maximumInvoiceAmount: "100000",
    totalAmount: "1000",
    financialYearStart: 2026,
    financialYearEnd: 2027,
    products: [
      {
        product_id: "P1",
        product_name: "P1",
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
    stockSourceBatchId: "pb-1",
    ...overrides,
  };
}

function makeRequest(body: any) {
  return {
    json: async () => body,
  } as any;
}

const successfulInvoices = [
  {
    invoice_date: "2026-01-01",
    products: [
      { product_id: "P1", product_name: "P1", quantity: 10, rate: 10, amount: 100 },
    ],
    total_amount: 100,
  },
];

describe("POST /api/generate-sales-dry-run — generation auto-retry", () => {
  it("retries on a Major Customer failure and succeeds once a later attempt works", async () => {
    generateInvoiceSplitupsInternal
      .mockImplementationOnce(() => {
        throw new Error(
          "Major Customer balancing failed: expected ₹1000, got ₹800 (short by ₹200).",
        );
      })
      .mockImplementationOnce(() => {
        throw new Error(
          "Major Customer balancing failed: expected ₹1000, got ₹900 (short by ₹100).",
        );
      })
      .mockImplementationOnce(() => successfulInvoices);

    const { POST } = await import("./route");
    const res = await POST(makeRequest(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.invoices.length).toBe(1);
    // Failed twice, succeeded on the 3rd call.
    expect(generateInvoiceSplitupsInternal).toHaveBeenCalledTimes(3);
  });

  it("gives up after 100 attempts and reports a clear final error", async () => {
    generateInvoiceSplitupsInternal.mockImplementation(() => {
      throw new Error(
        "Major Customer balancing failed: expected ₹1000, got ₹800 (short by ₹200).",
      );
    });

    const { POST } = await import("./route");
    const res = await POST(makeRequest(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(generateInvoiceSplitupsInternal).toHaveBeenCalledTimes(100);
    expect(json.message).toContain("Major Customer balancing failed");
    expect(json.message).toContain("auto-retried 100 times");
  });

  // Hotfix — every throw site inside generateInvoiceSplitupsInternal
  // depends on THIS attempt's random placement, not a fixed config error
  // (see the updated comment in route.ts), so retrying is now unconditional
  // — this test used to assert the OPPOSITE (no retry for non-Major-
  // Customer messages), which was the actual gap being fixed.
  it("DOES retry a non-Major-Customer (structural-looking) error too, and gives up after 100 attempts with a generic hint, not the Major-Customer one", async () => {
    generateInvoiceSplitupsInternal.mockImplementation(() => {
      throw new Error("Minimum Invoice Amount Violation: cannot be satisfied.");
    });

    const { POST } = await import("./route");
    const res = await POST(makeRequest(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(generateInvoiceSplitupsInternal).toHaveBeenCalledTimes(100);
    expect(json.message).toContain(
      "Minimum Invoice Amount Violation: cannot be satisfied.",
    );
    expect(json.message).toContain("auto-retried 100 times");
    expect(json.message).not.toContain("Anticipated Major Customer Demand");
  });

  it("succeeds immediately when the very first attempt works — no wasted retries", async () => {
    generateInvoiceSplitupsInternal.mockImplementationOnce(
      () => successfulInvoices,
    );

    const { POST } = await import("./route");
    const res = await POST(makeRequest(baseBody()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(generateInvoiceSplitupsInternal).toHaveBeenCalledTimes(1);
  });
});
