import { describe, expect, it } from "vitest";
import { FinalValidator } from "./FinalValidator";
import type { ProductConstraint, PurchaseInvoice } from "./types";

const PRODUCT_A = "product-a";
const PRODUCT_B = "product-b";

function makeConstraints(): Map<string, ProductConstraint> {
  return new Map([
    [
      PRODUCT_A,
      {
        productId: PRODUCT_A,
        category: "Meat",
        unitOfMeasure: "kg",
        quantityMin: 1,
        quantityMax: 1000,
        rateMin: 1,
        rateMax: 10000,
      },
    ],
    [
      PRODUCT_B,
      {
        productId: PRODUCT_B,
        category: "Meat",
        unitOfMeasure: "kg",
        quantityMin: 1,
        quantityMax: 1000,
        rateMin: 1,
        rateMax: 10000,
      },
    ],
  ]);
}

function makeInvoice(
  id: string,
  productId: string,
  total: number,
): PurchaseInvoice {
  return {
    id,
    invoice_batch_id: "batch-1",
    invoice_number: `PB-${id}`,
    invoice_date: "2026-09-01",
    products: [
      {
        product_id: productId,
        product_name: productId,
        hsn_code: "1234",
        unit_of_measure: "kg",
        category: "Meat",
        quantity: 10,
        rate: total / 10,
        amount: total,
      },
    ],
    total_amount: total,
  };
}

describe("FinalValidator.validateRebalancedBatch — Purchase amount range (Sprint 1.5A)", () => {
  const MIN = 10000;
  const MAX = 20000;

  it("TEST 9: one invoice violating the range fails the ENTIRE batch validation, not just that invoice", () => {
    const original = [
      makeInvoice("inv-A", PRODUCT_A, 15000),
      makeInvoice("inv-B", PRODUCT_B, 12000),
    ];
    // inv-A edited down to 5000 (violates MIN); inv-B stays perfectly valid.
    const planned = [
      makeInvoice("inv-A", PRODUCT_A, 5000),
      makeInvoice("inv-B", PRODUCT_B, 12000),
    ];

    const result = FinalValidator.validateRebalancedBatch(
      original,
      planned,
      5000 + 12000,
      "Meat",
      makeConstraints(),
      "inv-A",
      new Set(),
      new Set(),
      MIN,
      MAX,
    );

    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.errors.some((e) => e.includes("Amount Range"))).toBe(true);
    // The whole result is a single valid/invalid verdict — there is no
    // partial "inv-B is fine" success path; the caller (AutoBalanceEngine)
    // throws on any error here, before persistBalancePlan is ever called,
    // so nothing gets saved for either invoice.
  });

  it("a batch where every invoice stays within range passes", () => {
    const original = [
      makeInvoice("inv-A", PRODUCT_A, 15000),
      makeInvoice("inv-B", PRODUCT_B, 12000),
    ];
    const planned = [
      makeInvoice("inv-A", PRODUCT_A, 16000),
      makeInvoice("inv-B", PRODUCT_B, 11000),
    ];

    const result = FinalValidator.validateRebalancedBatch(
      original,
      planned,
      16000 + 11000,
      "Meat",
      makeConstraints(),
      "inv-A",
      new Set(),
      new Set(),
      MIN,
      MAX,
    );

    expect(result.valid).toBe(true);
  });

  it("with no configured min/max, range validation never blocks (preserves existing behavior)", () => {
    const original = [makeInvoice("inv-A", PRODUCT_A, 15000)];
    const planned = [makeInvoice("inv-A", PRODUCT_A, 1)];

    const result = FinalValidator.validateRebalancedBatch(
      original,
      planned,
      1,
      "Meat",
      makeConstraints(),
      "inv-A",
      new Set(),
      new Set(),
      null,
      null,
    );

    // No range errors specifically (may still be invalid overall for
    // other reasons, e.g. batch total mismatch — irrelevant here).
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("Amount Range"))).toBe(
        false,
      );
    }
  });
});
