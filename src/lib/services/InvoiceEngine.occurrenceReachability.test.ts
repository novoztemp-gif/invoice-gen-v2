import { describe, expect, it } from "vitest";
import { InvoiceEngine } from "./InvoiceEngine";
import type { InvoiceBatch, ProductConfig } from "./InvoiceEngine";

/**
 * Real bug: generatePurchaseInvoiceSplitupsInternal already restricts
 * itself to only categories that have a reachable supplier selected (see
 * its own "If suppliers are specified, filter product categories to
 * match supplier categories" block) -- a batch with only Meat suppliers
 * selected generates 100% Meat invoices, correctly, since there's no
 * supplier to attribute a Fruits purchase to. But checkProductOccurrenceGate
 * (and repairOccurrenceDeviations) computed each category's target share
 * purely from configured occurrencePercentage sums, with no awareness of
 * that same restriction -- so Fruits still "expected" its full percentage
 * share of invoices, and every Meat product read as over target on every
 * single one of 30 retries, deterministically (confirmed on a real batch:
 * Meat products at target 13/14 landing at actual 27/28, every attempt).
 *
 * Reaching checkProductOccurrenceGate via (InvoiceEngine as any) is the
 * established pattern this whole test suite already uses for other
 * private static methods (see InvoiceEngine.purchaseMajorDate.test.ts)
 * rather than changing visibility.
 */
const Engine = InvoiceEngine as any;

function product(
  id: string,
  category: "Meat" | "Fruits",
  occurrencePercentage: number,
): ProductConfig {
  return {
    product_id: id,
    product_name: id,
    hsn_code: "0000",
    unit_of_measure: "kg",
    perDayQtyMin: "10",
    perDayQtyMax: "100",
    perDayRateMin: "50",
    perDayRateMax: "100",
    occurrencePercentage,
    category,
  } as any;
}

describe("checkProductOccurrenceGate — supplier-category reachability", () => {
  it("does not flag Meat products as over target when no Fruits suppliers are selected, even though Fruits products are configured with a real occurrence share", () => {
    const products = [
      product("meatA", "Meat", 37.5),
      product("meatB", "Meat", 37.5),
      product("fruitC", "Fruits", 12.5),
      product("fruitD", "Fruits", 12.5),
    ];
    const batch = {
      id: "batch-1",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      products,
      selected_customers: ["sup-meat-1"],
      major_customers: [],
      batch_type: "PURCHASE",
      occurrence_semantics: null,
    } as unknown as InvoiceBatch;

    // Only a Meat supplier is selected for this batch -- Fruits has zero
    // reachable suppliers, exactly the real reported scenario.
    const supplierCategoryMap = new Map<string, "Fruits" | "Meat">([
      ["sup-meat-1", "Meat"],
    ]);

    // What real generation would actually produce given no Fruits
    // suppliers: every invoice lands in Meat, split evenly between the
    // two Meat products (equal share within Meat) -- exactly what a
    // correctly-computed (reachability-aware) target should predict.
    const invoices: any[] = [];
    for (let i = 0; i < 60; i++) {
      invoices.push({
        products: [{ product_id: "meatA", quantity: 10, amount: 1000 }],
      });
    }
    for (let i = 0; i < 60; i++) {
      invoices.push({
        products: [{ product_id: "meatB", quantity: 10, amount: 1000 }],
      });
    }

    expect(() =>
      Engine.checkProductOccurrenceGate(invoices, batch, supplierCategoryMap),
    ).not.toThrow();
  });

  it("also applies under CATEGORY semantics — the explicit category_allocation split is reachability-corrected too, not just GLOBAL's summed percentages", () => {
    const products = [
      product("meatA", "Meat", 50),
      product("meatB", "Meat", 50),
      product("fruitC", "Fruits", 50),
      product("fruitD", "Fruits", 50),
    ];
    const batch = {
      id: "batch-2",
      issuing_company_id: "co-1",
      financial_year: "2026-27",
      products,
      selected_customers: ["sup-meat-1"],
      major_customers: [],
      batch_type: "PURCHASE",
      occurrence_semantics: "CATEGORY",
      category_allocation: { Meat: 70, Fruits: 30 },
    } as unknown as InvoiceBatch;

    // Same real scenario as above, just under CATEGORY semantics with an
    // explicit 70/30 split instead of GLOBAL's summed percentages — only
    // a Meat supplier is selected, so Fruits has zero reachable capacity
    // no matter what the configured split says.
    const supplierCategoryMap = new Map<string, "Fruits" | "Meat">([
      ["sup-meat-1", "Meat"],
    ]);

    const invoices: any[] = [];
    for (let i = 0; i < 60; i++) {
      invoices.push({
        products: [{ product_id: "meatA", quantity: 10, amount: 1000 }],
      });
    }
    for (let i = 0; i < 60; i++) {
      invoices.push({
        products: [{ product_id: "meatB", quantity: 10, amount: 1000 }],
      });
    }

    expect(() =>
      Engine.checkProductOccurrenceGate(invoices, batch, supplierCategoryMap),
    ).not.toThrow();
  });
});
