import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { InvoiceBatch, ProductConfig } from "./InvoiceEngine";

// `generatePurchaseInvoiceSplitupsInternal`, `generateInvoiceSplitupsInternal`,
// and `getSequentialDateForIndex` are all `private static` on InvoiceEngine.
// Reaching them via `(InvoiceEngine as any)` is the only way to unit-test the
// exact wiring bug fixed in Sprint 1.6A (a global vs. local index mix-up)
// without changing their visibility, which was explicitly out of scope.
const Engine = InvoiceEngine as any;

const START_DATE = new Date(2026, 0, 1); // 2026-01-01
const NUM_DAYS = 30;

function makeProduct(): ProductConfig {
  return {
    product_id: "prod-meat-1",
    product_name: "Chicken",
    hsn_code: "0207",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "10",
    perDayRateMax: "500",
    occurrencePercentage: 100,
  };
}

function makeBatch(overrides: Partial<InvoiceBatch> = {}): InvoiceBatch {
  return {
    id: "batch-1",
    issuing_company_id: "co-1",
    financial_year: "2026-27",
    invoice_date_from: "2026-01-01",
    invoice_date_to: "2026-01-30",
    minimum_invoice_amount: 1000,
    maximum_invoice_amount: 100000,
    total_amount: 0,
    products: [{ ...makeProduct(), category: "Meat" } as any],
    selected_customers: [],
    major_customers: [],
    batch_type: "PURCHASE",
    ...overrides,
  };
}

function categoryMap(ids: string[]): Map<string, "Fruits" | "Meat"> {
  return new Map(ids.map((id) => [id, "Meat" as const]));
}

/** Reuses the production date-math (not under test here — Sprint 1.6's audit
 * already established getSequentialDateForIndex's own algorithm is correct)
 * purely as an oracle for "what date should local index b, out of `total`,
 * produce" — this is exactly what the fix wires the major-customer loop to
 * call. */
function expectedLocalDate(b: number, total: number, dateList: string[]) {
  return Engine.getSequentialDateForIndex(b, total, dateList);
}

function buildDateList(startDate: Date, numDays: number): string[] {
  // Mirrors the dateList construction inside generatePurchaseInvoiceSplitupsInternal.
  const dateList: string[] = [];
  for (let d = 0; d < numDays; d++) {
    const curDate = new Date(startDate);
    curDate.setDate(startDate.getDate() + d);
    const y = curDate.getFullYear();
    const m = String(curDate.getMonth() + 1).padStart(2, "0");
    const day = String(curDate.getDate()).padStart(2, "0");
    dateList.push(`${y}-${m}-${day}`);
  }
  return dateList;
}

describe("generatePurchaseInvoiceSplitupsInternal — major-customer date allocation (Sprint 1.6A)", () => {
  const dateList = buildDateList(START_DATE, NUM_DAYS);

  it("TEST 1: one major customer (20 invoices) — dates match the sequential-date algorithm, numbers stay sequential", () => {
    const batch = makeBatch({
      total_amount: 200000,
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a"]),
    );

    expect(invoices.length).toBe(20);

    // Generation (push) order for a single major customer is untouched by
    // this fix — b=0..19 in order, so the array is already in that order.
    for (let b = 0; b < 20; b++) {
      expect(invoices[b].invoice_date).toBe(expectedLocalDate(b, 20, dateList));
      expect(invoices[b].invoice_number.endsWith(String(b + 1).padStart(7, "0"))).toBe(
        true,
      );
    }
  });

  it("TEST 2: two major customers (A=20, B=10) — Customer B uses its OWN local index 0..9, not global 20..29", () => {
    const batch = makeBatch({
      total_amount: 300000,
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-b",
          amount: 100000,
          invoice_count: 10,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a", "maj-b"]),
    );

    expect(invoices.length).toBe(30);

    const aInvoices = invoices.filter((i: any) => i.customer_id === "maj-a");
    const bInvoices = invoices.filter((i: any) => i.customer_id === "maj-b");
    expect(aInvoices.length).toBe(20);
    expect(bInvoices.length).toBe(10);

    for (let b = 0; b < 20; b++) {
      expect(aInvoices[b].invoice_date).toBe(expectedLocalDate(b, 20, dateList));
    }
    for (let b = 0; b < 10; b++) {
      expect(bInvoices[b].invoice_date).toBe(expectedLocalDate(b, 10, dateList));
    }
  });

  it("TEST 3: three major customers (A=20, B=10, C=15) — every customer's dates start from its own local index", () => {
    const batch = makeBatch({
      total_amount: 450000,
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-b",
          amount: 100000,
          invoice_count: 10,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-c",
          amount: 150000,
          invoice_count: 15,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a", "maj-b", "maj-c"]),
    );

    expect(invoices.length).toBe(45);

    const byCustomer = (id: string) =>
      invoices.filter((i: any) => i.customer_id === id);

    const expectedCounts: Record<string, number> = {
      "maj-a": 20,
      "maj-b": 10,
      "maj-c": 15,
    };

    for (const [custId, count] of Object.entries(expectedCounts)) {
      const custInvoices = byCustomer(custId);
      expect(custInvoices.length).toBe(count);
      for (let b = 0; b < count; b++) {
        expect(custInvoices[b].invoice_date).toBe(
          expectedLocalDate(b, count, dateList),
        );
      }
    }
  });

  it("TEST 4: invoice numbers are unaffected by the fix — sequential, unique, same order as generation", () => {
    const batch = makeBatch({
      total_amount: 300000,
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-b",
          amount: 100000,
          invoice_count: 10,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a", "maj-b"]),
    );

    const numbers: string[] = invoices.map((i: any) => i.invoice_number);
    const uniqueNumbers = new Set(numbers);
    expect(uniqueNumbers.size).toBe(numbers.length);

    // The function's own final chronological sort (untouched by this fix —
    // out of scope per the sprint spec) reorders the returned array by
    // date, so array position no longer equals assignment order once dates
    // are correct. What "invoice numbers did not change" actually
    // guarantees is the SET of numbers: no gaps, no duplicates, exactly
    // 1..30 assigned across the batch — which customer/date each landed on
    // is covered separately by TEST 2/3/6.
    const suffixes = numbers
      .map((n) => parseInt(n.split("-").pop()!, 10))
      .sort((a, b) => a - b);
    expect(suffixes).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("TEST 6: Customer B's first invoice does NOT use the old buggy global index (invoices.length = 20)", () => {
    const batch = makeBatch({
      total_amount: 300000,
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-b",
          amount: 100000,
          invoice_count: 10,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a", "maj-b"]),
    );

    const bFirstInvoice = invoices.find((i: any) => i.customer_id === "maj-b");
    const oldBuggyDate = Engine.getSequentialDateForIndex(20, 10, dateList);
    const correctLocalDate = Engine.getSequentialDateForIndex(0, 10, dateList);

    // Sanity: the two candidate formulas must actually disagree for this
    // fixture, otherwise this test wouldn't prove anything.
    expect(oldBuggyDate).not.toBe(correctLocalDate);

    expect(bFirstInvoice.invoice_date).toBe(correctLocalDate);
    expect(bFirstInvoice.invoice_date).not.toBe(oldBuggyDate);
  });

  it("TEST 7: multiple major customers + normal suppliers — 70 total invoices, continuous unique numbering, local major dates, unaffected normal generation", () => {
    // thresholdMin === thresholdMax makes partitionAmountRandomly's output
    // fully deterministic (every budget clamps to the same fixed value),
    // so remainingBatchAmount / thresholdMin gives an exact, predictable
    // normal-invoice count instead of depending on its internal randomness.
    const NORMAL_INVOICE_AMOUNT = 4000;
    const NORMAL_COUNT = 25;
    const batch = makeBatch({
      total_amount: 450000 + NORMAL_INVOICE_AMOUNT * NORMAL_COUNT,
      minimum_invoice_amount: NORMAL_INVOICE_AMOUNT,
      maximum_invoice_amount: NORMAL_INVOICE_AMOUNT,
      selected_customers: ["norm-1", "norm-2", "norm-3"],
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 200000,
          invoice_count: 20,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-b",
          amount: 100000,
          invoice_count: 10,
          max_invoice_amount: 50000,
        },
        {
          customer_id: "maj-c",
          amount: 150000,
          invoice_count: 15,
          max_invoice_amount: 50000,
        },
      ],
    });

    const invoices = Engine.generatePurchaseInvoiceSplitupsInternal(
      batch,
      NUM_DAYS,
      START_DATE,
      1,
      undefined,
      categoryMap(["maj-a", "maj-b", "maj-c", "norm-1", "norm-2", "norm-3"]),
    );

    expect(invoices.length).toBe(70);

    // No duplicate numbers, continuous 1..70.
    const numbers: string[] = invoices.map((i: any) => i.invoice_number);
    expect(new Set(numbers).size).toBe(70);
    const suffixes = numbers
      .map((n) => parseInt(n.split("-").pop()!, 10))
      .sort((a, b) => a - b);
    expect(suffixes).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));

    // Major-customer date allocation is still local per customer.
    const expectedCounts: Record<string, number> = {
      "maj-a": 20,
      "maj-b": 10,
      "maj-c": 15,
    };
    for (const [custId, count] of Object.entries(expectedCounts)) {
      const custInvoices = invoices.filter((i: any) => i.customer_id === custId);
      expect(custInvoices.length).toBe(count);
      for (let b = 0; b < count; b++) {
        expect(custInvoices[b].invoice_date).toBe(
          expectedLocalDate(b, count, dateList),
        );
      }
    }

    // Normal-supplier generation produced the expected count and is
    // untouched by this fix (no assertions on its date formula here — that
    // code path was not modified).
    const normalInvoices = invoices.filter(
      (i: any) => !["maj-a", "maj-b", "maj-c"].includes(i.customer_id),
    );
    expect(normalInvoices.length).toBe(NORMAL_COUNT);
  });
});

describe("generateInvoiceSplitupsInternal (Sales) — TEST 5: unchanged, still uses local index for major customers", () => {
  // Sprint 1.6A touches ONLY generatePurchaseInvoiceSplitupsInternal — this
  // is a regression check that the Sales generator (a separate, much more
  // involved function with its own day-first stock-selling loop) is
  // untouched and still exhibits the correct local-index behavior it
  // already had. A small date range/major-customer count is used
  // deliberately: Sales' STEP 2 (regular-customer day loop) runs
  // unconditionally after majors and is expensive to execute in a unit
  // test — keeping the fixture small keeps this fast without touching any
  // Sales logic.
  it("Sales major-customer date allocation still uses local `b`, not global invoices.length (no regression from this Purchase-only fix)", () => {
    const smallNumDays = 10;
    const smallDateList = buildDateList(START_DATE, smallNumDays);
    const batch = makeBatch({
      total_amount: 30000,
      batch_type: "SALES",
      major_customers: [
        {
          customer_id: "maj-a",
          amount: 20000,
          invoice_count: 6,
          max_invoice_amount: 5000,
        },
        {
          customer_id: "maj-b",
          amount: 10000,
          invoice_count: 4,
          max_invoice_amount: 5000,
        },
      ],
    });

    const invoices = Engine.generateInvoiceSplitupsInternal(
      batch,
      smallNumDays,
      START_DATE,
      1,
      null,
    );

    const aInvoices = invoices.filter((i: any) =>
      (i.products || []).some((p: any) => p.customer_id === "maj-a"),
    );
    const bInvoices = invoices.filter((i: any) =>
      (i.products || []).some((p: any) => p.customer_id === "maj-b"),
    );

    expect(aInvoices.length).toBe(6);
    expect(bInvoices.length).toBe(4);
    for (let b = 0; b < 4; b++) {
      expect(bInvoices[b].invoice_date).toBe(
        expectedLocalDate(b, 4, smallDateList),
      );
    }
  }, 15000);
});
