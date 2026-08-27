import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { ProductConfig } from "./InvoiceEngine";

/**
 * Root-cause fix, found via a real, reported case: an invoice landed
 * BELOW the batch's configured minimum invoice amount (₹875 against a
 * ₹1,000 minimum) even though it was never edited (is_edited: false) —
 * confirmed as a fresh generation artifact, not pre-existing data.
 *
 * Root cause: the "reduce drift toward thresholdMin" pass in STEP 3
 * (Global Drift Redistribution) computes a per-line targetLineAmt bounded
 * so the invoice should never drop below thresholdMin (subAmt is capped
 * by `surplus = currentAmt - thresholdMin`) — but the solveLineForTarget
 * call closing that reduction passed neither preferFloor nor
 * preferCeiling, so its "closest achievable candidate" search could just
 * as easily land BELOW targetLineAmt as at/above it, silently pushing a
 * previously-valid invoice under the minimum the surrounding math was
 * specifically bounding it to respect. This is the mirror image of the
 * earlier-fixed preferFloor overshoot bug — same root cause (a directional
 * guarantee assumed but never enforced), opposite direction.
 *
 * Fixed with solveLineForTargetFloored/solveLineForTargetWithinStockFloored
 * — the "preferCeiling" counterparts to the existing Capped wrappers —
 * which verify the result never undershoots the target and return null
 * when that's mathematically impossible, so the caller can leave the line
 * untouched instead of applying a correction that makes things worse.
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
        perDayRateMin: "50",
        perDayRateMax: "100",
        ...overrides,
      } as ProductConfig,
    ],
  ]);
}

describe("solveLineForTarget preferCeiling gap (regression)", () => {
  it("raw solveLineForTarget (no preferFloor/preferCeiling) can land BELOW a reduction target", () => {
    const productConfigById = makeConfig();
    // Reducing from a higher amount down toward exactly 1000 — with qty
    // steps of 0.25 and integer rates, the closest achievable candidate to
    // 1000 can legitimately be slightly under it (e.g. 997) rather than
    // over, depending on the grid — that undershoot is exactly the bug:
    // nothing here prevents it even though the caller needs a hard floor.
    const result = Engine.solveLineForTarget("p1", 20, 1000, productConfigById);
    const amount = result.quantity * result.rate;
    // Not asserting a specific undershoot value (depends on the exact
    // grid) — asserting the absence of a directional guarantee, which the
    // wrapper below fixes.
    expect(typeof amount).toBe("number");
  });

  it("solveLineForTargetFloored never returns a result below the target", () => {
    const productConfigById = makeConfig();
    for (const target of [1000, 999, 1001, 875, 750, 4500]) {
      const result = Engine.solveLineForTargetFloored(
        "p1",
        20,
        target,
        productConfigById,
      );
      if (result) {
        expect(result.quantity * result.rate).toBeGreaterThanOrEqual(
          target - 0.5,
        );
      }
    }
  });

  it("solveLineForTargetFloored returns null when even the product's maximum achievable amount falls short of the target", () => {
    const productConfigById = makeConfig();
    // Max achievable: 45 * 100 = 4500. Target far above that is impossible
    // to reach from below.
    const result = Engine.solveLineForTargetFloored(
      "p1",
      20,
      10000,
      productConfigById,
    );
    expect(result).toBeNull();
  });

  it("solveLineForTargetFloored returns a real result at the achievable boundary", () => {
    const productConfigById = makeConfig();
    const atMax = Engine.solveLineForTargetFloored(
      "p1",
      20,
      4500,
      productConfigById,
    );
    expect(atMax).not.toBeNull();
    expect(atMax.quantity * atMax.rate).toBeGreaterThanOrEqual(4500 - 0.5);

    const justOver = Engine.solveLineForTargetFloored(
      "p1",
      20,
      4501,
      productConfigById,
    );
    expect(justOver).toBeNull();
  });

  it("solveLineForTargetWithinStockFloored mirrors the same guarantee for the stock-aware Sales variant", () => {
    const productConfigById = makeConfig();
    const result = Engine.solveLineForTargetWithinStockFloored(
      "p1",
      "2026-01-01",
      20,
      1000,
      productConfigById,
      null, // no stock map — falls through to plain solveLineForTarget
    );
    expect(result).not.toBeNull();
    expect(result.quantity * result.rate).toBeGreaterThanOrEqual(1000 - 0.5);
  });
});
