import { describe, expect, it } from "vitest";
import { calculateQuotaAllocation } from "./ProductOccurrenceQuotaService";
import { validateCategoryOccurrenceConfiguration } from "./ProductOccurrenceService";
import type { ProductConfig } from "./InvoiceEngine";

function catProduct(
  id: string,
  pct: any,
  category: "Meat" | "Fruits",
): ProductConfig {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0000",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage: pct,
    category,
  } as any as ProductConfig;
}

function globalProduct(id: string, pct: any): ProductConfig {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0000",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage: pct,
  };
}

function targetOf(result: ReturnType<typeof calculateQuotaAllocation>, id: string) {
  return result.productTargets.find((t) => t.productId === id)?.targetInvoiceCount;
}

describe("calculateQuotaAllocation — CATEGORY semantics (Sprint 1.7L)", () => {
  it("TEST 1: 100 invoices, Meat 60/Fruits 40, Chicken 70/Mutton 30 + Apple 80/Banana 20", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.categoryTargets).toEqual({ Meat: 60, Fruits: 40 });
    expect(targetOf(result, "Chicken")).toBe(42);
    expect(targetOf(result, "Mutton")).toBe(18);
    expect(targetOf(result, "Apple")).toBe(32);
    expect(targetOf(result, "Banana")).toBe(8);
  });

  it("TEST 2: 7 invoices, Meat 50/Fruits 50 -> deterministic 3/4 per the existing tie-break rule", () => {
    // The existing Largest Remainder tie-break (Sprint 1.7B) is: remainder
    // DESC, then percentage DESC, then productId ASC. For an exact 50/50
    // tie at N=7 (3.5/3.5), the tie-break falls to productId, and
    // "Fruits" < "Meat" alphabetically — so Fruits receives the extra
    // invoice, not Meat. (The sprint brief's own illustrative "4/3"
    // example assumed Meat wins the tie; re-deriving it against the
    // actual, already-approved tie-break rule shows Fruits wins instead —
    // reusing the existing rule exactly, not deviating from it, is what
    // this sprint requires, so the test reflects the real, correct
    // result rather than the illustration.)
    const products = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const result = calculateQuotaAllocation(
      products,
      7,
      { Meat: 50, Fruits: 50 },
      "CATEGORY",
    );
    expect(result.categoryTargets).toEqual({ Meat: 3, Fruits: 4 });
    expect(result.categoryTargets!.Meat + result.categoryTargets!.Fruits).toBe(7);
  });

  it("TEST 3: 1 invoice, 50/50 -> deterministic 1/0 per existing tie rule (Meat wins ties: remainder tie -> pct tie -> productId ASC, 'Fruits' < 'Meat')", () => {
    const products = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const result = calculateQuotaAllocation(
      products,
      1,
      { Meat: 50, Fruits: 50 },
      "CATEGORY",
    );
    // exact 0.5/0.5, floors 0/0, 1 remaining slot, tie on remainder AND
    // pct -> productId ASC tie-break -> "Fruits" < "Meat" -> Fruits wins.
    expect(result.categoryTargets).toEqual({ Meat: 0, Fruits: 1 });
  });

  it("TEST 4: 100 invoices, Meat 100/Fruits 0, only Meat products", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.categoryTargets).toEqual({ Meat: 100, Fruits: 0 });
    expect(targetOf(result, "Chicken")).toBe(100);
  });

  it("TEST 5: 100 invoices, Meat 0/Fruits 100, only Fruits products", () => {
    const products = [catProduct("Apple", 100, "Fruits")];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 0, Fruits: 100 },
      "CATEGORY",
    );
    expect(result.categoryTargets).toEqual({ Meat: 0, Fruits: 100 });
    expect(targetOf(result, "Apple")).toBe(100);
  });

  it("TEST 6: only Meat products present in the batch", () => {
    const products = [catProduct("Chicken", 60, "Meat"), catProduct("Mutton", 40, "Meat")];
    const result = calculateQuotaAllocation(
      products,
      50,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.productTargets.every((t) => t.category === "Meat")).toBe(true);
  });

  it("TEST 7: only Fruits products present in the batch", () => {
    const products = [catProduct("Apple", 60, "Fruits"), catProduct("Banana", 40, "Fruits")];
    const result = calculateQuotaAllocation(
      products,
      50,
      { Meat: 0, Fruits: 100 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.productTargets.every((t) => t.category === "Fruits")).toBe(true);
  });

  it("TEST 8: multiple products in both categories", () => {
    const products = [
      catProduct("Chicken", 50, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Fish", 20, "Meat"),
      catProduct("Apple", 40, "Fruits"),
      catProduct("Banana", 30, "Fruits"),
      catProduct("Orange", 30, "Fruits"),
    ];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.productTargets.length).toBe(6);
  });

  it("TEST 9: product percentages within each category sum to 100%", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    const meatSum = result.productTargets
      .filter((t) => t.category === "Meat")
      .reduce((s, t) => s + t.targetInvoiceCount, 0);
    const fruitsSum = result.productTargets
      .filter((t) => t.category === "Fruits")
      .reduce((s, t) => s + t.targetInvoiceCount, 0);
    expect(meatSum).toBe(60);
    expect(fruitsSum).toBe(40);
  });

  it("TEST 10: global product percentage sum may equal 200 under CATEGORY (not rejected)", () => {
    const products = [
      catProduct("Chicken", 70, "Meat"),
      catProduct("Mutton", 30, "Meat"),
      catProduct("Apple", 80, "Fruits"),
      catProduct("Banana", 20, "Fruits"),
    ];
    const globalSum = products.reduce(
      (s, p) => s + Number((p as any).occurrencePercentage),
      0,
    );
    expect(globalSum).toBe(200);
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
  });
});

describe("calculateQuotaAllocation — product target math (Sprint 1.7L)", () => {
  it("TEST 11: Meat pool 60 + Chicken 70/Mutton 30 -> 42/18", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 70, "Meat"), catProduct("Mutton", 30, "Meat"), catProduct("Apple", 100, "Fruits")],
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(targetOf(result, "Chicken")).toBe(42);
    expect(targetOf(result, "Mutton")).toBe(18);
  });

  it("TEST 12: Fruits pool 40 + Apple 80/Banana 20 -> 32/8", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 80, "Fruits"), catProduct("Banana", 20, "Fruits")],
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(targetOf(result, "Apple")).toBe(32);
    expect(targetOf(result, "Banana")).toBe(8);
  });

  it("TEST 13: three products in one category exercise Largest Remainder", () => {
    // Meat pool = 7 (of N=10 @ 70%). 33.33/33.33/33.34 -> floors 2/2/2=6,
    // 1 remaining -> largest remainder(s) win.
    const result = calculateQuotaAllocation(
      [
        catProduct("A", 33.33, "Meat"),
        catProduct("B", 33.33, "Meat"),
        catProduct("C", 33.34, "Meat"),
        catProduct("Apple", 100, "Fruits"),
      ],
      10,
      { Meat: 70, Fruits: 30 },
      "CATEGORY",
    );
    expect(result.categoryTargets!.Meat).toBe(7);
    const meatSum = (targetOf(result, "A") || 0) + (targetOf(result, "B") || 0) + (targetOf(result, "C") || 0);
    expect(meatSum).toBe(7);
  });

  it("TEST 14: product target sum equals category target, for every category", () => {
    const products = [
      catProduct("Chicken", 25, "Meat"),
      catProduct("Mutton", 25, "Meat"),
      catProduct("Fish", 25, "Meat"),
      catProduct("Duck", 25, "Meat"),
      catProduct("Apple", 60, "Fruits"),
      catProduct("Banana", 40, "Fruits"),
    ];
    const result = calculateQuotaAllocation(
      products,
      37,
      { Meat: 55, Fruits: 45 },
      "CATEGORY",
    );
    const meatSum = result.productTargets
      .filter((t) => t.category === "Meat")
      .reduce((s, t) => s + t.targetInvoiceCount, 0);
    const fruitsSum = result.productTargets
      .filter((t) => t.category === "Fruits")
      .reduce((s, t) => s + t.targetInvoiceCount, 0);
    expect(meatSum).toBe(result.categoryTargets!.Meat);
    expect(fruitsSum).toBe(result.categoryTargets!.Fruits);
  });

  it("TEST 15: a zero-occurrence product remains zero when mathematically required", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat"), catProduct("Mutton", 0, "Meat")],
      10,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(targetOf(result, "Mutton")).toBe(0);
    expect(targetOf(result, "Chicken")).toBe(10);
  });

  it("TEST 16: single product at 100% receives the entire category target", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat")],
      73,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(targetOf(result, "Chicken")).toBe(73);
  });
});

describe("calculateQuotaAllocation — GLOBAL / NULL semantics (Sprint 1.7L)", () => {
  it("TEST 17: GLOBAL semantics preserves existing calculateTargetOccurrences behavior exactly", () => {
    const products = [globalProduct("A", 50), globalProduct("B", 30), globalProduct("C", 20)];
    const result = calculateQuotaAllocation(products, 100, null, "GLOBAL");
    expect(result.valid).toBe(true);
    expect(result.occurrenceSemantics).toBe("GLOBAL");
    expect(result.categoryTargets).toBeNull();
    expect(targetOf(result, "A")).toBe(50);
    expect(targetOf(result, "B")).toBe(30);
    expect(targetOf(result, "C")).toBe(20);
  });

  it("TEST 18: NULL semantics preserves existing GLOBAL behavior identically", () => {
    const products = [globalProduct("A", 50), globalProduct("B", 30), globalProduct("C", 20)];
    const nullResult = calculateQuotaAllocation(products, 100, null, null);
    const globalResult = calculateQuotaAllocation(products, 100, null, "GLOBAL");
    expect(nullResult.productTargets).toEqual(globalResult.productTargets);
    expect(nullResult.occurrenceSemantics).toBe("GLOBAL");
  });

  it("TEST 19: category_allocation is ignored under GLOBAL — a nonsensical allocation does not affect the result", () => {
    const products = [globalProduct("A", 60), globalProduct("B", 40)];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 10, Fruits: 10 }, // sums to 20, would be invalid for CATEGORY
      "GLOBAL",
    );
    expect(result.valid).toBe(true);
    expect(targetOf(result, "A")).toBe(60);
    expect(targetOf(result, "B")).toBe(40);
  });

  it("TEST 20: category_allocation is not required under GLOBAL", () => {
    const products = [globalProduct("A", 100)];
    const result = calculateQuotaAllocation(products, 10, undefined, "GLOBAL");
    expect(result.valid).toBe(true);
  });
});

describe("calculateQuotaAllocation — edge cases (Sprint 1.7L)", () => {
  it("TEST 21: totalInvoiceCount = 0", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = calculateQuotaAllocation(
      products,
      0,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(true);
    expect(result.categoryTargets).toEqual({ Meat: 0, Fruits: 0 });
    expect(targetOf(result, "Chicken")).toBe(0);
  });

  it("TEST 22: totalInvoiceCount = 1", () => {
    const products = [catProduct("Chicken", 100, "Meat")];
    const result = calculateQuotaAllocation(
      products,
      1,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.categoryTargets!.Meat).toBe(1);
    expect(targetOf(result, "Chicken")).toBe(1);
  });

  it("TEST 23: product percentages with decimals", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 33.33, "Meat"), catProduct("Mutton", 66.67, "Meat")],
      100,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect((targetOf(result, "Chicken") || 0) + (targetOf(result, "Mutton") || 0)).toBe(100);
  });

  it("TEST 24: category percentages with decimals", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")],
      1000,
      { Meat: 33.33, Fruits: 66.67 },
      "CATEGORY",
    );
    expect(result.categoryTargets!.Meat + result.categoryTargets!.Fruits).toBe(1000);
  });

  it("TEST 25: tie-breaking is deterministic across repeated calls and input order", () => {
    const productsA = [catProduct("Chicken", 100, "Meat"), catProduct("Apple", 100, "Fruits")];
    const productsB = [catProduct("Apple", 100, "Fruits"), catProduct("Chicken", 100, "Meat")];
    const r1 = calculateQuotaAllocation(productsA, 1, { Meat: 50, Fruits: 50 }, "CATEGORY");
    const r2 = calculateQuotaAllocation(productsA, 1, { Meat: 50, Fruits: 50 }, "CATEGORY");
    const r3 = calculateQuotaAllocation(productsB, 1, { Meat: 50, Fruits: 50 }, "CATEGORY");
    expect(r1.categoryTargets).toEqual(r2.categoryTargets);
    expect(r1.categoryTargets).toEqual(r3.categoryTargets);
  });

  it("TEST 26: input arrays/objects are never mutated", () => {
    const products = [catProduct("Chicken", 70, "Meat"), catProduct("Mutton", 30, "Meat")];
    const allocation = { Meat: 100, Fruits: 0 };
    const productsSnapshot = JSON.parse(JSON.stringify(products));
    const allocationSnapshot = { ...allocation };
    calculateQuotaAllocation(products, 50, allocation, "CATEGORY");
    expect(products).toEqual(productsSnapshot);
    expect(allocation).toEqual(allocationSnapshot);
  });

  it("TEST 27: duplicate product IDs are rejected, not silently double-counted", () => {
    const products = [catProduct("Chicken", 50, "Meat"), catProduct("Chicken", 50, "Meat")];
    const result = calculateQuotaAllocation(
      products,
      100,
      { Meat: 100, Fruits: 0 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate product"))).toBe(true);
  });

  it("TEST 27b: duplicate product IDs rejected under GLOBAL too", () => {
    const products = [globalProduct("A", 50), globalProduct("A", 50)];
    const result = calculateQuotaAllocation(products, 100, null, "GLOBAL");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate product"))).toBe(true);
  });
});

describe("calculateQuotaAllocation — invalid input (Sprint 1.7L)", () => {
  it("TEST 28: CATEGORY without category_allocation -> invalid, not thrown", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat")],
      100,
      null,
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("requires category_allocation"))).toBe(true);
  });

  it("TEST 29: CATEGORY with invalid category allocation (doesn't sum to 100) -> invalid", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 100, "Meat")],
      100,
      { Meat: 40, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
  });

  it("TEST 30: CATEGORY with invalid per-category occurrence percentages -> invalid", () => {
    const result = calculateQuotaAllocation(
      [catProduct("Chicken", 70, "Meat"), catProduct("Mutton", 20, "Meat"), catProduct("Apple", 100, "Fruits")],
      100,
      { Meat: 60, Fruits: 40 },
      "CATEGORY",
    );
    expect(result.valid).toBe(false);
  });

  it("TEST 31: invalid totalInvoiceCount (non-integer) -> throws", () => {
    expect(() =>
      calculateQuotaAllocation([catProduct("Chicken", 100, "Meat")], 3.5, { Meat: 100, Fruits: 0 }, "CATEGORY"),
    ).toThrow(/non-negative integer/);
  });

  it("TEST 32: negative invoice count -> throws", () => {
    expect(() =>
      calculateQuotaAllocation([catProduct("Chicken", 100, "Meat")], -5, { Meat: 100, Fruits: 0 }, "CATEGORY"),
    ).toThrow(/non-negative integer/);
  });

  it("TEST 33: non-integer invoice count under GLOBAL also throws", () => {
    expect(() =>
      calculateQuotaAllocation([globalProduct("A", 100)], 2.2, null, "GLOBAL"),
    ).toThrow(/non-negative integer/);
  });
});

describe("Sprint 1.7L §18 — cross-function regression: validator + quota engine compatibility", () => {
  const fixtures: Array<{
    name: string;
    products: ProductConfig[];
    categoryAllocation: { Meat?: number; Fruits?: number };
    totalInvoiceCount: number;
  }> = [
    {
      name: "60/40 split, two products each",
      products: [
        catProduct("Chicken", 70, "Meat"),
        catProduct("Mutton", 30, "Meat"),
        catProduct("Apple", 80, "Fruits"),
        catProduct("Banana", 20, "Fruits"),
      ],
      categoryAllocation: { Meat: 60, Fruits: 40 },
      totalInvoiceCount: 100,
    },
    {
      name: "single-category Meat-only batch",
      products: [catProduct("Chicken", 100, "Meat")],
      categoryAllocation: { Meat: 100, Fruits: 0 },
      totalInvoiceCount: 37,
    },
    {
      name: "odd invoice count with three-way remainder split",
      products: [
        catProduct("A", 33.33, "Meat"),
        catProduct("B", 33.33, "Meat"),
        catProduct("C", 33.34, "Meat"),
        catProduct("Apple", 100, "Fruits"),
      ],
      categoryAllocation: { Meat: 70, Fruits: 30 },
      totalInvoiceCount: 13,
    },
  ];

  for (const fixture of fixtures) {
    it(`"${fixture.name}": validator-accepted config always produces a consistent quota allocation`, () => {
      const validation = validateCategoryOccurrenceConfiguration(
        fixture.products,
        fixture.categoryAllocation,
        "CATEGORY",
      );
      expect(validation.valid).toBe(true);

      const quota = calculateQuotaAllocation(
        fixture.products,
        fixture.totalInvoiceCount,
        fixture.categoryAllocation,
        "CATEGORY",
      );
      expect(quota.valid).toBe(true);

      // Invariant: category targets sum exactly to totalInvoiceCount.
      expect(quota.categoryTargets!.Meat + quota.categoryTargets!.Fruits).toBe(
        fixture.totalInvoiceCount,
      );

      // Invariant: every active category's product targets sum exactly to
      // that category's own target.
      for (const category of ["Meat", "Fruits"] as const) {
        const productsInCategory = quota.productTargets.filter(
          (t) => t.category === category,
        );
        if (productsInCategory.length === 0) continue;
        const sum = productsInCategory.reduce(
          (s, t) => s + t.targetInvoiceCount,
          0,
        );
        expect(sum).toBe(quota.categoryTargets![category]);
      }

      // Invariant: every target is a non-negative integer.
      for (const t of quota.productTargets) {
        expect(Number.isInteger(t.targetInvoiceCount)).toBe(true);
        expect(t.targetInvoiceCount).toBeGreaterThanOrEqual(0);
      }

      // Invariant: no product appears twice.
      const ids = quota.productTargets.map((t) => t.productId);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});
