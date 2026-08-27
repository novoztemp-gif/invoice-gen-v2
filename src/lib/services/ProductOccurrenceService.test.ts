import { describe, expect, it } from "vitest";
import {
  calculateTargetOccurrences,
  checkOccurrenceFeasibility,
  countActualOccurrences,
  evaluateFeasibilityFromTargets,
  findOccurrenceViolations,
  validateCategoryOccurrenceConfiguration,
  validateOccurrenceConfiguration,
} from "./ProductOccurrenceService";
import type { ProductConfig } from "./InvoiceEngine";

function product(
  productId: string,
  occurrencePercentage: any,
  overrides: Partial<ProductConfig> = {},
): ProductConfig {
  return {
    product_id: productId,
    product_name: productId,
    hsn_code: "0000",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage,
    ...overrides,
  };
}

/**
 * ProductConfig has no `category` field declared in InvoiceEngine.ts —
 * runtime batch products always carry one (via `any`-cast reads
 * throughout InvoiceEngine.ts), so this helper attaches it the same way,
 * via a cast, purely for these category-validation tests.
 */
function catProduct(
  id: string,
  pct: any,
  category: "Meat" | "Fruits",
): ProductConfig {
  return { ...product(id, pct), category } as any as ProductConfig;
}

describe("calculateTargetOccurrences", () => {
  it("TEST 1: 100 invoices, 50/30/20 -> A=50 B=30 C=20", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      100,
    );
    expect(result.get("A")).toBe(50);
    expect(result.get("B")).toBe(30);
    expect(result.get("C")).toBe(20);
  });

  it("TEST 2: 7 invoices, 50/30/20 -> A=4 B=2 C=1", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      7,
    );
    expect(result.get("A")).toBe(4);
    expect(result.get("B")).toBe(2);
    expect(result.get("C")).toBe(1);
  });

  it("TEST 3: 7 invoices, 50/50 -> deterministic A=4 B=3 (tie-break by productId ASC)", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 50 },
      ],
      7,
    );
    expect(result.get("A")).toBe(4);
    expect(result.get("B")).toBe(3);
  });

  it("TEST 4: one product at 100% -> N", () => {
    const result = calculateTargetOccurrences(
      [{ productId: "A", occurrencePercentage: 100 }],
      37,
    );
    expect(result.get("A")).toBe(37);
  });

  it("TEST 5: product at 0% -> target 0 (still valid if others sum to 100 total)", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 100 },
        { productId: "B", occurrencePercentage: 0 },
      ],
      10,
    );
    expect(result.get("A")).toBe(10);
    expect(result.get("B")).toBe(0);
  });

  it("TEST 6: totalInvoiceCount = 0 -> every configured product = 0", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      0,
    );
    expect(result.get("A")).toBe(0);
    expect(result.get("B")).toBe(0);
    expect(result.get("C")).toBe(0);
  });

  it("TEST 7: percentages not summing to 100 -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "A", occurrencePercentage: 40 },
          { productId: "B", occurrencePercentage: 30 },
          { productId: "C", occurrencePercentage: 20 },
        ],
        100,
      ),
    ).toThrow(/must equal exactly 100%/);
  });

  it("does not silently normalize an invalid distribution (40/30/20 stays rejected, never becomes 40/30/30)", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "A", occurrencePercentage: 40 },
          { productId: "B", occurrencePercentage: 30 },
          { productId: "C", occurrencePercentage: 20 },
        ],
        10,
      ),
    ).toThrow();
  });

  it("TEST 8: percentage < 0 -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "A", occurrencePercentage: -10 },
          { productId: "B", occurrencePercentage: 110 },
        ],
        10,
      ),
    ).toThrow(/between 0 and 100/);
  });

  it("TEST 9: percentage > 100 -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [{ productId: "A", occurrencePercentage: 150 }],
        10,
      ),
    ).toThrow(/between 0 and 100/);
  });

  it("TEST 10a: NaN percentage -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [{ productId: "A", occurrencePercentage: NaN }],
        10,
      ),
    ).toThrow(/finite number/);
  });

  it("TEST 10b: Infinity percentage -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "A", occurrencePercentage: Infinity },
          { productId: "B", occurrencePercentage: 0 },
        ],
        10,
      ),
    ).toThrow(/finite number/);
  });

  it("TEST 11: duplicate product IDs -> throws", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "A", occurrencePercentage: 50 },
          { productId: "A", occurrencePercentage: 50 },
        ],
        10,
      ),
    ).toThrow(/Duplicate product ID/);
  });

  it("TEST 12: empty products + N > 0 -> throws", () => {
    expect(() => calculateTargetOccurrences([], 10)).toThrow(
      /zero configured products/,
    );
  });

  it("TEST 13: empty products + N = 0 -> empty Map", () => {
    const result = calculateTargetOccurrences([], 0);
    expect(result.size).toBe(0);
  });

  it("TEST 14: deterministic tie-breaking independent of input order", () => {
    const productsOrderA = [
      { productId: "A", occurrencePercentage: 50 },
      { productId: "B", occurrencePercentage: 50 },
    ];
    const productsOrderB = [
      { productId: "B", occurrencePercentage: 50 },
      { productId: "A", occurrencePercentage: 50 },
    ];
    const resultA = calculateTargetOccurrences(productsOrderA, 7);
    const resultB = calculateTargetOccurrences(productsOrderB, 7);
    expect(Object.fromEntries(resultA)).toEqual(Object.fromEntries(resultB));
    expect(resultA.get("A")).toBe(4);
    expect(resultA.get("B")).toBe(3);
  });

  it("TEST 15: fractional percentages exercising Largest Remainder clearly (33.33/33.33/33.34 over 9 invoices)", () => {
    const result = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 33.33 },
        { productId: "B", occurrencePercentage: 33.33 },
        { productId: "C", occurrencePercentage: 33.34 },
      ],
      9,
    );
    // exact: 2.9997 / 2.9997 / 3.0006 -> floors 2/2/3 = 7, 2 remaining slots
    // remainders: 0.9997 / 0.9997 / 0.0006 -> A and B (tied remainder, tied
    // pct, productId ASC) get the two extra slots.
    expect(result.get("A")).toBe(3);
    expect(result.get("B")).toBe(3);
    expect(result.get("C")).toBe(3);
    expect(
      (result.get("A") || 0) + (result.get("B") || 0) + (result.get("C") || 0),
    ).toBe(9);
  });

  it("TEST 16: target counts always sum exactly to N (many-product fixture)", () => {
    const products = [
      { productId: "A", occurrencePercentage: 17 },
      { productId: "B", occurrencePercentage: 23 },
      { productId: "C", occurrencePercentage: 11 },
      { productId: "D", occurrencePercentage: 19 },
      { productId: "E", occurrencePercentage: 30 },
    ];
    for (const n of [0, 1, 3, 13, 47, 100, 613]) {
      const result = calculateTargetOccurrences(products, n);
      const sum = Array.from(result.values()).reduce((s, v) => s + v, 0);
      expect(sum).toBe(n);
    }
  });

  it("rejects a non-integer totalInvoiceCount", () => {
    expect(() =>
      calculateTargetOccurrences(
        [{ productId: "A", occurrencePercentage: 100 }],
        3.5,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects a negative totalInvoiceCount", () => {
    expect(() =>
      calculateTargetOccurrences(
        [{ productId: "A", occurrencePercentage: 100 }],
        -1,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects an empty product ID", () => {
    expect(() =>
      calculateTargetOccurrences(
        [
          { productId: "", occurrencePercentage: 50 },
          { productId: "B", occurrencePercentage: 50 },
        ],
        10,
      ),
    ).toThrow(/empty product ID/);
  });
});

describe("countActualOccurrences", () => {
  it("TEST 17: one product on one invoice -> 1", () => {
    const result = countActualOccurrences([
      { products: [{ product_id: "A", quantity: 5 }] },
    ]);
    expect(result.get("A")).toBe(1);
  });

  it("TEST 18: same product twice on one invoice -> still 1", () => {
    const result = countActualOccurrences([
      {
        products: [
          { product_id: "A", quantity: 2 },
          { product_id: "A", quantity: 5 },
          { product_id: "B", quantity: 1 },
        ],
      },
    ]);
    expect(result.get("A")).toBe(1);
    expect(result.get("B")).toBe(1);
  });

  it("TEST 19: same product across 3 invoices -> 3", () => {
    const result = countActualOccurrences([
      { products: [{ product_id: "A", quantity: 1 }] },
      { products: [{ product_id: "A", quantity: 2 }] },
      { products: [{ product_id: "A", quantity: 3 }] },
    ]);
    expect(result.get("A")).toBe(3);
  });

  it("TEST 20: quantity = 0 -> ignored", () => {
    const result = countActualOccurrences([
      { products: [{ product_id: "A", quantity: 0 }] },
    ]);
    expect(result.get("A")).toBeUndefined();
    expect(result.size).toBe(0);
  });

  it("TEST 21: negative quantity -> ignored", () => {
    const result = countActualOccurrences([
      { products: [{ product_id: "A", quantity: -3 }] },
    ]);
    expect(result.get("A")).toBeUndefined();
  });

  it("TEST 22: multiple products on same invoice all count once each", () => {
    const result = countActualOccurrences([
      {
        products: [
          { product_id: "A", quantity: 1 },
          { product_id: "B", quantity: 1 },
          { product_id: "C", quantity: 1 },
        ],
      },
    ]);
    expect(result.get("A")).toBe(1);
    expect(result.get("B")).toBe(1);
    expect(result.get("C")).toBe(1);
  });

  it("TEST 23: empty invoice list -> empty Map", () => {
    const result = countActualOccurrences([]);
    expect(result.size).toBe(0);
  });

  it("TEST 24: invoice with no product lines -> ignored, no error", () => {
    const result = countActualOccurrences([{ products: [] }]);
    expect(result.size).toBe(0);
  });

  it("TEST 25: malformed/empty product_id lines are ignored, not counted as a bogus key", () => {
    const result = countActualOccurrences([
      {
        products: [
          { product_id: "", quantity: 5 },
          { product_id: "A", quantity: 5 },
        ],
      },
      { products: [{ product_id: undefined as any, quantity: 5 }] },
    ]);
    expect(result.has("")).toBe(false);
    expect(result.get("A")).toBe(1);
    expect(result.size).toBe(1);
  });

  it("TEST 26: input invoice objects are not mutated", () => {
    const invoice = {
      products: [
        { product_id: "A", quantity: 2 },
        { product_id: "A", quantity: 3 },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(invoice));
    countActualOccurrences([invoice]);
    expect(invoice).toEqual(snapshot);
  });
});

describe("findOccurrenceViolations", () => {
  it("TEST 27: exact match -> []", () => {
    const target = new Map([["A", 5], ["B", 3]]);
    const actual = new Map([["A", 5], ["B", 3]]);
    expect(findOccurrenceViolations(target, actual)).toEqual([]);
  });

  it("TEST 28: actual below target -> violation", () => {
    const target = new Map([["A", 5]]);
    const actual = new Map([["A", 3]]);
    const result = findOccurrenceViolations(target, actual);
    expect(result).toEqual([
      { productId: "A", target: 5, actual: 3, deviation: -2 },
    ]);
  });

  it("TEST 29: actual above target -> violation", () => {
    const target = new Map([["A", 5]]);
    const actual = new Map([["A", 8]]);
    const result = findOccurrenceViolations(target, actual);
    expect(result).toEqual([
      { productId: "A", target: 5, actual: 8, deviation: 3 },
    ]);
  });

  it("TEST 30: missing actual product -> treated as actual 0", () => {
    const target = new Map([["A", 4]]);
    const actual = new Map<string, number>();
    const result = findOccurrenceViolations(target, actual);
    expect(result).toEqual([
      { productId: "A", target: 4, actual: 0, deviation: -4 },
    ]);
  });

  it("TEST 31: unexpected actual product (absent from target) is reported, not silently ignored", () => {
    const target = new Map([["A", 4]]);
    const actual = new Map([["A", 4], ["Z", 2]]);
    const result = findOccurrenceViolations(target, actual);
    expect(result).toEqual([
      { productId: "Z", target: 0, actual: 2, deviation: 2 },
    ]);
  });

  it("TEST 32: tolerance allows small deviation through", () => {
    const target = new Map([["A", 10]]);
    const actual = new Map([["A", 9]]);
    expect(findOccurrenceViolations(target, actual, 1)).toEqual([]);
  });

  it("TEST 33: deviation above tolerance -> still a violation", () => {
    const target = new Map([["A", 10]]);
    const actual = new Map([["A", 7]]);
    const result = findOccurrenceViolations(target, actual, 1);
    expect(result).toEqual([
      { productId: "A", target: 10, actual: 7, deviation: -3 },
    ]);
  });

  it("TEST 34: deterministic productId ASC ordering", () => {
    const target = new Map([["Z", 1], ["A", 1], ["M", 1]]);
    const actual = new Map<string, number>(); // everything violates (missing)
    const result = findOccurrenceViolations(target, actual);
    expect(result.map((v) => v.productId)).toEqual(["A", "M", "Z"]);
  });

  it("TEST 35: target and actual maps remain unmodified", () => {
    const target = new Map([["A", 5]]);
    const actual = new Map([["A", 3], ["Z", 1]]);
    const targetSnapshot = new Map(target);
    const actualSnapshot = new Map(actual);
    findOccurrenceViolations(target, actual);
    expect(target).toEqual(targetSnapshot);
    expect(actual).toEqual(actualSnapshot);
  });
});

describe("cross-function composition", () => {
  it("100 invoices / 50-30-20: calculate target -> build matching invoices -> count actual -> zero violations", () => {
    const target = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      100,
    );
    expect(target.get("A")).toBe(50);
    expect(target.get("B")).toBe(30);
    expect(target.get("C")).toBe(20);

    const invoices: { products: { product_id: string; quantity: number }[] }[] =
      [];
    for (let i = 0; i < 50; i++) {
      invoices.push({ products: [{ product_id: "A", quantity: 10 }] });
    }
    for (let i = 0; i < 30; i++) {
      invoices.push({ products: [{ product_id: "B", quantity: 10 }] });
    }
    for (let i = 0; i < 20; i++) {
      invoices.push({ products: [{ product_id: "C", quantity: 10 }] });
    }
    expect(invoices.length).toBe(100);

    const actual = countActualOccurrences(invoices);
    expect(actual.get("A")).toBe(50);
    expect(actual.get("B")).toBe(30);
    expect(actual.get("C")).toBe(20);

    const violations = findOccurrenceViolations(target, actual);
    expect(violations).toEqual([]);
  });
});

describe("validateOccurrenceConfiguration", () => {
  it("TEST 1: 50/30/20 -> valid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50),
      product("B", 30),
      product("C", 20),
    ]);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("TEST 2: 100% one product -> valid", () => {
    const result = validateOccurrenceConfiguration([product("A", 100)]);
    expect(result.valid).toBe(true);
  });

  it("TEST 3: 0% product + remaining sum to 100 -> valid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 100),
      product("B", 0),
    ]);
    expect(result.valid).toBe(true);
  });

  it("TEST 4: total = 99.99 -> valid (within 0.01 tolerance)", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 49.99),
      product("B", 50.0),
    ]);
    expect(result.valid).toBe(true);
  });

  it("TEST 5: total = 100.01 -> valid (within 0.01 tolerance)", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50.01),
      product("B", 50.0),
    ]);
    expect(result.valid).toBe(true);
  });

  it("TEST 6: total = 99.98 -> invalid (outside tolerance)", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 49.99),
      product("B", 49.99),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must total 100%"))).toBe(true);
  });

  it("TEST 7: total = 100.02 -> invalid (outside tolerance)", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50.01),
      product("B", 50.01),
    ]);
    expect(result.valid).toBe(false);
  });

  it("TEST 8: percentage < 0 -> invalid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", -10),
      product("B", 110),
    ]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("between 0 and 100")),
    ).toBe(true);
  });

  it("TEST 9: percentage > 100 -> invalid", () => {
    const result = validateOccurrenceConfiguration([product("A", 150)]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("between 0 and 100")),
    ).toBe(true);
  });

  it("TEST 10: missing percentage (key omitted) -> invalid", () => {
    const p: any = product("A", 100);
    delete p.occurrencePercentage;
    const result = validateOccurrenceConfiguration([p]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is required"))).toBe(true);
  });

  it("TEST 11: null percentage -> invalid", () => {
    const result = validateOccurrenceConfiguration([product("A", null)]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is required"))).toBe(true);
  });

  it("TEST 12: undefined percentage -> invalid", () => {
    const result = validateOccurrenceConfiguration([product("A", undefined)]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is required"))).toBe(true);
  });

  it("TEST 13: non-numeric string percentage -> invalid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", "fifty"),
      product("B", 50),
    ]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("not a valid number")),
    ).toBe(true);
  });

  it("TEST 13b: malformed numeric string ('50abc') -> invalid, not silently truncated to 50", () => {
    const result = validateOccurrenceConfiguration([
      product("A", "50abc"),
      product("B", 50),
    ]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("not a valid number")),
    ).toBe(true);
  });

  it("TEST 14: NaN -> invalid", () => {
    const result = validateOccurrenceConfiguration([product("A", NaN)]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("not a valid number")),
    ).toBe(true);
  });

  it("TEST 15: Infinity -> invalid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", Infinity),
      product("B", 0),
    ]);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("not a valid number")),
    ).toBe(true);
  });

  it("TEST 16: duplicate product_id -> invalid", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50),
      product("A", 50),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate product"))).toBe(
      true,
    );
  });

  it("TEST 17: multiple errors in one configuration -> all relevant errors returned", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50),
      product("A", 50), // duplicate
      product("B", -5), // out of range
      product("C", undefined), // missing
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.some((e) => e.includes("Duplicate product"))).toBe(
      true,
    );
    expect(
      result.errors.some((e) => e.includes("between 0 and 100")),
    ).toBe(true);
    expect(result.errors.some((e) => e.includes("is required"))).toBe(true);
  });

  it("TEST 18: Purchase-shaped ProductConfig -> valid when configuration valid", () => {
    // Purchase products always carry full perDayQty/Rate min/max — same
    // shape as the `product()` fixture helper already uses.
    const result = validateOccurrenceConfiguration([
      product("meat-1", 60, { unit_of_measure: "kg" }),
      product("meat-2", 40, { unit_of_measure: "kg" }),
    ]);
    expect(result.valid).toBe(true);
  });

  it("TEST 19: Sales-shaped ProductConfig -> valid when configuration valid", () => {
    // Sales batches build the identical ProductConfig shape (InvoiceEngine
    // reads batch.products into ProductConfig[] for both batch types —
    // there is no separate Sales type) — this test exists to make that
    // symmetry explicit, not because the shape actually differs.
    const result = validateOccurrenceConfiguration([
      product("fish-1", 70),
      product("fish-2", 30),
    ]);
    expect(result.valid).toBe(true);
  });

  it("TEST 20: Sales missing occurrence percentage -> INVALID (closes Root Cause 6 asymmetry)", () => {
    // Before Sprint 1.7C, the Sales UI form (useInvoiceForm.ts:798-803)
    // silently defaulted a missing value to "0" instead of rejecting it,
    // while Purchase blocked submission outright — a real asymmetry
    // documented in the Sprint 1.7 audit. This function makes no
    // batch-type distinction at all, so the same missing-value input that
    // Sales used to silently accept as "0" is rejected here exactly like
    // Purchase's.
    const salesProductMissingOccurrence: any = product("fish-1", 100);
    delete salesProductMissingOccurrence.occurrencePercentage;
    const result = validateOccurrenceConfiguration([
      salesProductMissingOccurrence,
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("is required"))).toBe(true);
  });

  it("TEST 21: empty configuration -> valid (defers to InvoiceEngine's existing 'No products found' guard, does not invent a contradictory rule)", () => {
    const result = validateOccurrenceConfiguration([]);
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe("checkOccurrenceFeasibility", () => {
  it("TEST 1: N=100, 50/30/20 -> feasible, targets match calculateTargetOccurrences exactly", () => {
    const products = [product("A", 50), product("B", 30), product("C", 20)];
    const result = checkOccurrenceFeasibility(products, 100);
    expect(result.feasible).toBe(true);
    expect(result.totalInvoiceCount).toBe(100);
    expect(result.targets.get("A")).toBe(50);
    expect(result.targets.get("B")).toBe(30);
    expect(result.targets.get("C")).toBe(20);
    expect(result.minRequiredInvoices).toBe(50);
    expect(result.totalTargetOccurrences).toBe(100);
    expect(result.reason).toBeUndefined();

    // §1/§8: targets must be exactly what calculateTargetOccurrences
    // itself produces — not a separately reimplemented calculation.
    const directTargets = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      100,
    );
    expect(Object.fromEntries(result.targets)).toEqual(
      Object.fromEntries(directTargets),
    );
  });

  it("TEST 2: N=7, 50/30/20 -> feasible, targets A=4 B=2 C=1", () => {
    const products = [product("A", 50), product("B", 30), product("C", 20)];
    const result = checkOccurrenceFeasibility(products, 7);
    expect(result.feasible).toBe(true);
    expect(result.targets.get("A")).toBe(4);
    expect(result.targets.get("B")).toBe(2);
    expect(result.targets.get("C")).toBe(1);
  });

  it("TEST 4: N=10, one product at 100% -> feasible, target=10", () => {
    const result = checkOccurrenceFeasibility([product("A", 100)], 10);
    expect(result.feasible).toBe(true);
    expect(result.targets.get("A")).toBe(10);
    expect(result.minRequiredInvoices).toBe(10);
  });

  it("TEST 5: N=0, one product at 100% -> feasible, target=0", () => {
    const result = checkOccurrenceFeasibility([product("A", 100)], 0);
    expect(result.feasible).toBe(true);
    expect(result.targets.get("A")).toBe(0);
    expect(result.minRequiredInvoices).toBe(0);
  });

  it("TEST 9: 0% product -> target 0, does not affect feasibility", () => {
    const result = checkOccurrenceFeasibility(
      [product("A", 100), product("B", 0)],
      10,
    );
    expect(result.feasible).toBe(true);
    expect(result.targets.get("B")).toBe(0);
  });

  it("TEST 10: deterministic target output — repeated calls produce identical results", () => {
    const products = [product("A", 33.33), product("B", 33.33), product("C", 33.34)];
    const r1 = checkOccurrenceFeasibility(products, 9);
    const r2 = checkOccurrenceFeasibility(products, 9);
    expect(Object.fromEntries(r1.targets)).toEqual(Object.fromEntries(r2.targets));
    expect(r1.feasible).toBe(r2.feasible);
    expect(r1.minRequiredInvoices).toBe(r2.minRequiredInvoices);
  });

  it("TEST 11: input product order does not affect targets", () => {
    const order1 = [product("A", 50), product("B", 50)];
    const order2 = [product("B", 50), product("A", 50)];
    const r1 = checkOccurrenceFeasibility(order1, 7);
    const r2 = checkOccurrenceFeasibility(order2, 7);
    expect(Object.fromEntries(r1.targets)).toEqual(Object.fromEntries(r2.targets));
  });

  it("TEST 12: invalid configuration (sum != 100%) -> does not silently proceed, reports infeasible with a reason", () => {
    const result = checkOccurrenceFeasibility(
      [product("A", 50), product("B", 30)],
      100,
    );
    expect(result.feasible).toBe(false);
    expect(result.targets.size).toBe(0);
    expect(result.reason).toMatch(/configuration is invalid/);
  });

  it("TEST 13: negative invoice count -> rejected (throws)", () => {
    expect(() => checkOccurrenceFeasibility([product("A", 100)], -1)).toThrow(
      /non-negative integer/,
    );
  });

  it("TEST 14: non-integer invoice count -> rejected (throws)", () => {
    expect(() => checkOccurrenceFeasibility([product("A", 100)], 3.5)).toThrow(
      /non-negative integer/,
    );
  });

  it("TEST 15: empty product configuration -> behavior matches Sprint 1.7C (valid config, but N>0 cannot allocate -> reported infeasible, not thrown)", () => {
    const resultWithInvoices = checkOccurrenceFeasibility([], 5);
    expect(resultWithInvoices.feasible).toBe(false);
    expect(resultWithInvoices.reason).toBeTruthy();

    const resultZero = checkOccurrenceFeasibility([], 0);
    expect(resultZero.feasible).toBe(true);
    expect(resultZero.targets.size).toBe(0);
  });

  it("TEST 16: minRequiredInvoices equals max target occurrence", () => {
    const result = checkOccurrenceFeasibility(
      [product("A", 70), product("B", 30)],
      20,
    );
    const maxTarget = Math.max(...Array.from(result.targets.values()));
    expect(result.minRequiredInvoices).toBe(maxTarget);
  });

  it("TEST 17/18: exact boundary N===maxTarget is feasible (self-consistent targets can never exceed N — see mathematical note below)", () => {
    // As documented on checkOccurrenceFeasibility itself: because
    // calculateTargetOccurrences guarantees targets sum to EXACTLY N, and
    // validateOccurrenceConfiguration requires percentages to sum to
    // exactly 100%, max(target) <= N is a mathematical invariant that
    // ALWAYS holds when both are derived from the same N — there is no
    // valid (products, N) pair reachable through this function's real
    // signature where N < maxTarget. TEST 17 (N === maxTarget) is
    // reproduced directly below; TEST 18 (one below the boundary) is
    // proven instead against evaluateFeasibilityFromTargets — the
    // reusable comparison core — with a hand-constructed target map, since
    // that is the only way to exercise "target > N" at all. See this
    // sprint's report for the full mathematical justification.
    const result = checkOccurrenceFeasibility([product("A", 100)], 10);
    expect(result.minRequiredInvoices).toBe(10);
    expect(result.totalInvoiceCount).toBe(10);
    expect(result.feasible).toBe(true); // N === maxTarget (10 === 10)

    const oneBelowBoundary = evaluateFeasibilityFromTargets(
      new Map([["A", 10]]),
      9,
    );
    expect(oneBelowBoundary.feasible).toBe(false);
    expect(oneBelowBoundary.minRequiredInvoices).toBe(10);
  });
});

describe("checkOccurrenceFeasibility / evaluateFeasibilityFromTargets — product-overlap semantics (critically important, §3/§10)", () => {
  it("TEST 6/7: a target that exceeds N is infeasible (tested via evaluateFeasibilityFromTargets, since a real config can never self-consistently produce one)", () => {
    // Section 4's example ("Target A=80, B=40, N=70 -> infeasible") and
    // TEST 7 ("N=5, target=6 -> infeasible") describe target counts that
    // are NOT self-consistently derived from the same N being checked —
    // under this codebase's actual model (Sprint 1.7B's Largest Remainder
    // apportionment always makes targets sum to exactly N; Sprint 1.7C
    // requires percentages to sum to exactly 100%), calling
    // checkOccurrenceFeasibility(products, N) can never produce a target
    // greater than N for that same N — see the doc comment on
    // checkOccurrenceFeasibility for the full pigeonhole proof. These
    // scenarios are tested directly against the underlying comparison
    // logic instead, which IS where the actual "target > N -> infeasible"
    // rule lives and is enforced.
    const result = evaluateFeasibilityFromTargets(new Map([["A", 6]]), 5);
    expect(result.feasible).toBe(false);
    expect(result.minRequiredInvoices).toBe(6);
    expect(result.reason).toMatch(/at least 6 invoice/);
  });

  it("TEST 3: N=10, targets A=8 B=7 C=2 (sum=17 > N) -> still FEASIBLE, because multiple products can share one invoice", () => {
    const result = evaluateFeasibilityFromTargets(
      new Map([
        ["A", 8],
        ["B", 7],
        ["C", 2],
      ]),
      10,
    );
    expect(result.feasible).toBe(true);
    expect(result.totalTargetOccurrences).toBe(17);
    expect(result.minRequiredInvoices).toBe(8);
  });

  it("TEST 8: multiple products whose target sum > N -> still feasible (does NOT use sum(targets) <= N as the rule)", () => {
    const result = evaluateFeasibilityFromTargets(
      new Map([
        ["A", 90],
        ["B", 85],
        ["C", 80],
      ]),
      100,
    );
    expect(result.totalTargetOccurrences).toBe(255); // 2.55x the invoice count
    expect(result.feasible).toBe(true); // max(90,85,80) = 90 <= 100
  });

  it("confirms the feasibility rule is max(target) <= N, not sum(target) <= N, using a case where sum > N but max > N too (both must independently be checked correctly)", () => {
    const overlapButInfeasible = evaluateFeasibilityFromTargets(
      new Map([
        ["A", 12], // exceeds N=10 -> infeasible regardless of overlap
        ["B", 3],
      ]),
      10,
    );
    expect(overlapButInfeasible.feasible).toBe(false);
    expect(overlapButInfeasible.minRequiredInvoices).toBe(12);
  });
});

describe("Sprint 1.7C -> 1.7D cross-function composition", () => {
  it("validateOccurrenceConfiguration -> calculateTargetOccurrences -> checkOccurrenceFeasibility compose correctly for 50/30/20 @ N=100", () => {
    const products = [product("A", 50), product("B", 30), product("C", 20)];

    const configResult = validateOccurrenceConfiguration(products);
    expect(configResult.valid).toBe(true);

    const targets = calculateTargetOccurrences(
      [
        { productId: "A", occurrencePercentage: 50 },
        { productId: "B", occurrencePercentage: 30 },
        { productId: "C", occurrencePercentage: 20 },
      ],
      100,
    );
    expect(targets.get("A")).toBe(50);
    expect(targets.get("B")).toBe(30);
    expect(targets.get("C")).toBe(20);

    const feasibility = checkOccurrenceFeasibility(products, 100);
    expect(feasibility.feasible).toBe(true);
    expect(Object.fromEntries(feasibility.targets)).toEqual(
      Object.fromEntries(targets),
    );
    expect(feasibility.minRequiredInvoices).toBe(50);
  });
});

describe("validateCategoryOccurrenceConfiguration — CATEGORY semantics (Sprint 1.7J)", () => {
  it("TEST 1: Meat 60 / Fruits 40, both categories populated correctly -> valid", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("TEST 2: Meat 100 / Fruits 0 with only Meat products -> valid", () => {
    const products = [catProduct("Chicken", 70, "Meat"), catProduct("Mutton", 30, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 2b: {Meat: 100} with Fruits key omitted entirely -> normalized to Fruits=0, still valid", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 3: Meat 0 / Fruits 100 with only Fruits products -> valid", () => {
    const products = [catProduct("Apple", 80, "Fruits"), catProduct("Banana", 20, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 0, Fruits: 100 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 4 / 23: both categories selected, one allocated 0% -> invalid (RULE A)", () => {
    const products = [catProduct("Chicken", 70, "Meat"), catProduct("Apple", 30, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith("Fruits:") && e.includes("allocated 0%")),
    ).toBe(true);
  });

  it("TEST 5 / 25: category allocated >0% but no products in that category -> invalid (RULE B)", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 70, Fruits: 30 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.startsWith("Fruits:") && e.includes("no selected products"),
      ),
    ).toBe(true);
  });

  it("TEST 6: Meat 70/30 + Fruits 80/20 -> valid", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 7: Meat 70/20 (sums to 90) -> invalid", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 20, "Meat"),
      catProduct("Apple", 100, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("Meat:"))).toBe(true);
  });

  it("TEST 8: Fruits 80/10 (sums to 90) -> invalid", () => {
    const products = [
      catProduct("Chicken", 100, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 10, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("Fruits:"))).toBe(true);
  });

  it("TEST 9: global sum = 200% but each category independently sums to 100% -> VALID under CATEGORY", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    // 70+30+80+20 = 200% globally — must NOT be rejected as a "global 100%" violation.
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 10: global sum = 100% but one category is internally invalid -> INVALID", () => {
    // Chicken 60 + Apple 40 = 100% globally, but Meat alone (just Chicken)
    // must independently sum to 100% and doesn't.
    const products = [catProduct("Chicken", 60, "Meat"), catProduct("Apple", 40, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 50, Fruits: 50 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
  });

  it("TEST 11: 99.99 / 0.01 -> valid (within tolerance)", () => {
    const products = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 99.99, Fruits: 0.01 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 12: 100 / 0 -> valid", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 13: 0 / 100 -> valid", () => {
    const products = [catProduct("Apple", 100, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 0, Fruits: 100 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 14: negative category allocation -> invalid", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 110, Fruits: -10 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith("Category allocation:")),
    ).toBe(true);
  });

  it("TEST 15: category allocation >100 -> invalid", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 150, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
  });

  it("TEST 16: sum below 100 beyond tolerance -> invalid", () => {
    const products = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 49, Fruits: 49 }, // sums to 98
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("must total 100%")),
    ).toBe(true);
  });

  it("TEST 17: sum above 100 beyond tolerance -> invalid", () => {
    const products = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 51, Fruits: 51 }, // sums to 102
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
  });
});

describe("validateCategoryOccurrenceConfiguration — GLOBAL / NULL semantics (Sprint 1.7J)", () => {
  it("TEST 18: GLOBAL semantics + products summing to 100% globally -> valid", () => {
    const products = [
      catProduct("Chicken", 60, "Meat"),
      catProduct("Apple", 40, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      null,
      "GLOBAL",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 19: GLOBAL semantics + category_allocation present -> global validation still applies, category_allocation ignored", () => {
    const products = [
      catProduct("Chicken", 60, "Meat"),
      catProduct("Apple", 40, "Fruits"),
    ];
    // If category_allocation mattered here, this would fail (Meat 30 +
    // Fruits 30 != 100) — but under GLOBAL semantics it's ignored entirely
    // and only the global 60+40=100% sum is checked.
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 30, Fruits: 30 },
      "GLOBAL",
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 20: NULL semantics + old-style global products -> valid (matches existing validateOccurrenceConfiguration exactly)", () => {
    const products = [
      catProduct("Chicken", 60, "Meat"),
      catProduct("Apple", 40, "Fruits"),
    ];
    const categoryResult = validateCategoryOccurrenceConfiguration(
      products,
      null,
      null,
    );
    const directResult = validateOccurrenceConfiguration(products);
    expect(categoryResult).toEqual(directResult);
  });

  it("TEST 21: NULL semantics does NOT require category_allocation", () => {
    const products = [product("A", 100)];
    // No throw, no "category_allocation required" error — undefined is
    // simply never inspected under NULL/legacy semantics.
    const result = validateCategoryOccurrenceConfiguration(
      products,
      undefined,
      undefined,
    );
    expect(result.valid).toBe(true);
  });

  it("TEST 22: CATEGORY semantics + missing category_allocation -> invalid", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      null,
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("requires category_allocation")),
    ).toBe(true);
  });
});

describe("validateCategoryOccurrenceConfiguration — contradiction rules (Sprint 1.7J)", () => {
  it("TEST 24: selected Fruits product + Fruits allocation 0 -> invalid", () => {
    const products = [catProduct("Chicken", 70, "Meat"), catProduct("Apple", 30, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("Fruits:"))).toBe(true);
  });

  it("TEST 26: no Meat products + Meat allocation >0 -> invalid", () => {
    const products = [catProduct("Apple", 100, "Fruits")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 20, Fruits: 80 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.startsWith("Meat:") && e.includes("no selected products"),
      ),
    ).toBe(true);
  });
});

describe("validateCategoryOccurrenceConfiguration — immutability (Sprint 1.7J)", () => {
  it("TEST 27: does not mutate the products array or its objects", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
    ];
    const snapshot = JSON.parse(JSON.stringify(products));
    validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(products).toEqual(snapshot);
  });

  it("TEST 28: does not mutate the categoryAllocation object", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const allocation = { Meat: 100, Fruits: 0 };
    const snapshot = { ...allocation };
    validateCategoryOccurrenceConfiguration(products, allocation, "CATEGORY");
    expect(allocation).toEqual(snapshot);
  });
});

describe("validateCategoryOccurrenceConfiguration — error quality (Sprint 1.7J)", () => {
  it("TEST 29: invalid category allocation identifies it's the category allocation (not a product) at fault", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: -10, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith("Category allocation:")),
    ).toBe(true);
  });

  it("TEST 30: invalid product occurrence identifies the category context", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 10, "Meat"), // Meat sums to 80, not 100
      catProduct("Apple", 100, "Fruits"),
    ];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 50, Fruits: 50 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith("Meat:") && e.includes("100%")),
    ).toBe(true);
  });

  it("TEST 31: contradiction error identifies the exact category and reason", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = validateCategoryOccurrenceConfiguration(
      products,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    const fruitsError = result.errors.find((e) => e.startsWith("Fruits:"));
    expect(fruitsError).toBeDefined();
    expect(fruitsError).toMatch(/40%/);
    expect(fruitsError).toMatch(/no selected products/);
  });
});

describe("validateOccurrenceConfiguration — regression (Sprint 1.7J: still called directly, unchanged)", () => {
  it("50/30/20 -> valid (unchanged from Sprint 1.7C)", () => {
    const result = validateOccurrenceConfiguration([
      product("A", 50),
      product("B", 30),
      product("C", 20),
    ]);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("empty configuration -> valid (unchanged from Sprint 1.7C)", () => {
    expect(validateOccurrenceConfiguration([])).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("missing occurrence percentage -> invalid (unchanged from Sprint 1.7C)", () => {
    const p: any = product("A", 100);
    delete p.occurrencePercentage;
    const result = validateOccurrenceConfiguration([p]);
    expect(result.valid).toBe(false);
  });
});
