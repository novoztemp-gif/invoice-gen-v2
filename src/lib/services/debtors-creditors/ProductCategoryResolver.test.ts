import { describe, expect, it } from "vitest";
import { resolveProductCategories } from "./ProductCategoryResolver";
import { MonthlySplitUpProduct } from "@/lib/services/monthly-splitup/types";

function makeFakeSupabase(rows: any[]) {
  return {
    from: (table: string) => ({
      select: async (_cols: string) => {
        if (table !== "products") return { data: [], error: null };
        return { data: rows, error: null };
      },
    }),
  } as any;
}

function product(overrides: Partial<MonthlySplitUpProduct>): MonthlySplitUpProduct {
  return {
    hsnCode: "0000",
    description: "UNKNOWN",
    uqc: "KGS",
    totalQuantity: 100,
    taxableValue: 1000,
    ...overrides,
  };
}

describe("resolveProductCategories", () => {
  it("matches by exact HSN code first", async () => {
    const supabase = makeFakeSupabase([
      { hsn_code: "3024300", product_name: "Sardines", category: "Meat" },
    ]);
    const [resolved] = await resolveProductCategories(supabase, [
      product({ hsnCode: "3024300", description: "SARDINES (some variant text)" }),
    ]);
    expect(resolved.category).toBe("Meat");
    expect(resolved.categorySource).toBe("hsn-match");
  });

  it("falls back to a trimmed, case-insensitive name match when HSN doesn't match", async () => {
    const supabase = makeFakeSupabase([
      { hsn_code: "9999999", product_name: "  Pineapples  ", category: "Fruits" },
    ]);
    const [resolved] = await resolveProductCategories(supabase, [
      product({ hsnCode: "8043000", description: "pineapples" }),
    ]);
    expect(resolved.category).toBe("Fruits");
    expect(resolved.categorySource).toBe("name-match");
  });

  it("returns category null and categorySource unmatched when neither matches", async () => {
    const supabase = makeFakeSupabase([
      { hsn_code: "3024300", product_name: "Sardines", category: "Meat" },
    ]);
    const [resolved] = await resolveProductCategories(supabase, [
      product({ hsnCode: "1111111", description: "Something Else Entirely" }),
    ]);
    expect(resolved.category).toBeNull();
    expect(resolved.categorySource).toBe("unmatched");
  });

  it("ignores catalog rows with an invalid/missing category", async () => {
    const supabase = makeFakeSupabase([
      { hsn_code: "3024300", product_name: "Sardines", category: null },
    ]);
    const [resolved] = await resolveProductCategories(supabase, [
      product({ hsnCode: "3024300", description: "SARDINES" }),
    ]);
    expect(resolved.category).toBeNull();
    expect(resolved.categorySource).toBe("unmatched");
  });

  it("preserves the original product fields alongside the resolved category", async () => {
    const supabase = makeFakeSupabase([]);
    const [resolved] = await resolveProductCategories(supabase, [
      product({ hsnCode: "1", description: "X", totalQuantity: 42, taxableValue: 999 }),
    ]);
    expect(resolved.totalQuantity).toBe(42);
    expect(resolved.taxableValue).toBe(999);
  });
});
