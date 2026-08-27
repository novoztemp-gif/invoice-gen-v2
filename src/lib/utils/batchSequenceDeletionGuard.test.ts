import { describe, expect, it } from "vitest";
import {
  isBatchDeletable,
  parseSequenceNumber,
  sequenceGroupKey,
  type SequenceGuardedBatch,
} from "./batchSequenceDeletionGuard";

/**
 * Real reported issue: a user cleared every Purchase batch for a company +
 * financial year, then created a fresh one — and it still started around
 * invoice #3051 instead of #1. Root cause: the invoice number sequence
 * only rolls back when a deleted batch is proven to be the CURRENT
 * trailing end of its own company+year+type group; deleting out of order
 * (an older batch while a newer one still exists) correctly declines to
 * roll back, and that decision is permanent — even after everything is
 * eventually deleted. This guard is what the UI uses to make that
 * situation impossible: only ever let the user delete the batch that is
 * currently the true trailing end.
 */

function batch(
  id: string,
  overrides: Partial<SequenceGuardedBatch> = {},
): SequenceGuardedBatch {
  return {
    id,
    issuing_company_id: "co-1",
    financial_year: "2021-22",
    batch_type: "PURCHASE",
    ...overrides,
  };
}

describe("parseSequenceNumber", () => {
  it("extracts the trailing numeric segment", () => {
    expect(parseSequenceNumber("AT-2021-22-P-0003113")).toBe(3113);
    expect(parseSequenceNumber("AT-2026-27-P-0000001")).toBe(1);
  });

  it("returns -1 for missing or unparseable input", () => {
    expect(parseSequenceNumber(null)).toBe(-1);
    expect(parseSequenceNumber(undefined)).toBe(-1);
    expect(parseSequenceNumber("")).toBe(-1);
    expect(parseSequenceNumber("not-a-number-")).toBe(-1);
  });
});

describe("sequenceGroupKey", () => {
  it("differs when company, year, or type differ", () => {
    const base = {
      issuing_company_id: "co-1",
      financial_year: "2021-22",
      batch_type: "PURCHASE",
    };
    expect(sequenceGroupKey(base)).toBe(
      sequenceGroupKey({ ...base }),
    );
    expect(sequenceGroupKey(base)).not.toBe(
      sequenceGroupKey({ ...base, issuing_company_id: "co-2" }),
    );
    expect(sequenceGroupKey(base)).not.toBe(
      sequenceGroupKey({ ...base, financial_year: "2022-23" }),
    );
    expect(sequenceGroupKey(base)).not.toBe(
      sequenceGroupKey({ ...base, batch_type: "SALES" }),
    );
  });
});

describe("isBatchDeletable", () => {
  it("only the batch holding the highest sequence in its group is deletable — the exact real scenario, walked through in order", () => {
    // A: seq up to 10 (oldest), B: seq up to 20, C: seq up to 30 (newest).
    const a = batch("a");
    const b = batch("b");
    const c = batch("c");
    const all = [a, b, c];
    const maxSeq = new Map([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);

    // Step 1: only C (the true trailing end) may be deleted.
    expect(isBatchDeletable(a, all, maxSeq)).toBe(false);
    expect(isBatchDeletable(b, all, maxSeq)).toBe(false);
    expect(isBatchDeletable(c, all, maxSeq)).toBe(true);

    // Step 2: C is gone. Now B is the trailing end.
    const afterC = [a, b];
    expect(isBatchDeletable(a, afterC, maxSeq)).toBe(false);
    expect(isBatchDeletable(b, afterC, maxSeq)).toBe(true);

    // Step 3: B is gone too. A is now (trivially) the trailing end.
    const afterB = [a];
    expect(isBatchDeletable(a, afterB, maxSeq)).toBe(true);
  });

  it("deleting out of order is exactly what the guard prevents (proves the bug the guard closes)", () => {
    // If the guard were bypassed and A (not the trailing end) were deleted
    // first, B and C would still exist above it — a real system would
    // correctly decline to reclaim in that case, permanently stranding A's
    // range. The guard's job is to never present that choice:
    const a = batch("a");
    const b = batch("b");
    const c = batch("c");
    const all = [a, b, c];
    const maxSeq = new Map([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);

    expect(isBatchDeletable(a, all, maxSeq)).toBe(false);
  });

  it("a batch with no invoices at all is always deletable — it never consumed any sequence numbers", () => {
    const empty = batch("empty");
    const withInvoices = batch("with-invoices");
    const all = [empty, withInvoices];
    const maxSeq = new Map([["with-invoices", 50]]); // "empty" has no entry

    expect(isBatchDeletable(empty, all, maxSeq)).toBe(true);
  });

  it("does not block a batch just because a DIFFERENT company/year/type group has higher numbers", () => {
    const older = batch("older", { issuing_company_id: "co-1" });
    const otherGroupNewer = batch("other-group", {
      issuing_company_id: "co-2",
    });
    const all = [older, otherGroupNewer];
    const maxSeq = new Map([
      ["older", 5],
      ["other-group", 9999],
    ]);

    // "older" is the ONLY batch in co-1's group, so it's the trailing end
    // of its own group regardless of what co-2 is doing.
    expect(isBatchDeletable(older, all, maxSeq)).toBe(true);
  });

  it("Sales batch_type is a separate group from Purchase for the same company/year", () => {
    const purchase = batch("p1", { batch_type: "PURCHASE" });
    const sales = batch("s1", { batch_type: "SALES" });
    const all = [purchase, sales];
    const maxSeq = new Map([
      ["p1", 5],
      ["s1", 9999],
    ]);

    expect(isBatchDeletable(purchase, all, maxSeq)).toBe(true);
  });
});
