import { describe, expect, it } from "vitest";
import {
  STOCK_SAFETY_MARGIN,
  allocateStock,
  summarizeKnockoff,
} from "./StockAllocationEngine";
import {
  DebtorCreditorPerson,
  DebtorCreditorSourceData,
  PersonAmountEntry,
  ResolvedSplitUpProduct,
} from "./types";

function makeProduct(
  overrides: Partial<ResolvedSplitUpProduct>,
): ResolvedSplitUpProduct {
  return {
    hsnCode: "0000",
    description: "PRODUCT",
    uqc: "KGS",
    totalQuantity: 10000,
    taxableValue: 1000000,
    category: "Meat",
    categorySource: "hsn-match",
    ...overrides,
  };
}

function makeSource(
  products: ResolvedSplitUpProduct[],
  monthAmounts: number[][], // [productIdx][monthIdx] amount; qty = amount/10 (rate 10/unit)
): DebtorCreditorSourceData {
  const months = Array.from({ length: monthAmounts[0].length }, (_, i) => ({
    label: `M${i + 1}`,
    monthIndex: i,
    purchaseTotal: 0,
    salesTotal: 0,
  }));
  const matrix = products.map((_, pIdx) =>
    monthAmounts[pIdx].map((amount) => ({ qty: amount / 10, amount })),
  );
  return {
    financialYear: "2024-25",
    products,
    months,
    purchaseMatrix: matrix,
    salesMatrix: matrix,
  };
}

const PEOPLE: DebtorCreditorPerson[] = [
  { id: "p1", companyName: "Sugumar", category: "Meat" },
  { id: "p2", companyName: "Raja", category: "Meat" },
];

describe("allocateStock", () => {
  it("every person's allocated total equals their configured amount when stock is ample", () => {
    const products = [
      makeProduct({ hsnCode: "1001", description: "SEER" }),
      makeProduct({ hsnCode: "1002", description: "SANKARA" }),
    ];
    const source = makeSource(products, [
      [50000, 50000, 50000],
      [50000, 50000, 50000],
    ]);
    const personAmounts: PersonAmountEntry[] = [
      { personId: "p1", locked: false, amount: 20000 },
      { personId: "p2", locked: false, amount: 15000 },
    ];

    const result = allocateStock({
      role: "debtor",
      source,
      people: PEOPLE,
      selectedMonthIndices: [0, 1, 2],
      personAmounts,
    });

    expect(result.ok).toBe(true);
    const totalByPerson = new Map<string, number>();
    for (const line of result.lines) {
      totalByPerson.set(line.personId, (totalByPerson.get(line.personId) ?? 0) + line.amount);
    }
    expect(totalByPerson.get("p1")).toBeCloseTo(20000, 0);
    expect(totalByPerson.get("p2")).toBeCloseTo(15000, 0);
  });

  it("never lets a product-month's cumulative allocation reach the uploaded figure — always strictly less, by the safety margin", () => {
    const products = [makeProduct({ hsnCode: "1001", description: "SEER" })];
    const source = makeSource(products, [[10000, 10000]]);
    const personAmounts: PersonAmountEntry[] = [
      // Both people select only MONTH 0 (not split across months), so
      // their full amounts land in the same single month and genuinely
      // compete for the same product's cap.
      { personId: "p1", locked: false, amount: 9000 },
      { personId: "p2", locked: false, amount: 9000 },
    ];

    const result = allocateStock({
      role: "debtor",
      source,
      people: PEOPLE,
      selectedMonthIndices: [0],
      personAmounts,
    });

    // Total demand (18000) exceeds the single month's capacity (~9800) —
    // this should genuinely shortfall.
    expect(result.ok).toBe(false);

    const singlePersonResult = allocateStock({
      role: "debtor",
      source,
      people: [PEOPLE[0]],
      selectedMonthIndices: [0],
      personAmounts: [{ personId: "p1", locked: false, amount: 9000 }],
    });
    expect(singlePersonResult.ok).toBe(true);
    const allocated = singlePersonResult.lines
      .filter((l) => l.monthIndex === 0)
      .reduce((s, l) => s + l.amount, 0);
    const cap = Math.floor(10000 * (1 - STOCK_SAFETY_MARGIN));
    expect(allocated).toBeLessThan(10000);
    expect(allocated).toBeLessThanOrEqual(cap);
  });

  it("spreads a person across multiple products when a single one can't cover a month alone", () => {
    const products = [
      makeProduct({ hsnCode: "1001", description: "SEER" }),
      makeProduct({ hsnCode: "1002", description: "SANKARA" }),
    ];
    // Each product only has 3000 available in month 0 — a 5000 requirement
    // can't be met by either alone, forcing a split across both.
    const source = makeSource(products, [
      [3000, 10000],
      [3000, 10000],
    ]);
    const personAmounts: PersonAmountEntry[] = [
      { personId: "p1", locked: false, amount: 5000 },
    ];

    const result = allocateStock({
      role: "debtor",
      source,
      people: [PEOPLE[0]],
      selectedMonthIndices: [0],
      personAmounts,
    });

    expect(result.ok).toBe(true);
    const month0Lines = result.lines.filter((l) => l.monthIndex === 0);
    const distinctProducts = new Set(month0Lines.map((l) => l.productIndex));
    expect(distinctProducts.size).toBeGreaterThan(1);
    expect(month0Lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(5000, 0);
  });

  it("creditor role never allocates a person a product they already used as debtor, while it stays available to other people", () => {
    const products = [
      makeProduct({ hsnCode: "1001", description: "SEER" }),
      makeProduct({ hsnCode: "1002", description: "SANKARA" }),
    ];
    const source = makeSource(products, [
      [50000, 50000],
      [50000, 50000],
    ]);

    const excludedHsnByPerson = { p1: new Set(["1001"]) };

    const result = allocateStock({
      role: "creditor",
      source,
      people: PEOPLE,
      selectedMonthIndices: [0, 1],
      personAmounts: [
        { personId: "p1", locked: false, amount: 20000 },
        { personId: "p2", locked: false, amount: 20000 },
      ],
      excludedHsnByPerson,
    });

    expect(result.ok).toBe(true);
    const p1Hsns = new Set(result.lines.filter((l) => l.personId === "p1").map((l) => l.hsnCode));
    expect(p1Hsns.has("1001")).toBe(false);
    // p2 (not excluded) should still be free to use 1001.
    const p2Hsns = new Set(result.lines.filter((l) => l.personId === "p2").map((l) => l.hsnCode));
    expect(p2Hsns.has("1001")).toBe(true);
  });

  it("returns ok:false with itemized shortfalls (and no lines) when stock genuinely can't cover the requirement", () => {
    const products = [makeProduct({ hsnCode: "1001", description: "SEER" })];
    const source = makeSource(products, [[1000]]);
    const personAmounts: PersonAmountEntry[] = [
      { personId: "p1", locked: false, amount: 50000 },
    ];

    const result = allocateStock({
      role: "debtor",
      source,
      people: [PEOPLE[0]],
      selectedMonthIndices: [0],
      personAmounts,
    });

    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.shortfalls.length).toBeGreaterThan(0);
    expect(result.shortfalls[0].personId).toBe("p1");
  });

  it("is deterministic — same inputs produce identical lines every time", () => {
    const products = [
      makeProduct({ hsnCode: "1001", description: "SEER" }),
      makeProduct({ hsnCode: "1002", description: "SANKARA" }),
    ];
    const source = makeSource(products, [
      [50000, 50000, 50000],
      [50000, 50000, 50000],
    ]);
    const personAmounts: PersonAmountEntry[] = [
      { personId: "p1", locked: false, amount: 20000 },
      { personId: "p2", locked: false, amount: 15000 },
    ];

    const r1 = allocateStock({
      role: "debtor",
      source,
      people: PEOPLE,
      selectedMonthIndices: [0, 1, 2],
      personAmounts,
    });
    const r2 = allocateStock({
      role: "debtor",
      source,
      people: PEOPLE,
      selectedMonthIndices: [0, 1, 2],
      personAmounts,
    });
    expect(r1.lines).toEqual(r2.lines);
  });
});

describe("summarizeKnockoff", () => {
  it("computes debtorTotal - creditorTotal per person", () => {
    const summary = summarizeKnockoff(
      PEOPLE,
      [
        { personId: "p1", monthIndex: 0, monthLabel: "M1", productIndex: 0, hsnCode: "1001", description: "SEER", qty: 10, amount: 1000 },
        { personId: "p1", monthIndex: 1, monthLabel: "M2", productIndex: 0, hsnCode: "1001", description: "SEER", qty: 10, amount: 500 },
      ],
      [
        { personId: "p1", monthIndex: 0, monthLabel: "M1", productIndex: 1, hsnCode: "1002", description: "SANKARA", qty: 10, amount: 400 },
      ],
    );
    const p1 = summary.find((s) => s.personId === "p1")!;
    expect(p1.debtorTotal).toBe(1500);
    expect(p1.creditorTotal).toBe(400);
    expect(p1.knockoff).toBe(1100);

    const p2 = summary.find((s) => s.personId === "p2")!;
    expect(p2.debtorTotal).toBe(0);
    expect(p2.creditorTotal).toBe(0);
    expect(p2.knockoff).toBe(0);
  });
});
