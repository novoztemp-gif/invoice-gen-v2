/**
 * Sprint 1.7L — deterministic quota/target allocation engine.
 *
 * This is the pipeline that turns a batch's occurrence configuration
 * (product percentages, category allocation, occurrence_semantics) into
 * concrete integer invoice-occurrence targets, per Sprint 1.7H's approved
 * design:
 *
 *   totalInvoiceCount
 *         ↓
 *   category_allocation           (CATEGORY semantics only)
 *         ↓
 *   Meat / Fruits invoice pools
 *         ↓
 *   product occurrence percentages (interpreted WITHIN each pool)
 *         ↓
 *   product invoice occurrence targets
 *
 * Deliberately kept as its own file, separate from
 * ProductOccurrenceService.ts (which already covers target calculation for
 * a flat product list, occurrence validation, and feasibility) — this
 * keeps that file from growing into a mixed-responsibility module, per
 * Sprint 1.7L's own stated preference.
 *
 * PURITY: no database calls, no Supabase, no UI, no invoice generation
 * calls, no Math.random(), no timestamps, no mutation of any input. Not
 * called from anywhere outside this file's own tests — wiring into
 * generation is explicitly a later sprint.
 *
 * REUSE, NOT DUPLICATION: every percentage-to-integer conversion in this
 * file goes through ProductOccurrenceService.calculateTargetOccurrences
 * (Sprint 1.7B's Largest Remainder / Hamilton apportionment) — category
 * allocation is treated as just another instance of that same math
 * problem (two "products" named "Meat" and "Fruits"), not a second
 * rounding algorithm. Configuration validity is assumed to already have
 * been checked by validateOccurrenceConfiguration /
 * validateCategoryOccurrenceConfiguration (Sprint 1.7C/1.7J) — this
 * service re-runs those same validators itself before computing anything
 * (defense in depth, matching checkOccurrenceFeasibility's own pattern in
 * Sprint 1.7D), but never repairs or silently normalizes invalid input.
 */

import type { ProductConfig } from "./InvoiceEngine";
import { resolveProductCategory, type ProductCategory } from "./ProductCategoryService";
import {
  calculateTargetOccurrences,
  validateCategoryOccurrenceConfiguration,
  validateOccurrenceConfiguration,
  type CategoryAllocation,
  type OccurrenceSemantics,
} from "./ProductOccurrenceService";

export interface ProductOccurrenceTarget {
  productId: string;
  productName?: string;
  category: ProductCategory;
  occurrencePercentage: number;
  targetInvoiceCount: number;
}

export interface CategoryQuotaAllocation {
  valid: boolean;
  errors: string[];
  totalInvoiceCount: number;
  /** Always the resolved, concrete semantics actually used to compute this result — "GLOBAL" for both GLOBAL and NULL/legacy input, never left ambiguous. */
  occurrenceSemantics: "GLOBAL" | "CATEGORY";
  /**
   * Invoice-count targets per category. `null` under GLOBAL semantics —
   * there is no category invoice pool concept there; every product's
   * target is computed directly against totalInvoiceCount, not against a
   * category subset.
   */
  categoryTargets: { Meat: number; Fruits: number } | null;
  productTargets: ProductOccurrenceTarget[];
}

function invalidResult(
  totalInvoiceCount: number,
  occurrenceSemantics: "GLOBAL" | "CATEGORY",
  errors: string[],
): CategoryQuotaAllocation {
  return {
    valid: false,
    errors,
    totalInvoiceCount,
    occurrenceSemantics,
    categoryTargets: null,
    productTargets: [],
  };
}

/**
 * Computes the full quota allocation for a batch. This is the single
 * entry point for Sprint 1.7L's pipeline — GLOBAL, NULL (treated as
 * legacy GLOBAL, never auto-promoted to CATEGORY), and CATEGORY semantics
 * are all handled here, matching the resolved-semantics branch used
 * throughout Sprint 1.7J.
 *
 * Throws only for malformed primitive arguments (non-integer/negative
 * totalInvoiceCount) — mirrors calculateTargetOccurrences' and
 * checkOccurrenceFeasibility's own established convention for that class
 * of error. Business-configuration invalidity (missing category
 * allocation, percentages not summing to 100%, contradictions, etc.) is
 * never thrown — it is returned as `{valid: false, errors}`, so a caller
 * that already validated configuration separately never gets a surprise
 * exception here.
 */
export function calculateQuotaAllocation(
  products: ProductConfig[],
  totalInvoiceCount: number,
  categoryAllocation: CategoryAllocation | null | undefined,
  occurrenceSemantics: OccurrenceSemantics,
): CategoryQuotaAllocation {
  if (!Number.isInteger(totalInvoiceCount) || totalInvoiceCount < 0) {
    throw new Error(
      `totalInvoiceCount must be a non-negative integer (received: ${totalInvoiceCount}).`,
    );
  }

  const resolvedSemantics: "GLOBAL" | "CATEGORY" =
    occurrenceSemantics === "CATEGORY" ? "CATEGORY" : "GLOBAL";

  if (resolvedSemantics === "GLOBAL") {
    return calculateGlobalQuota(products, totalInvoiceCount);
  }

  return calculateCategoryQuota(
    products,
    totalInvoiceCount,
    categoryAllocation,
  );
}

function calculateGlobalQuota(
  products: ProductConfig[],
  totalInvoiceCount: number,
): CategoryQuotaAllocation {
  const configValidation = validateOccurrenceConfiguration(products);
  if (!configValidation.valid) {
    return invalidResult(totalInvoiceCount, "GLOBAL", configValidation.errors);
  }

  let targets: Map<string, number>;
  try {
    targets = calculateTargetOccurrences(
      (products || []).map((p) => ({
        productId: p.product_id,
        occurrencePercentage: Number((p as any).occurrencePercentage),
      })),
      totalInvoiceCount,
    );
  } catch (err: any) {
    // Only reachable for the empty-products + totalInvoiceCount>0 edge
    // case — validateOccurrenceConfiguration treats an empty list as
    // valid (defers to InvoiceEngine's own "No products found" guard,
    // Sprint 1.7C), but calculateTargetOccurrences correctly refuses to
    // allocate invoices across zero products. Reported as an invalid
    // result rather than left to propagate as an uncaught exception.
    return invalidResult(totalInvoiceCount, "GLOBAL", [
      err?.message || "Unable to calculate target occurrences.",
    ]);
  }

  const productTargets: ProductOccurrenceTarget[] = (products || []).map(
    (p) => ({
      productId: p.product_id,
      productName: p.product_name,
      category: resolveProductCategory(p),
      occurrencePercentage: Number((p as any).occurrencePercentage),
      targetInvoiceCount: targets.get(p.product_id) || 0,
    }),
  );

  return {
    valid: true,
    errors: [],
    totalInvoiceCount,
    occurrenceSemantics: "GLOBAL",
    categoryTargets: null,
    productTargets,
  };
}

function calculateCategoryQuota(
  products: ProductConfig[],
  totalInvoiceCount: number,
  categoryAllocation: CategoryAllocation | null | undefined,
): CategoryQuotaAllocation {
  const configValidation = validateCategoryOccurrenceConfiguration(
    products,
    categoryAllocation,
    "CATEGORY",
  );
  if (!configValidation.valid) {
    return invalidResult(totalInvoiceCount, "CATEGORY", configValidation.errors);
  }

  // configValidation.valid guarantees categoryAllocation is present and
  // well-formed (0-100 each, sums to 100% ± tolerance) — safe to read
  // directly now.
  const meatPct = categoryAllocation!.Meat ?? 0;
  const fruitsPct = categoryAllocation!.Fruits ?? 0;

  // Category allocation is just another instance of the same
  // percentage-to-integer-count problem calculateTargetOccurrences
  // already solves — two synthetic "products" named "Meat" and "Fruits",
  // not a second rounding algorithm.
  const categoryTargetsMap = calculateTargetOccurrences(
    [
      { productId: "Meat", occurrencePercentage: meatPct },
      { productId: "Fruits", occurrencePercentage: fruitsPct },
    ],
    totalInvoiceCount,
  );
  const categoryTargets = {
    Meat: categoryTargetsMap.get("Meat") || 0,
    Fruits: categoryTargetsMap.get("Fruits") || 0,
  };

  const productsByCategory = new Map<ProductCategory, ProductConfig[]>();
  for (const p of products || []) {
    const cat = resolveProductCategory(p);
    if (!productsByCategory.has(cat)) productsByCategory.set(cat, []);
    productsByCategory.get(cat)!.push(p);
  }

  const productTargets: ProductOccurrenceTarget[] = [];

  for (const category of ["Meat", "Fruits"] as ProductCategory[]) {
    const productsInCategory = productsByCategory.get(category) || [];
    if (productsInCategory.length === 0) continue;

    // Per-category product percentages are interpreted WITHIN this
    // category's own invoice pool (categoryTargets[category]), not
    // against totalInvoiceCount — this is the core semantic difference
    // from GLOBAL, per Sprint 1.7H's approved design.
    const categoryProductTargets = calculateTargetOccurrences(
      productsInCategory.map((p) => ({
        productId: p.product_id,
        occurrencePercentage: Number((p as any).occurrencePercentage),
      })),
      categoryTargets[category],
    );

    for (const p of productsInCategory) {
      productTargets.push({
        productId: p.product_id,
        productName: p.product_name,
        category,
        occurrencePercentage: Number((p as any).occurrencePercentage),
        targetInvoiceCount: categoryProductTargets.get(p.product_id) || 0,
      });
    }
  }

  return {
    valid: true,
    errors: [],
    totalInvoiceCount,
    occurrenceSemantics: "CATEGORY",
    categoryTargets,
    productTargets,
  };
}
