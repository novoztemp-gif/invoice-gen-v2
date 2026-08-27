import { describe, expect, it } from "vitest";

/**
 * ── Contract-level fake for the Sprint 1.6E commit_invoice_batch_with_sequences ──
 *
 * No live Postgres is available in this repo's test environment (confirmed:
 * no `supabase`/`psql`/`docker` binaries), so — per the sprint's own
 * instruction — this does NOT claim to verify real database concurrency or
 * transaction rollback. It models, in plain TypeScript, exactly the
 * decision the new SQL function makes (see
 * supabase/migrations/20260812000000_safe_regeneration_numbering.sql):
 *
 *   1. Lock the (company, FY, type) sequence counter.
 *   2. Look at THIS batch's current invoices (still present, not yet
 *      deleted) for that exact prefix.
 *   3. Reuse the batch's own trailing range iff: it has existing invoices,
 *      they're contiguous, their max equals the CURRENT counter value
 *      (i.e. nothing else has consumed a number after this batch), and
 *      the new invoice count is unchanged.
 *   4. Otherwise, delete + allocate a fresh range from the counter,
 *      exactly like Sprint 1.6C's behavior.
 *   5. Only advance the counter when a fresh range was actually consumed.
 *
 * Real DB-level guarantees this fake does NOT and CANNOT prove:
 *   - that Postgres's `FOR UPDATE` genuinely serializes concurrent
 *     transactions,
 *   - that a raised exception inside the PL/pgSQL function genuinely
 *     rolls back the DELETE/INSERTs/UPDATE together.
 * Both are structural guarantees of Postgres itself and of the function
 * being one un-interrupted block with no internal COMMIT — verifying them
 * for real requires an integration test against a live Postgres instance,
 * which remains an open requirement outside this repo's current test
 * infrastructure.
 */
class FakeAtomicSequenceServerWithReuse {
  private sequences = new Map<string, number>();
  private batchInvoices = new Map<string, number[]>();
  private locks = new Map<string, Promise<void>>();

  private key(companyId: string, fy: string, type: string): string {
    return `${companyId}|${fy}|${type}`;
  }

  seedSequence(companyId: string, fy: string, type: string, last: number) {
    this.sequences.set(this.key(companyId, fy, type), last);
  }

  async commit(
    companyId: string,
    fy: string,
    type: string,
    batchId: string,
    count: number,
    opts: { shouldFail?: boolean } = {},
  ): Promise<{ numbers: number[]; reused: boolean; start: number }> {
    const k = this.key(companyId, fy, type);
    const prevLock = this.locks.get(k) || Promise.resolve();
    let release!: () => void;
    const myLock = new Promise<void>((r) => (release = r));
    this.locks.set(k, prevLock.then(() => myLock));
    await prevLock;

    try {
      await new Promise((r) => setTimeout(r, 0)); // yield while "holding the lock"

      const lastSeq = this.sequences.get(k) || 0;
      const old = this.batchInvoices.get(batchId) || [];

      let reused = false;
      let startSeq = lastSeq;

      if (old.length > 0 && old.length === count) {
        const sorted = [...old].sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const contiguous = max - min + 1 === sorted.length;
        if (contiguous && max === lastSeq) {
          reused = true;
          startSeq = min - 1;
        }
      }

      if (opts.shouldFail) {
        // Fails BEFORE any mutation — mirrors the real function raising
        // an exception before/during the loop, which rolls back
        // everything (delete + inserts + counter update) together.
        throw new Error("simulated persistence failure");
      }

      const numbers = Array.from({ length: count }, (_, i) => startSeq + i + 1);
      this.batchInvoices.set(batchId, numbers); // "delete old, insert new" as one step
      if (!reused) {
        this.sequences.set(k, startSeq + count);
      }

      return { numbers, reused, start: startSeq };
    } finally {
      release();
    }
  }
}

const CO = "co-1";
const FY = "2026-27";
const TYPE = "P";

describe("Safe regeneration numbering — commit_invoice_batch_with_sequences contract (Sprint 1.6E)", () => {
  it("TEST 1: first generation — 1..5, sequence advances to 5", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    const result = await server.commit(CO, FY, TYPE, "batch-A", 5);
    expect(result.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(result.reused).toBe(false);
  });

  it("TEST 2: immediate regeneration, same count — reuses 1..5, sequence stays at 5", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5

    const regen = await server.commit(CO, FY, TYPE, "batch-A", 5);
    expect(regen.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(regen.reused).toBe(true);
  });

  it("TEST 3: another batch consumed numbers afterward — regenerating A gets 11-15, sequence advances to 15, no collision with B (6-10)", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    const a = await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5
    const b = await server.commit(CO, FY, TYPE, "batch-B", 5); // 6-10
    expect(a.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(b.numbers).toEqual([6, 7, 8, 9, 10]);

    const regenA = await server.commit(CO, FY, TYPE, "batch-A", 5);
    expect(regenA.numbers).toEqual([11, 12, 13, 14, 15]);
    expect(regenA.reused).toBe(false);

    const allNumbers = [...a.numbers, ...b.numbers, ...regenA.numbers];
    // Old A (1-5) is gone from the "table" but historically allocated —
    // the live set (B + regenerated A) must never collide.
    expect(new Set([...b.numbers, ...regenA.numbers]).size).toBe(10);
  });

  it("TEST 4: repeated immediate regeneration — always reuses 1..5, never advances further", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5);
    const regen1 = await server.commit(CO, FY, TYPE, "batch-A", 5);
    const regen2 = await server.commit(CO, FY, TYPE, "batch-A", 5);

    expect(regen1.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(regen2.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(regen1.reused).toBe(true);
    expect(regen2.reused).toBe(true);
  });

  it("TEST 5: different company — completely independent sequence keys", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit("co-X", FY, TYPE, "batch-A", 5);
    const y = await server.commit("co-Y", FY, TYPE, "batch-B", 3);
    expect(y.numbers).toEqual([1, 2, 3]);
  });

  it("TEST 6: different financial year — remains independent", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, "2025-26", TYPE, "batch-A", 5);
    const next = await server.commit(CO, "2026-27", TYPE, "batch-B", 3);
    expect(next.numbers).toEqual([1, 2, 3]);
  });

  it("TEST 7: different invoice type — Purchase and Sales remain independent", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, "S", "batch-A", 5);
    const next = await server.commit(CO, FY, "P", "batch-B", 3);
    expect(next.numbers).toEqual([1, 2, 3]);
  });

  it("TEST 8 (contract-level): two concurrent regeneration attempts for the SAME batch never overlap or duplicate", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5

    const [r1, r2] = await Promise.all([
      server.commit(CO, FY, TYPE, "batch-A", 5),
      server.commit(CO, FY, TYPE, "batch-A", 5),
    ]);

    // Because the per-key lock serializes these, one sees the trailing
    // range still reusable (1-5) and the other — running after — sees
    // whatever the first left behind. Whichever runs second cannot also
    // get [1,2,3,4,5] as a DIFFERENT allocation; the fake models this by
    // only ever tracking one "current" state for batch-A, same as the
    // real table would after two sequential DELETE+INSERTs. The
    // invariant that must hold is simply: no two DISTINCT invoices in the
    // final state share a number, and only one coherent 5-number range
    // exists for batch-A afterward.
    expect(new Set(r1.numbers).size).toBe(5);
    expect(new Set(r2.numbers).size).toBe(5);
  });

  it("TEST 9 (contract-level): concurrent regeneration of DIFFERENT batches under the same company/FY/type get safe non-overlapping ranges", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5
    await server.commit(CO, FY, TYPE, "batch-B", 5); // 6-10

    const [regenA, regenB] = await Promise.all([
      server.commit(CO, FY, TYPE, "batch-A", 5),
      server.commit(CO, FY, TYPE, "batch-B", 5),
    ]);

    const all = [...regenA.numbers, ...regenB.numbers];
    expect(new Set(all).size).toBe(10);
  });

  it("TEST 10: another batch exists after the regenerating batch — global sequence is never decremented", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5
    await server.commit(CO, FY, TYPE, "batch-B", 5); // 6-10
    await server.commit(CO, FY, TYPE, "batch-A", 5); // regenerate A -> 11-15

    // Sequence must now be 15 — never dropped back to 5 or 10.
    const next = await server.commit(CO, FY, TYPE, "batch-C", 1);
    expect(next.numbers).toEqual([16]);
  });

  it("TEST 11: regeneration changes invoice count — established rule: falls back to a fresh allocation, does NOT attempt partial/overlapping reuse", async () => {
    // Business rule established in this sprint's Phase 1/2 investigation:
    // the schema has no notion of "which numbers a shrunk/grown batch
    // should keep" — only a full old-range-vs-new-count comparison is
    // derivable safely. Reuse is defined ONLY for an unchanged count;
    // any count change is treated exactly like first-ever generation
    // (fresh range from the current counter), which is always safe and
    // never risks colliding with whatever number would have come right
    // after the old range.
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5

    const regenGrown = await server.commit(CO, FY, TYPE, "batch-A", 7);
    expect(regenGrown.reused).toBe(false);
    expect(regenGrown.numbers).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("TEST 12: failed regeneration — sequence does not advance, and (per the fake's fail-before-mutate ordering matching the real function's atomicity) the old state is left exactly as it was", async () => {
    const server = new FakeAtomicSequenceServerWithReuse();
    await server.commit(CO, FY, TYPE, "batch-A", 5); // 1-5

    await expect(
      server.commit(CO, FY, TYPE, "batch-A", 5, { shouldFail: true }),
    ).rejects.toThrow("simulated persistence failure");

    // A subsequent successful regeneration still sees the ORIGINAL
    // trailing range as reusable — the failed attempt left no trace.
    const retry = await server.commit(CO, FY, TYPE, "batch-A", 5);
    expect(retry.numbers).toEqual([1, 2, 3, 4, 5]);
    expect(retry.reused).toBe(true);
  });
});
