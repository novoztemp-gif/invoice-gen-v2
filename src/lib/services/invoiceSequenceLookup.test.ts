import { describe, expect, it } from "vitest";
import { findMaxInvoiceSequenceForPrefix } from "./invoiceSequenceLookup";

/**
 * Minimal chainable mock that actually applies the `.like(col, "prefix-%")`
 * filter against an in-memory row set (rather than ignoring it) — so these
 * tests genuinely prove company/FY/invoice-type isolation, not just that
 * the function runs.
 */
function makeMockSupabase(allRows: { invoice_number: string }[]) {
  return {
    from(_table: string) {
      let likePattern = "";
      const builder = {
        select(_cols: string) {
          return builder;
        },
        like(_col: string, pattern: string) {
          likePattern = pattern;
          return builder;
        },
        range(from: number, to: number) {
          const prefix = likePattern.replace(/%$/, "");
          const filtered = allRows.filter((r) =>
            r.invoice_number.startsWith(prefix),
          );
          return Promise.resolve({
            data: filtered.slice(from, to + 1),
            error: null,
          });
        },
      };
      return builder;
    },
  } as any;
}

function seq(prefix: string, from: number, to: number) {
  const rows: { invoice_number: string }[] = [];
  for (let n = from; n <= to; n++) {
    rows.push({ invoice_number: `${prefix}-${String(n).padStart(7, "0")}` });
  }
  return rows;
}

describe("findMaxInvoiceSequenceForPrefix (Sprint 1.6B)", () => {
  it("TEST 3: different company must not affect sequence", () => {
    const rows = [
      ...seq("X-2026-27-P", 1, 100),
      ...seq("Y-2026-27-P", 1, 500),
    ];
    const supabase = makeMockSupabase(rows);
    return findMaxInvoiceSequenceForPrefix(supabase, "X-2026-27-P").then(
      (max) => {
        expect(max + 1).toBe(101);
      },
    );
  });

  it("TEST 4: different financial year must not affect sequence", () => {
    const rows = [
      ...seq("X-2025-26-P", 1, 500),
      ...seq("X-2026-27-P", 1, 100),
    ];
    const supabase = makeMockSupabase(rows);
    return findMaxInvoiceSequenceForPrefix(supabase, "X-2026-27-P").then(
      (max) => {
        expect(max + 1).toBe(101);
      },
    );
  });

  it("TEST 5: different invoice type must not affect sequence", () => {
    const rows = [
      ...seq("X-2026-27-P", 1, 100),
      ...seq("X-2026-27-S", 1, 500),
    ];
    const supabase = makeMockSupabase(rows);
    return findMaxInvoiceSequenceForPrefix(supabase, "X-2026-27-P").then(
      (max) => {
        expect(max + 1).toBe(101);
      },
    );
  });

  it("TEST 6: numeric suffix comparison, not lexicographical string order", async () => {
    const rows = [
      "INV-0000001",
      "INV-0000009",
      "INV-0000010",
      "INV-0000099",
      "INV-0000100",
    ].map((invoice_number) => ({ invoice_number }));
    const supabase = makeMockSupabase(rows);
    const max = await findMaxInvoiceSequenceForPrefix(supabase, "INV");
    expect(max + 1).toBe(101);
  });

  it("TEST 7: no existing invoices for the prefix — first sequence is 1", async () => {
    const supabase = makeMockSupabase([]);
    const max = await findMaxInvoiceSequenceForPrefix(supabase, "X-2026-27-P");
    expect(max + 1).toBe(1);
  });

  it("TEST 1 / TEST 8: cross-batch collision — Batch A (1-100) + Batch B (101-150) sharing the same company+FY+type must yield next=151, not 101", async () => {
    const rows = seq("X-2026-27-P", 1, 150); // Batch A: 1-100, Batch B: 101-150, same prefix
    const supabase = makeMockSupabase(rows);
    const max = await findMaxInvoiceSequenceForPrefix(supabase, "X-2026-27-P");
    expect(max + 1).toBe(151);
  });

  it("empty prefix short-circuits to 0 without querying", async () => {
    const supabase = makeMockSupabase(seq("X-2026-27-P", 1, 10));
    const max = await findMaxInvoiceSequenceForPrefix(supabase, "");
    expect(max).toBe(0);
  });
});
