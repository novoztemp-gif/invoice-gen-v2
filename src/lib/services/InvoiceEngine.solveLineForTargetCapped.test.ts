import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { ProductConfig } from "./InvoiceEngine";

/**
 * Root-cause fix, found via a real, reported case: multiple invoices
 * (major-customer AND regular alike, across several separately-generated
 * batches) landed above the batch's configured maximum invoice amount,
 * every time with EVERY line pinned exactly to that product's own
 * configured (quantity_min, rate_min) — e.g. a real product with
 * quantity [10, 45] and rate [750, 1100] produced a line at exactly
 * 10 × ₹750 = ₹7,500 no matter what smaller amount was actually needed.
 *
 * Root cause: solveLineForTarget's own `preferFloor: true` fallback (used
 * everywhere a caller needs a hard guarantee of "never land above this
 * target") cannot actually keep that promise when the target is below
 * what the product can even achieve at its own configured minimum
 * quantity — there is no valid (quantity, rate) combination under that
 * floor, so the fallback silently returns the SMALLEST achievable amount
 * instead, which is by construction ABOVE the requested target. Every one
 * of the ~15 call sites across generation (Major Customer correction,
 * Anticipated Major Customer reservation, regular Purchase drift-closing,
 * global drift redistribution, Sales' own equivalents) trusted this
 * "never above target" guarantee blindly.
 *
 * Fixed with solveLineForTargetCapped/solveLineForTargetWithinStockCapped
 * — thin wrappers that verify the result actually respects the target and
 * return null when it's mathematically impossible, so every call site can
 * fall back to leaving the line untouched instead of unknowingly applying
 * a correction that makes the invoice worse, not better.
 */

const Engine = InvoiceEngine as any;

function makeConfig(overrides: Partial<ProductConfig> = {}): Map<string, ProductConfig> {
  return new Map([
    [
      "p1",
      {
        product_id: "p1",
        product_name: "Chicken",
        hsn_code: "0207",
        unit_of_measure: "kg",
        perDayQtyMin: "10",
        perDayQtyMax: "45",
        perDayRateMin: "750",
        perDayRateMax: "1100",
        ...overrides,
      } as ProductConfig,
    ],
  ]);
}

describe("solveLineForTarget preferFloor gap (regression)", () => {
  it("BEFORE-STYLE CHECK: raw solveLineForTarget returns an amount ABOVE target when target is below the product's own floor — this is the exact real-world failure mode", () => {
    const productConfigById = makeConfig();
    // The real reported case: product's cheapest possible line is
    // 10 × ₹750 = ₹7,500. A target of ₹200 is nowhere near achievable.
    const result = Engine.solveLineForTarget(
      "p1",
      10,
      200,
      productConfigById,
      { preferFloor: true },
    );
    expect(result.quantity).toBe(10);
    expect(result.rate).toBe(750);
    expect(result.quantity * result.rate).toBeGreaterThan(200);
  });

  it("solveLineForTargetCapped returns null for the same impossible target, instead of the overshooting result", () => {
    const productConfigById = makeConfig();
    const result = Engine.solveLineForTargetCapped(
      "p1",
      10,
      200,
      productConfigById,
    );
    expect(result).toBeNull();
  });

  it("solveLineForTargetCapped still returns a real result when the target IS achievable", () => {
    const productConfigById = makeConfig();
    // 10kg × ₹900/kg = ₹9,000 — well within [750, 1100] and achievable.
    const result = Engine.solveLineForTargetCapped(
      "p1",
      10,
      9000,
      productConfigById,
    );
    expect(result).not.toBeNull();
    expect(result.quantity * result.rate).toBeLessThanOrEqual(9000 + 0.5);
  });

  it("solveLineForTargetCapped returns null exactly at the boundary just under the floor, and a real result just at/above it", () => {
    const productConfigById = makeConfig();
    // Floor is exactly 10 * 750 = 7500.
    const justUnder = Engine.solveLineForTargetCapped(
      "p1",
      10,
      7499,
      productConfigById,
    );
    expect(justUnder).toBeNull();

    const atFloor = Engine.solveLineForTargetCapped(
      "p1",
      10,
      7500,
      productConfigById,
    );
    expect(atFloor).not.toBeNull();
    expect(atFloor.quantity * atFloor.rate).toBeLessThanOrEqual(7500 + 0.5);
  });

  it("solveLineForTargetWithinStockCapped mirrors the same guarantee for the stock-aware Sales variant", () => {
    const productConfigById = makeConfig();
    const result = Engine.solveLineForTargetWithinStockCapped(
      "p1",
      "2026-01-01",
      10,
      200,
      productConfigById,
      null, // no stock map — falls through to plain solveLineForTarget
    );
    expect(result).toBeNull();
  });
});
