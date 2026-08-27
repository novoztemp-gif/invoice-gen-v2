import { describe, expect, it } from "vitest";
import {
  checkPurchaseInvoiceAmountRange,
  isNewPurchaseAmountRangeViolation,
} from "./types";

describe("checkPurchaseInvoiceAmountRange (Sprint 1.5A)", () => {
  const MIN = 10000;
  const MAX = 20000;

  it("TEST 1: 9999.99 is below minimum — FAIL", () => {
    const result = checkPurchaseInvoiceAmountRange(9999.99, MIN, MAX);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("BELOW_MIN");
  });

  it("TEST 2: exactly at minimum (10000) — PASS", () => {
    const result = checkPurchaseInvoiceAmountRange(10000, MIN, MAX);
    expect(result.valid).toBe(true);
  });

  it("TEST 3: comfortably inside range (15000) — PASS", () => {
    const result = checkPurchaseInvoiceAmountRange(15000, MIN, MAX);
    expect(result.valid).toBe(true);
  });

  it("TEST 4: exactly at maximum (20000) — PASS", () => {
    const result = checkPurchaseInvoiceAmountRange(20000, MIN, MAX);
    expect(result.valid).toBe(true);
  });

  it("TEST 5: 20000.01 is above maximum — FAIL", () => {
    const result = checkPurchaseInvoiceAmountRange(20000.01, MIN, MAX);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("ABOVE_MAX");
  });

  it("TEST 6: no configured min/max — always PASS, no constraint applied", () => {
    expect(checkPurchaseInvoiceAmountRange(1, null, null).valid).toBe(true);
    expect(checkPurchaseInvoiceAmountRange(999999, null, null).valid).toBe(
      true,
    );
    expect(checkPurchaseInvoiceAmountRange(1, undefined, undefined).valid).toBe(
      true,
    );
    // Zero is treated the same as "not configured" — a real min/max is
    // always a positive amount in this system.
    expect(checkPurchaseInvoiceAmountRange(1, 0, 0).valid).toBe(true);
  });

  it("TEST 10: decimal boundary precision matches existing MONEY_TOLERANCE (0.001)", () => {
    // Just inside tolerance of the boundary — still valid.
    expect(checkPurchaseInvoiceAmountRange(9999.9995, MIN, MAX).valid).toBe(
      true,
    );
    expect(checkPurchaseInvoiceAmountRange(20000.0005, MIN, MAX).valid).toBe(
      true,
    );
    // Genuinely outside tolerance — invalid.
    expect(checkPurchaseInvoiceAmountRange(9999.98, MIN, MAX).valid).toBe(
      false,
    );
    expect(checkPurchaseInvoiceAmountRange(20000.02, MIN, MAX).valid).toBe(
      false,
    );
  });
});

describe("isNewPurchaseAmountRangeViolation — grandfather policy (Sprint 1.5A)", () => {
  const MIN = 10000;
  const MAX = 20000;

  it("TEST 7: an originally-valid invoice edited below MIN — FAIL", () => {
    const result = isNewPurchaseAmountRangeViolation(9000, 15000, MIN, MAX);
    expect(result.violates).toBe(true);
    expect(result.check.reason).toBe("BELOW_MIN");
  });

  it("TEST 8: an originally-valid invoice edited above MAX — FAIL", () => {
    const result = isNewPurchaseAmountRangeViolation(25000, 15000, MIN, MAX);
    expect(result.violates).toBe(true);
    expect(result.check.reason).toBe("ABOVE_MAX");
  });

  it("a brand-new invoice (no original) outside range — FAIL, held to the range outright", () => {
    const result = isNewPurchaseAmountRangeViolation(5000, null, MIN, MAX);
    expect(result.violates).toBe(true);
  });

  it("grandfathered: an invoice already below MIN stays below MIN by the same or lesser amount — PASS (not made worse)", () => {
    // Original was already 8000 (below MIN=10000) from before this check
    // existed. Editing it to 8500 moves it CLOSER to valid, not worse.
    const result = isNewPurchaseAmountRangeViolation(8500, 8000, MIN, MAX);
    expect(result.violates).toBe(false);
  });

  it("NOT grandfathered: an already-below-MIN invoice edited to be even lower — FAIL", () => {
    const result = isNewPurchaseAmountRangeViolation(7000, 8000, MIN, MAX);
    expect(result.violates).toBe(true);
  });

  it("grandfathered: an invoice already above MAX edited down (but still above MAX) — PASS (not made worse)", () => {
    const result = isNewPurchaseAmountRangeViolation(21000, 22000, MIN, MAX);
    expect(result.violates).toBe(false);
  });

  it("NOT grandfathered: an already-above-MAX invoice edited to be even higher — FAIL", () => {
    const result = isNewPurchaseAmountRangeViolation(23000, 22000, MIN, MAX);
    expect(result.violates).toBe(true);
  });

  it("a valid edit within range never violates", () => {
    const result = isNewPurchaseAmountRangeViolation(15000, 12000, MIN, MAX);
    expect(result.violates).toBe(false);
  });
});
