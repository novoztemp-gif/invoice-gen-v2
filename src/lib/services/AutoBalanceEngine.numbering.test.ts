import { describe, expect, it } from "vitest";
import { AutoBalanceEngine } from "./AutoBalanceEngine";

/**
 * Hotfix — getNextInvoiceNumbering used to just scan public.invoice for the
 * current max and add 1 (findMaxInvoiceSequenceForPrefix), entirely
 * bypassing invoice_sequences and its FOR UPDATE lock: two edits landing at
 * the same moment on batches sharing a company+FY+type could compute the
 * same "next" number, and the real counter never advanced, leaving it
 * stale for delete-time sequence reclaim. Now reserves a real range through
 * the reserve_invoice_sequence_range RPC — the same locked, self-healing
 * counter commit_invoice_batch_with_sequences uses for generation.
 *
 * This fake models exactly that RPC's documented contract (see
 * 20260823010000_edit_time_sequence_reservation_and_reclaim_self_heal.sql):
 * self-heals against the true max invoice_number for the prefix, then
 * advances the counter by the requested count and returns the prior value
 * as the start.
 */
function makeMockSupabase(
  invoiceRows: { invoice_number: string }[],
  batchRow: { issuing_company_id: string; financial_year: string },
  storedCounter: number,
) {
  let counter = storedCounter;
  let rpcCallCount = 0;

  return {
    _getCounter: () => counter,
    _getRpcCallCount: () => rpcCallCount,
    from(table: string) {
      if (table === "invoice_batch") {
        return {
          select(_cols: string) {
            return this;
          },
          eq(_col: string, _val: string) {
            return this;
          },
          single() {
            return Promise.resolve({ data: batchRow, error: null });
          },
        };
      }
      // "invoice" table — used only by the RPC's own self-heal logic in
      // the real database; this fake inlines that same reconciliation
      // directly in the rpc() handler below instead of re-querying here.
      return {
        select() {
          return this;
        },
        like() {
          return this;
        },
      };
    },
    rpc(fnName: string, args: any) {
      rpcCallCount++;
      if (fnName !== "reserve_invoice_sequence_range") {
        return Promise.resolve({
          data: null,
          error: { message: `unexpected rpc ${fnName}` },
        });
      }
      const prefix = `${args.p_issuing_company_id}-${args.p_financial_year}-${args.p_invoice_type}`;
      // Self-heal: reconcile against the true max invoice_number for this
      // exact prefix before handing anything out.
      const matching = invoiceRows.filter((r) =>
        r.invoice_number.startsWith(prefix),
      );
      const realMax = matching.reduce((max, r) => {
        const parts = r.invoice_number.split("-");
        const n = parseInt(parts[parts.length - 1], 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
      const start = Math.max(counter, realMax);
      counter = start + Number(args.p_count);
      return Promise.resolve({ data: start, error: null });
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

describe("AutoBalanceEngine.getNextInvoiceNumbering", () => {
  it("TEST 1: Purchase cross-batch collision — Batch A (1-100) + Batch B (101-150), same company+FY+type — new invoice must be 151, not 101", async () => {
    const companyId = "co-1";
    const fy = "2026-27";
    const prefix = `${companyId}-${fy}-P`;
    // The full invoice table contains both Batch A's and Batch B's rows —
    // getNextInvoiceNumbering must reserve against the whole prefix's real
    // max, not just whatever Batch A's own invoices happen to be.
    const allInvoices = seq(prefix, 1, 150);
    const supabase = makeMockSupabase(
      allInvoices,
      { issuing_company_id: companyId, financial_year: fy },
      0, // stale/uninitialized stored counter — self-heal must still find 150
    );
    const engine = new AutoBalanceEngine(supabase);

    // Batch A's own context.invoices — only 1-100, exactly like the real
    // caller passes context.invoices (Batch A's invoices) as the sample
    // used purely to derive the shared string prefix for building numbers.
    const batchAInvoices = seq(prefix, 1, 100);

    const result = await (engine as any).getNextInvoiceNumbering(
      "batch-a",
      batchAInvoices,
    );

    expect(result.prefix).toBe(prefix);
    expect(result.nextSequence).toBe(151);
  });

  it("TEST 2: reservation actually advances the real sequence counter (the fix — this used to be entirely read-only)", async () => {
    const companyId = "co-1";
    const fy = "2026-27";
    const prefix = `${companyId}-${fy}-P`;
    const allInvoices = seq(prefix, 1, 100);
    const supabase = makeMockSupabase(
      allInvoices,
      { issuing_company_id: companyId, financial_year: fy },
      100,
    );
    const engine = new AutoBalanceEngine(supabase);

    expect(supabase._getCounter()).toBe(100);
    await (engine as any).getNextInvoiceNumbering("batch-a", allInvoices);
    // The counter must have moved forward by the reservation buffer, not
    // stayed frozen at the pre-reservation value — this is exactly what
    // keeps delete_invoice_batch_and_reclaim_sequence's ownership check
    // accurate after an edit creates a new invoice.
    expect(supabase._getCounter()).toBeGreaterThan(100);
  });

  it("TEST 3: two sequential reservations for the same prefix never overlap", async () => {
    const companyId = "co-1";
    const fy = "2026-27";
    const prefix = `${companyId}-${fy}-P`;
    const allInvoices = seq(prefix, 1, 50);
    const supabase = makeMockSupabase(
      allInvoices,
      { issuing_company_id: companyId, financial_year: fy },
      50,
    );
    const engine = new AutoBalanceEngine(supabase);

    const first = await (engine as any).getNextInvoiceNumbering(
      "batch-a",
      allInvoices,
    );
    const second = await (engine as any).getNextInvoiceNumbering(
      "batch-a",
      allInvoices,
    );

    expect(second.nextSequence).toBeGreaterThan(first.nextSequence);
    expect(supabase._getRpcCallCount()).toBe(2);
  });

  it("TEST 4: invoice rows themselves are never touched by this lookup — only the sequence counter moves", async () => {
    const companyId = "co-1";
    const fy = "2026-27";
    const prefix = `${companyId}-${fy}-P`;
    const existingRows = seq(prefix, 1, 150);
    const supabase = makeMockSupabase(
      existingRows,
      { issuing_company_id: companyId, financial_year: fy },
      150,
    );
    const engine = new AutoBalanceEngine(supabase);

    const snapshotBefore = existingRows.map((r) => r.invoice_number);
    await (engine as any).getNextInvoiceNumbering(
      "batch-a",
      seq(prefix, 1, 100),
    );
    const snapshotAfter = existingRows.map((r) => r.invoice_number);

    expect(snapshotAfter).toEqual(snapshotBefore);
  });
});
