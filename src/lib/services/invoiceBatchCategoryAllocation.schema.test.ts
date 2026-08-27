import { describe, expect, it } from "vitest";

/**
 * Sprint 1.7I — schema/type-contract test for the two new, nullable
 * invoice_batch columns (category_allocation, occurrence_semantics) added
 * in this sprint's migration (20260813000000_add_category_allocation_and_
 * occurrence_semantics.sql).
 *
 * IMPORTANT LIMITATION (reported per this sprint's own instruction, not
 * hidden): no live Postgres/Supabase instance is available in this
 * environment (confirmed by prior sprints — no `supabase`/`psql`/`docker`
 * binaries). This file therefore cannot and does not claim to verify that
 * the migration applies successfully against a real database, that the
 * CHECK constraint is enforced by Postgres, or that existing rows survive
 * a real migration run. It verifies only the TypeScript-level shape
 * contract the migration is meant to support — a genuine integration test
 * against a live database remains an open requirement, exactly as with
 * every other schema change in this project's recent sprints (see e.g.
 * Sprint 1.6C's identical limitation for the atomic numbering RPC).
 *
 * The type below is intentionally local to this test file, not exported,
 * and not added to InvoiceEngine.ts or any other application file — this
 * sprint is schema/type-model only and must not begin wiring the feature
 * into consuming code (explicitly forbidden by the sprint spec).
 */
interface InvoiceBatchCategoryFields {
  category_allocation?: { Meat?: number; Fruits?: number } | null;
  occurrence_semantics?: "GLOBAL" | "CATEGORY" | null;
}

describe("invoice_batch.category_allocation / occurrence_semantics — schema contract (Sprint 1.7I)", () => {
  it("TEST 1: an existing (pre-1.7I) batch representation remains valid with both fields absent/null", () => {
    const legacyBatch: InvoiceBatchCategoryFields = {
      category_allocation: null,
      occurrence_semantics: null,
    };
    expect(legacyBatch.category_allocation).toBeNull();
    expect(legacyBatch.occurrence_semantics).toBeNull();

    // Fields entirely absent (the shape every row in the DB actually has
    // immediately after this migration runs, since no backfill occurs)
    // must also be a valid representation.
    const legacyBatchOmitted: InvoiceBatchCategoryFields = {};
    expect(legacyBatchOmitted.category_allocation).toBeUndefined();
    expect(legacyBatchOmitted.occurrence_semantics).toBeUndefined();
  });

  it("TEST 2: a CATEGORY-semantics batch can represent {Meat: 60, Fruits: 40}", () => {
    const newBatch: InvoiceBatchCategoryFields = {
      category_allocation: { Meat: 60, Fruits: 40 },
      occurrence_semantics: "CATEGORY",
    };
    expect(newBatch.category_allocation).toEqual({ Meat: 60, Fruits: 40 });
    expect(newBatch.occurrence_semantics).toBe("CATEGORY");
  });

  it("TEST 3: a GLOBAL-semantics batch remains representable (e.g. an old batch explicitly marked, or a future batch that opts into GLOBAL)", () => {
    const globalBatch: InvoiceBatchCategoryFields = {
      category_allocation: null,
      occurrence_semantics: "GLOBAL",
    };
    expect(globalBatch.occurrence_semantics).toBe("GLOBAL");
    expect(globalBatch.category_allocation).toBeNull();
  });

  it("TEST 4: NULL never implicitly becomes CATEGORY — the two states are distinct, never conflated by this contract", () => {
    const legacyBatch: InvoiceBatchCategoryFields = { occurrence_semantics: null };
    const categoryBatch: InvoiceBatchCategoryFields = {
      occurrence_semantics: "CATEGORY",
    };
    expect(legacyBatch.occurrence_semantics).not.toBe("CATEGORY");
    expect(legacyBatch.occurrence_semantics).toBeNull();
    expect(categoryBatch.occurrence_semantics).toBe("CATEGORY");
  });

  it("TEST 5: no percentage validation is part of this contract — an out-of-range or non-summing category_allocation is still a structurally valid value at the type/schema level (validation is explicitly deferred to a future sprint)", () => {
    const structurallyValidButBusinessInvalid: InvoiceBatchCategoryFields = {
      category_allocation: { Meat: 150, Fruits: -20 },
      occurrence_semantics: "CATEGORY",
    };
    // No throw, no rejection — this migration/type contract does not
    // enforce percentage semantics. That is intentional (Sprint 1.7I
    // scope) and is asserted here so a future sprint accidentally adding
    // premature validation would need to consciously change this test.
    expect(structurallyValidButBusinessInvalid.category_allocation).toEqual({
      Meat: 150,
      Fruits: -20,
    });
  });

  it("occurrence_semantics only ever takes one of exactly two non-null values (matches the migration's CHECK constraint intent)", () => {
    const allowedValues: Array<"GLOBAL" | "CATEGORY" | null | undefined> = [
      "GLOBAL",
      "CATEGORY",
      null,
      undefined,
    ];
    for (const v of allowedValues) {
      const batch: InvoiceBatchCategoryFields = { occurrence_semantics: v };
      expect([undefined, null, "GLOBAL", "CATEGORY"]).toContain(
        batch.occurrence_semantics,
      );
    }
  });
});
