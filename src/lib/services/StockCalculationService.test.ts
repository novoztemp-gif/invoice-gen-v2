import { describe, expect, it } from "vitest";
import {
  computeDailyChronologicalStock,
  getCarryForwardStockByProduct,
  getFinalClosingStockByProduct,
  getFinalClosingStockForProduct,
  type StockLedgerRow,
  validateStockConservation,
} from "./StockCalculationService";

const PRODUCT_A = "product-a";
const PRODUCT_B = "product-b";

describe("StockCalculationService", () => {
  it("TEST 1: single day, fully sold, closing is 0", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 100,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily).toHaveLength(1);
    expect(daily[0].closing).toBe(0);
  });

  it("TEST 2: two days, closing carries forward as next day's opening", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 60,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        opening_stock: 40,
        purchased_quantity: 0,
        sold_quantity: 20,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily).toHaveLength(2);
    expect(daily[0].closing).toBe(40);
    expect(daily[1].opening).toBe(40);
    expect(daily[1].closing).toBe(20);
  });

  it("TEST 3: sell-out day followed by a restock day", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 100,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        purchased_quantity: 50,
        sold_quantity: 20,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily[0].closing).toBe(0);
    expect(daily[1].closing).toBe(30);
  });

  it("TEST 4: carry-forward helper returns the final chronological stock", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        purchased_quantity: 100,
        sold_quantity: 60,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        purchased_quantity: 50,
        sold_quantity: 20,
      },
    ];

    const carryForward = getCarryForwardStockByProduct(rows);
    expect(carryForward.get(PRODUCT_A)).toBe(70);
    expect(getFinalClosingStockForProduct(rows)).toBe(70);
  });

  it("TEST 5: a zero-purchase, zero-sold day after a sell-out stays at zero", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 100,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        purchased_quantity: 0,
        sold_quantity: 0,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily[1].opening).toBe(0);
    expect(daily[1].closing).toBe(0);
  });

  it("TEST 6: decimal quantities are preserved exactly", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 40693.5,
        sold_quantity: 12345.25,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily[0].closing).toBe(28348.25);
  });

  it("TEST 7: multiple products never affect each other", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 40,
      },
      {
        product_id: PRODUCT_B,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 5,
        sold_quantity: 5,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        purchased_quantity: 0,
        sold_quantity: 10,
      },
      {
        product_id: PRODUCT_B,
        ledger_date: "2026-08-02",
        purchased_quantity: 50,
        sold_quantity: 0,
      },
    ];

    const finalStock = getCarryForwardStockByProduct(rows);
    // Product A: day1 closing 60, day2 closing 50 — never touched by B's rows.
    expect(finalStock.get(PRODUCT_A)).toBe(50);
    // Product B: day1 closing 0, day2 closing 50 — never touched by A's rows.
    expect(finalStock.get(PRODUCT_B)).toBe(50);
  });

  it("TEST 8: rows out of database order are sorted chronologically before calculating", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-03",
        purchased_quantity: 0,
        sold_quantity: 5,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 60,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-02",
        purchased_quantity: 0,
        sold_quantity: 20,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    // Must come back in chronological order regardless of input order.
    expect(daily.map((d) => d.ledger_date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(daily[0].closing).toBe(40);
    expect(daily[1].closing).toBe(20);
    expect(daily[2].closing).toBe(15);
  });

  it("TEST 9: oversell is clamped to zero, never negative", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
        opening_stock: 10,
        purchased_quantity: 0,
        sold_quantity: 20,
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily[0].closing).toBe(0);
    expect(daily[0].closing).toBeGreaterThanOrEqual(0);
  });

  it("missing purchased_quantity/sold_quantity/opening_stock are treated as 0", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-08-01",
      },
    ];

    const daily = computeDailyChronologicalStock(rows);
    expect(daily[0].opening).toBe(0);
    expect(daily[0].purchased).toBe(0);
    expect(daily[0].sold).toBe(0);
    expect(daily[0].closing).toBe(0);
  });
});

// Sprint 1.3A regression suite — the 7 cases specified for the operational
// migration (get-purchase-batch-stock-summary, fetchAvailableSources,
// InvoiceEngine ledger-seeding all route through the functions under test
// here, so these prove the underlying engine behavior those consumers now
// depend on). CASE 4, 5 and 6 are about UI/API-layer behavior (which card
// shows which number, that selecting a source never mutates another card)
// rather than the arithmetic itself — verified by code inspection instead
// of a unit test, noted in the Sprint 1.3A report rather than duplicated
// here as a non-arithmetic assertion.
describe("Sprint 1.3A regression cases", () => {
  it("CASE 1: full-day sell-through leaves zero remaining", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 100,
      },
    ];
    expect(getFinalClosingStockForProduct(rows)).toBe(0);
  });

  it("CASE 2: two purchase days and two sales days net to 70", () => {
    const rows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 60,
      },
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-02",
        purchased_quantity: 50,
        sold_quantity: 20,
      },
    ];
    expect(getFinalClosingStockForProduct(rows)).toBe(70);
  });

  it("CASE 3: a 30-day purchase batch keeps each day's quantity attached to its own date", () => {
    const rows: StockLedgerRow[] = [];
    for (let day = 1; day <= 30; day++) {
      rows.push({
        product_id: PRODUCT_A,
        ledger_date: `2026-09-${String(day).padStart(2, "0")}`,
        opening_stock: day === 1 ? 0 : undefined,
        purchased_quantity: day, // distinct per day, so mixups are detectable
        sold_quantity: 0,
      });
    }

    const daily = computeDailyChronologicalStock(rows);
    expect(daily).toHaveLength(30);
    daily.forEach((d, idx) => {
      const expectedDay = idx + 1;
      expect(d.ledger_date).toBe(`2026-09-${String(expectedDay).padStart(2, "0")}`);
      expect(d.purchased).toBe(expectedDay);
    });
    // Nothing sold across all 30 days: closing = sum of every day's purchase.
    const totalPurchased = (30 * 31) / 2; // 1+2+...+30
    expect(daily[29].closing).toBe(totalPurchased);
  });

  it("CASE 7: multiple purchase batches for the same product aggregate correctly when combined", () => {
    // Simulates selecting two Purchase Batches as combined Sales stock
    // sources: rows from both batches for the same product must sum
    // together correctly once merged into one chronological sequence.
    const batchARows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
    ];
    const batchBRows: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 50,
        sold_quantity: 0,
      },
    ];

    const combined = getFinalClosingStockByProduct([
      ...batchARows,
      ...batchBRows,
    ]);
    // Both batches' purchased_quantity for the same date/product sums.
    expect(combined.get(PRODUCT_A)).toBe(150);
  });
});

describe("Sprint 1.3B: validateStockConservation", () => {
  it("TEST B: requested sold equals available — PASS, closing 0", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 100 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    // Once accepted, the sale gets recorded as sold_quantity — simulate
    // that and confirm the resulting closing stock is 0.
    const daily = computeDailyChronologicalStock([
      { ...ledger[0], sold_quantity: 100 },
    ]);
    expect(daily[0].closing).toBe(0);
  });

  it("TEST C: requested sold under available — PASS, closing 30", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 70 },
    ]);
    expect(result.valid).toBe(true);

    const daily = computeDailyChronologicalStock([
      { ...ledger[0], sold_quantity: 70 },
    ]);
    expect(daily[0].closing).toBe(30);
  });

  it("TEST D: requested sold exceeds available — FAIL, rejected", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 101 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      product_id: PRODUCT_A,
      ledger_date: "2026-09-01",
      requested: 101,
      available: 100,
    });
  });

  it("TEST E: negative requested quantity — FAIL, rejected", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: -1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.negativeQuantityLines).toHaveLength(1);
  });

  it("TEST F: multiple products, all within capacity — PASS", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
      {
        product_id: PRODUCT_B,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 50,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 80 },
      { product_id: PRODUCT_B, ledger_date: "2026-09-01", quantity: 40 },
    ]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("TEST G: one product over capacity fails the ENTIRE request, not just that product", () => {
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 0,
      },
      {
        product_id: PRODUCT_B,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 50,
        sold_quantity: 0,
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 120 },
      { product_id: PRODUCT_B, ledger_date: "2026-09-01", quantity: 40 },
    ]);
    // The whole result is invalid — the caller (create-sales-batch-
    // transactional) checks `conservation.valid` once and rejects the
    // full request before any insert happens, so Product B's otherwise-ok
    // line never gets partially saved.
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].product_id).toBe(PRODUCT_A);
  });

  it("already-recorded sold_quantity from a prior batch reduces capacity for a new request", () => {
    // A second Sales batch drawing leftover from the same purchase batch
    // must not be able to sell what a PRIOR batch already sold.
    const ledger: StockLedgerRow[] = [
      {
        product_id: PRODUCT_A,
        ledger_date: "2026-09-01",
        opening_stock: 0,
        purchased_quantity: 100,
        sold_quantity: 60, // already sold by an earlier batch
      },
    ];
    const result = validateStockConservation(ledger, [
      { product_id: PRODUCT_A, ledger_date: "2026-09-01", quantity: 41 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations[0].available).toBe(40);
  });
});
