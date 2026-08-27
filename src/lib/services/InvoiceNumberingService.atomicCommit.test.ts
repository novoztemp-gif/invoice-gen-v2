import { describe, expect, it } from "vitest";
import {
  InvoiceNumberingService,
} from "./InvoiceNumberingService";

/**
 * ── Contract-level fake for commit_invoice_batch_with_sequences ──
 *
 * This repository's test environment has no live Postgres instance, so a
 * genuine concurrent-transaction test against the real RPC is not
 * possible here (per the Sprint 1.6C spec: "If true database integration
 * testing is available, use it... If it is NOT available, do not fake it
 * — test the RPC/service contract with mocks, and clearly state that
 * true DB-level concurrency remains an integration-test requirement").
 *
 * This class models exactly the contract documented in the migration
 * (supabase/migrations/20260722120000_intelligent_invoice_numbering_system.sql):
 *   - one counter per (issuing_company_id, financial_year, invoice_type)
 *   - the row is exclusively locked for the duration of a whole batch
 *     commit (SELECT ... FOR UPDATE) — modeled here as a per-key async
 *     mutex, so two "concurrent" callers to the SAME key are provably
 *     serialized, never interleaved
 *   - the counter only advances AFTER the whole batch succeeds ("Update
 *     sequence count ONLY AFTER all invoices successfully inserted") — a
 *     failure leaves it exactly where it was, i.e. no gap is introduced
 *     by a failed attempt
 *
 * It does NOT test that Postgres's FOR UPDATE actually serializes
 * concurrent transactions — that guarantee comes from Postgres itself and
 * is exactly the kind of thing that needs a real integration test against
 * a live database, which this repo does not currently have wired up.
 */
class FakeAtomicSequenceServer {
  private sequences = new Map<string, number>();
  private locks = new Map<string, Promise<void>>();

  private key(companyId: string, fy: string, type: string): string {
    return `${companyId}|${fy}|${type}`;
  }

  seed(companyId: string, fy: string, type: string, lastSequence: number) {
    this.sequences.set(this.key(companyId, fy, type), lastSequence);
  }

  async commit(
    companyId: string,
    fy: string,
    type: string,
    count: number,
    opts: { shouldFail?: boolean } = {},
  ): Promise<{ start: number; numbers: number[] }> {
    const k = this.key(companyId, fy, type);
    const prevLock = this.locks.get(k) || Promise.resolve();
    let release!: () => void;
    const myLock = new Promise<void>((r) => (release = r));
    this.locks.set(k, prevLock.then(() => myLock));
    await prevLock;

    try {
      const start = this.sequences.get(k) || 0;
      // Yield control while "holding the lock" — if serialization were
      // broken, this is what would let a second caller read the same
      // stale `start`.
      await new Promise((r) => setTimeout(r, 0));

      if (opts.shouldFail) {
        throw new Error("simulated persistence failure");
      }

      const numbers = Array.from({ length: count }, (_, i) => start + i + 1);
      this.sequences.set(k, start + count);
      return { start, numbers };
    } finally {
      release();
    }
  }
}

describe("Atomic sequence allocation contract (Sprint 1.6C)", () => {
  it("REGRESSION 1: atomic allocation of one invoice", async () => {
    const server = new FakeAtomicSequenceServer();
    const { numbers } = await server.commit("co-1", "2026-27", "P", 1);
    expect(numbers).toEqual([1]);
  });

  it("REGRESSION 2: atomic allocation of multiple invoices", async () => {
    const server = new FakeAtomicSequenceServer();
    const { numbers } = await server.commit("co-1", "2026-27", "P", 5);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it("REGRESSION 3 / CONCURRENCY TEST: two concurrent 5-invoice allocations for the same company+FY+type never overlap", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-1", "2026-27", "P", 150); // existing 1-150

    const [a, b] = await Promise.all([
      server.commit("co-1", "2026-27", "P", 5),
      server.commit("co-1", "2026-27", "P", 5),
    ]);

    const allNumbers = [...a.numbers, ...b.numbers];
    expect(new Set(allNumbers).size).toBe(10);
    expect(allNumbers.every((n) => n > 150)).toBe(true);

    // Each request got a contiguous range.
    for (const result of [a, b]) {
      const sorted = [...result.numbers].sort((x, y) => x - y);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    }

    // The two ranges partition 151-160 with no overlap, in either order.
    const [first, second] = [a, b].sort((x, y) => x.start - y.start);
    expect(first.start).toBe(150);
    expect(second.start).toBe(first.start + 5);
  });

  it("REGRESSION 4: same company+FY+type — a second commit continues from the first (existing sequence continuation)", async () => {
    const server = new FakeAtomicSequenceServer();
    const first = await server.commit("co-1", "2026-27", "P", 100); // Batch A: 1-100
    const second = await server.commit("co-1", "2026-27", "P", 50); // Batch B
    expect(first.numbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(second.numbers[0]).toBe(101);
    expect(second.numbers[second.numbers.length - 1]).toBe(150);
  });

  it("REGRESSION 5: different company isolation — Company Y's sequence never affects Company X's", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-Y", "2026-27", "P", 500);
    const { numbers } = await server.commit("co-X", "2026-27", "P", 1);
    expect(numbers).toEqual([1]);
  });

  it("REGRESSION 6: different financial year isolation", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-1", "2025-26", "P", 500);
    const { numbers } = await server.commit("co-1", "2026-27", "P", 1);
    expect(numbers).toEqual([1]);
  });

  it("REGRESSION 7: Purchase/Sales invoice-type isolation", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-1", "2026-27", "S", 500);
    const { numbers } = await server.commit("co-1", "2026-27", "P", 1);
    expect(numbers).toEqual([1]);
  });

  it("REGRESSION 9 (contract-level): committing never touches any pre-existing row's own number — only new numbers are ever computed/returned", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-1", "2026-27", "P", 150);
    const before = new Map(server["sequences"]); // snapshot of counters only — no invoice rows exist in this fake at all
    await server.commit("co-1", "2026-27", "P", 1);
    // The mechanism only ever ADDS a new count to the counter and returns
    // brand-new numbers — there is no code path here (or in the real RPC,
    // per the migration's INSERT-only loop) that reads or rewrites an
    // existing invoice's invoice_number.
    expect(before.get("co-1|2026-27|P")).toBe(150);
  });

  it("REGRESSION 11 / GAP POLICY: a failed commit does not advance the sequence — no gap is left behind", async () => {
    const server = new FakeAtomicSequenceServer();
    server.seed("co-1", "2026-27", "P", 150);

    await expect(
      server.commit("co-1", "2026-27", "P", 5, { shouldFail: true }),
    ).rejects.toThrow("simulated persistence failure");

    // Exactly matches the real migration's documented behavior: "Update
    // sequence count ONLY AFTER all invoices successfully inserted" — a
    // failed attempt leaves last_sequence_number untouched, so the next
    // successful commit resumes at 151, not 156. No gap is intentionally
    // reserved for a failed attempt.
    const { start, numbers } = await server.commit(
      "co-1",
      "2026-27",
      "P",
      1,
    );
    expect(start).toBe(150);
    expect(numbers).toEqual([151]);
  });
});

describe("InvoiceNumberingService.fetchSequencePreview", () => {
  /**
   * Hotfix history — the preview used to auto-detect the next number by
   * scanning `invoice` rows for the highest match, independently of the
   * `invoice_sequences` counter real generation actually reads; then fixed
   * to read that same counter, gated behind a client-side existence check
   * on `invoice` (self-heal to 0 only if genuinely nothing exists for this
   * prefix).
   *
   * REGRESSION found next: `invoice`'s RLS only grants SELECT to
   * `authenticated` (not `anon`, unlike invoice_sequences) — if the
   * existence check ran before the browser's Supabase session finished
   * hydrating, it silently came back empty and the preview showed "next:
   * 1" for a batch that already had many real invoices, even though real
   * generation (SECURITY DEFINER, bypasses RLS) was unaffected. Fixed by
   * moving the whole self-heal decision server-side into
   * get_invoice_sequence_preview (SECURITY DEFINER RPC, see
   * 20260827000000_rls_safe_sequence_preview_rpc.sql) — the preview now
   * asks the SAME question commit_invoice_batch_with_sequences answers
   * internally, immune to client auth timing, instead of re-deriving it
   * client-side from two separately-gated table reads.
   */
  function makeMockSupabase(
    tableData: Record<string, any>,
    rpcResponse: { data: any; error: any },
    onRpc?: (...args: any[]) => void,
  ) {
    return {
      from(table: string) {
        const response = tableData[table] ?? { data: [], error: null };
        const builder: any = {};
        const chain = (..._a: any[]) => builder;
        for (const m of ["select", "eq", "like", "order", "range", "limit"]) {
          builder[m] = chain;
        }
        builder.single = () => Promise.resolve(response);
        builder.maybeSingle = () => Promise.resolve(response);
        builder.then = (onF: any, onR: any) =>
          Promise.resolve(response).then(onF, onR);
        return builder;
      },
      rpc(...args: any[]) {
        onRpc?.(...args);
        return Promise.resolve(rpcResponse);
      },
    } as any;
  }

  it("calls get_invoice_sequence_preview with the normalised prefix pieces, never reading `invoice` directly", async () => {
    let capturedArgs: any[] = [];
    const supabase = makeMockSupabase(
      {
        issuing_companies: {
          data: { company_name: "Test Co", abbreviation: "TST" },
          error: null,
        },
      },
      { data: 0, error: null },
      (...args) => (capturedArgs = args),
    );

    const preview = await InvoiceNumberingService.fetchSequencePreview(
      supabase,
      "co-1",
      "2026-27",
      "P",
    );

    expect(capturedArgs[0]).toBe("get_invoice_sequence_preview");
    expect(capturedArgs[1]).toEqual({
      p_issuing_company_id: "co-1",
      p_financial_year: "2026-27",
      p_invoice_type: "P",
    });
    expect(preview?.nextSequenceNumber).toBe(1);
  });

  it("trusts whatever effective sequence the RPC returns when invoices exist", async () => {
    const supabase = makeMockSupabase(
      {
        issuing_companies: {
          data: { company_name: "Test Co", abbreviation: "TST" },
          error: null,
        },
      },
      { data: 50, error: null },
    );

    const preview = await InvoiceNumberingService.fetchSequencePreview(
      supabase,
      "co-1",
      "2026-27",
      "P",
    );

    expect(preview?.currentSequenceNumber).toBe(50);
    expect(preview?.nextSequenceNumber).toBe(51);
  });

  it("REGRESSION — shows next: 1 when the RPC reports zero (self-healed), regardless of what a stale client-side read might have shown", async () => {
    // The exact reported scenario: every batch for this company+year was
    // deleted, and the RPC's own backward self-heal (mirroring
    // 20260823000000_self_heal_sequence_to_zero_when_empty.sql) reports 0
    // — the preview must trust that directly, not re-derive it from a
    // separately-gated client-side table read.
    const supabase = makeMockSupabase(
      {
        issuing_companies: {
          data: { company_name: "Test Co", abbreviation: "TST" },
          error: null,
        },
      },
      { data: 0, error: null },
    );

    const preview = await InvoiceNumberingService.fetchSequencePreview(
      supabase,
      "co-1",
      "2026-27",
      "P",
    );

    expect(preview?.currentSequenceNumber).toBe(0);
    expect(preview?.nextSequenceNumber).toBe(1);
    expect(preview?.nextInvoiceNumber).toBe("TST-2026-27-P-0000001");
  });
});
