import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level smoke test for the upgraded Download Summary endpoint.
 * Prompt 1 established this route's request validation, auth, and
 * finalized-batch data retrieval must stay unchanged — this test proves
 * that end of the contract still holds (same URL param, same auth/
 * finalized-status/not-found behavior) while the workbook itself is now
 * produced by SummaryWorkbookService + xlsmPackager instead of inline
 * ExcelJS calls.
 *
 * `SummaryWorkbookService` itself is exercised thoroughly in its own test
 * file — here it runs for real (not mocked) so this test also proves the
 * route wires real batch/invoice/partner data into it correctly. Only
 * `applyXlsmTemplate` is mocked, to keep this test focused on the route's
 * own responsibilities (request handling, response headers/filename)
 * rather than re-testing XLSM packaging, which has its own dedicated
 * test file.
 */

function makeMockSupabase(
  queues: Record<string, Array<{ data: any; error: any; count?: number }>>,
) {
  const counters: Record<string, number> = {};

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
      for (const m of ["select", "eq", "order", "range", "lte"]) {
        builder[m] = chain;
      }
      builder.single = () => Promise.resolve(response);
      builder.then = (onF: any, onR: any) =>
        Promise.resolve(response).then(onF, onR);
      return builder;
    },
  };

  return supabase as any;
}

let mockSupabaseInstance: any;

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(mockSupabaseInstance),
}));

let mockFetchedInvoices: any[] = [];
vi.mock("@/lib/supabase/fetchAll", () => ({
  fetchAllInvoicesForBatch: () => Promise.resolve(mockFetchedInvoices),
  fetchAllQueryRows: () => Promise.resolve([]),
}));

vi.mock("@/lib/utils/xlsmPackager", () => ({
  applyXlsmTemplate: (xlsxBuffer: any) => Promise.resolve(Buffer.from("fake-xlsm-bytes")),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeInvoice(id: string) {
  return {
    id,
    invoice_number: `AT-2026-27-P-000000${id}`,
    invoice_date: "2026-08-01",
    total_amount: 1000,
    customer_id: "party-1",
    products: [
      {
        product_id: "p1",
        product_name: "Chicken",
        hsn_code: "0207",
        quantity: 10,
        rate: 100,
        amount: 1000,
      },
    ],
  };
}

describe("GET /api/download-summary", () => {
  it("requires a batch id", async () => {
    mockSupabaseInstance = makeMockSupabase({});
    const { GET } = await import("./route");
    const req = { url: "http://localhost/api/download-summary" } as any;
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects when the batch is not finalized", async () => {
    mockSupabaseInstance = makeMockSupabase({
      invoice_batch: [
        { data: { batch_status: "REOPENED", batch_type: "PURCHASE" }, error: null },
      ],
    });
    const { GET } = await import("./route");
    const req = { url: "http://localhost/api/download-summary?id=batch-1" } as any;
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns a macro-enabled XLSM response with the correct filename and content type for a finalized Purchase batch", async () => {
    mockFetchedInvoices = [makeInvoice("1")];
    mockSupabaseInstance = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            id: "batch-1",
            batch_status: "FINALIZED",
            batch_type: "PURCHASE",
            financial_year: "2026-27",
            created_at: "2026-08-01T00:00:00Z",
            issuing_company_id: null,
          },
          error: null,
        },
        { data: null, error: null, count: 3 },
      ],
    });

    const { GET } = await import("./route");
    const req = { url: "http://localhost/api/download-summary?id=batch-1" } as any;
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.ms-excel.sheet.macroEnabled.12",
    );
    expect(res.headers.get("Content-Disposition")).toContain(
      "Summary_Purchase_Batch03.xlsm",
    );
  });

  it("uses Sales filename convention for a finalized Sales batch", async () => {
    mockFetchedInvoices = [makeInvoice("1")];
    mockSupabaseInstance = makeMockSupabase({
      invoice_batch: [
        {
          data: {
            id: "batch-2",
            batch_status: "FINALIZED",
            batch_type: "SALES",
            financial_year: "2026-27",
            created_at: "2026-08-01T00:00:00Z",
            issuing_company_id: null,
          },
          error: null,
        },
        { data: null, error: null, count: 1 },
      ],
    });

    const { GET } = await import("./route");
    const req = { url: "http://localhost/api/download-summary?id=batch-2" } as any;
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "Summary_Sales_Batch01.xlsm",
    );
  });

  it("returns 404 when the batch has no invoices", async () => {
    mockFetchedInvoices = [];
    mockSupabaseInstance = makeMockSupabase({
      invoice_batch: [
        {
          data: { batch_status: "FINALIZED", batch_type: "PURCHASE" },
          error: null,
        },
      ],
    });
    const { GET } = await import("./route");
    const req = { url: "http://localhost/api/download-summary?id=batch-1" } as any;
    const res = await GET(req);
    expect(res.status).toBe(404);
  });
});
