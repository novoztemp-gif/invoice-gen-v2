/**
 * Sprint 1.7B — pure, deterministic core of the Product Occurrence business
 * rule approved in Sprint 1.7A (Option B): occurrencePercentage is a TARGET
 * PERCENTAGE OF ACTUAL INVOICES a product should appear in, not a random
 * selection weight.
 *
 * These three functions are the mathematical foundation only. Nothing here
 * is wired into generation, balancing, or validation yet — see Sprint 1.7A's
 * phased implementation plan for what comes next. No Supabase, no React, no
 * database access; every function is pure and side-effect free.
 *
 * Sprint 1.7C adds validateOccurrenceConfiguration — the server-side
 * authoritative check that a batch's configured occurrence percentages are
 * well-formed BEFORE generation starts. It is deliberately a separate
 * responsibility from calculateTargetOccurrences (Sprint 1.7B): this
 * function only asks "is the configuration itself valid," never "what
 * should each product's target count be."
 */

// `import type` only — erased at compile time, so this does not create a
// runtime circular dependency with InvoiceEngine.ts (which imports
// validateOccurrenceConfiguration from this file at runtime).
import type { ProductConfig } from "./InvoiceEngine";
import {
  resolveProductCategory,
  type ProductCategory,
} from "./ProductCategoryService";

export interface ProductOccurrenceConfig {
  productId: string;
  occurrencePercentage: number;
}

export interface OccurrenceInvoiceLine {
  product_id: string;
  quantity: number;
}

export interface OccurrenceInvoice {
  products: OccurrenceInvoiceLine[];
}

export interface OccurrenceViolation {
  productId: string;
  target: number;
  actual: number;
  deviation: number;
}

const SUM_TOLERANCE = 0.01;

/**
 * Calculates each product's target occurrence count for a batch of
 * `totalInvoiceCount` invoices, using the Largest Remainder (Hamilton)
 * apportionment method — see Sprint 1.7A §3 for the full justification.
 *
 * Naive per-product `Math.round` cannot be used here: it has no guarantee
 * that the rounded totals sum back to `totalInvoiceCount` (e.g. a 50/50
 * split of 7 invoices rounds to 4+4=8, not 7). Largest Remainder guarantees
 * the sum exactly, deterministically, while staying as close as possible to
 * the real-valued targets.
 *
 * Throws (rather than silently normalizing) on any invalid configuration —
 * percentages must already sum to exactly 100% (within the same 0.01
 * tolerance already used elsewhere in this codebase for the same check,
 * e.g. InvoiceEngine.validateOccurrenceDistribution).
 */
export function calculateTargetOccurrences(
  products: ProductOccurrenceConfig[],
  totalInvoiceCount: number,
): Map<string, number> {
  if (!Number.isInteger(totalInvoiceCount) || totalInvoiceCount < 0) {
    throw new Error(
      `totalInvoiceCount must be a non-negative integer (received: ${totalInvoiceCount}).`,
    );
  }

  if (!products || products.length === 0) {
    // An empty product list can only ever produce a sum of 0% — it is only
    // ever a valid configuration when there are zero invoices to allocate
    // across, in which case there is nothing to compute.
    if (totalInvoiceCount > 0) {
      throw new Error(
        `Cannot allocate ${totalInvoiceCount} invoice(s) across zero configured products.`,
      );
    }
    return new Map();
  }

  const seenIds = new Set<string>();
  let sum = 0;

  for (const p of products) {
    if (!p.productId || typeof p.productId !== "string" || p.productId.trim() === "") {
      throw new Error("Product occurrence configuration contains an empty product ID.");
    }
    if (seenIds.has(p.productId)) {
      throw new Error(
        `Duplicate product ID "${p.productId}" in product occurrence configuration.`,
      );
    }
    seenIds.add(p.productId);

    const pct = p.occurrencePercentage;
    if (typeof pct !== "number" || !Number.isFinite(pct)) {
      throw new Error(
        `Product "${p.productId}": occurrence percentage must be a finite number (received: ${pct}).`,
      );
    }
    if (pct < 0 || pct > 100) {
      throw new Error(
        `Product "${p.productId}": occurrence percentage (${pct}) must be between 0 and 100.`,
      );
    }

    sum += pct;
  }

  sum = Math.round(sum * 100) / 100;
  // See validateOccurrenceConfiguration's identical comment: rounding the
  // difference (not just `sum`) absorbs IEEE 754 representation noise
  // (e.g. 99.99 - 100 !== -0.01 exactly) without changing the ±0.01
  // business tolerance itself.
  const diffFromTarget = Math.round(Math.abs(sum - 100) * 1e6) / 1e6;
  if (diffFromTarget > SUM_TOLERANCE) {
    throw new Error(
      `Total Product Occurrence Percentage must equal exactly 100%. Current Total: ${sum.toFixed(2)}%.`,
    );
  }

  // 1-2. Exact real-valued target and its floor, per product.
  const entries = products.map((p) => {
    const exactTarget = (totalInvoiceCount * p.occurrencePercentage) / 100;
    const base = Math.floor(exactTarget);
    return {
      productId: p.productId,
      pct: p.occurrencePercentage,
      base,
      remainder: exactTarget - base,
    };
  });

  // 3. Remaining slots to distribute — rounded to the nearest integer to
  // absorb harmless floating-point drift from the sum above (this is
  // rounding an already-integer-valued quantity, not introducing a new
  // tolerance concept).
  const sumBase = entries.reduce((s, e) => s + e.base, 0);
  const remaining = Math.max(
    0,
    Math.min(entries.length, Math.round(totalInvoiceCount - sumBase)),
  );

  // 4-5. Deterministic sort: remainder DESC, then occurrencePercentage
  // DESC, then productId ASC — never dependent on input array order or
  // object/Map iteration order.
  const sorted = [...entries].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  });

  // 6-7. Base allocation, +1 to the top `remaining` products by the sort above.
  const result = new Map<string, number>();
  for (const e of entries) {
    result.set(e.productId, e.base);
  }
  for (let i = 0; i < remaining; i++) {
    const pid = sorted[i].productId;
    result.set(pid, (result.get(pid) || 0) + 1);
  }

  return result;
}

/**
 * Counts, per product, how many DISTINCT invoices contain that product with
 * a positive quantity — this is the "actual occurrence count" side of the
 * Sprint 1.7A contract (§2). A product appearing on multiple lines of the
 * SAME invoice (e.g. two lots at different rates) still counts once for
 * that invoice. Zero and negative quantities never count.
 *
 * Does not mutate its input — only reads `invoices`.
 */
export function countActualOccurrences(
  invoices: OccurrenceInvoice[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const inv of invoices || []) {
    if (!inv || !Array.isArray(inv.products) || inv.products.length === 0) {
      continue;
    }

    const seenOnThisInvoice = new Set<string>();
    for (const line of inv.products) {
      if (!line) continue;

      const pid = line.product_id;
      // A malformed/empty product_id can never be a valid Map key for a
      // real product's occurrence count — silently including it would
      // either create a bogus "" entry or throw on inconsistent input
      // shapes. Consistent with how the rest of this codebase treats
      // missing product_id as "not a real line" (e.g.
      // SalesInvoiceValidator's mandatory-field check), it is simply
      // ignored here rather than counted or rejected — this function has
      // no mechanism to report per-line errors back to a caller, and
      // silently skipping an unusable line is safer than corrupting the
      // count for every other, well-formed product.
      if (!pid || typeof pid !== "string" || pid.trim() === "") continue;

      const qty = Number(line.quantity);
      if (!(qty > 0)) continue; // ignores 0, negative, NaN, undefined

      seenOnThisInvoice.add(pid);
    }

    for (const pid of seenOnThisInvoice) {
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
  }

  return counts;
}

/**
 * Compares target vs. actual occurrence counts and reports every product
 * whose deviation exceeds `tolerance` (default 0 — exact match required).
 * A product missing from `actual` is treated as having 0 occurrences. A
 * product present in `actual` but absent from `target` is NOT silently
 * ignored — it is reported as a violation against an implied target of 0.
 *
 * Does not mutate `target` or `actual`. Returns a new array, sorted by
 * productId ascending for deterministic output.
 */
export function findOccurrenceViolations(
  target: Map<string, number>,
  actual: Map<string, number>,
  tolerance: number = 0,
): OccurrenceViolation[] {
  const allProductIds = new Set<string>([...target.keys(), ...actual.keys()]);
  const violations: OccurrenceViolation[] = [];

  for (const productId of allProductIds) {
    const targetCount = target.get(productId) ?? 0;
    const actualCount = actual.get(productId) ?? 0;
    const deviation = actualCount - targetCount;

    if (Math.abs(deviation) > tolerance) {
      violations.push({
        productId,
        target: targetCount,
        actual: actualCount,
        deviation,
      });
    }
  }

  violations.sort((a, b) =>
    a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
  );

  return violations;
}

export interface OccurrenceConfigurationValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Sprint 1.7C — validates that a batch's configured occurrencePercentage
 * values (on the batch's own ProductConfig[] — no new schema, reusing the
 * type InvoiceEngine already defines) are well-formed BEFORE generation
 * starts. This is a configuration-shape check only; it says nothing about
 * whether a valid configuration is achievable given stock/date/amount
 * constraints (that is feasibility checking, explicitly out of scope for
 * this sprint per Sprint 1.7A's phased plan) and never computes target
 * counts (that is calculateTargetOccurrences' job, kept separate).
 *
 * Closes the Sprint 1.7 Root Cause 6 asymmetry: Purchase and Sales are
 * validated identically here — there is no batch-type branch anywhere in
 * this function.
 *
 * An empty `products` array is treated as VALID by this function
 * specifically — deliberately, not by oversight. InvoiceEngine.
 * generateAndSaveInvoices already throws "No products found in batch..."
 * before any occurrence configuration is even reachable
 * (InvoiceEngine.ts, the check immediately following the batch fetch), so
 * rejecting an empty list here too would create a second, differently
 * worded rule for the exact same case. Preserving the existing contract
 * means this function defers to that pre-existing guard rather than
 * duplicating or contradicting it.
 */
export function validateOccurrenceConfiguration(
  products: ProductConfig[],
): OccurrenceConfigurationValidation {
  const errors: string[] = [];

  if (!products || products.length === 0) {
    return { valid: true, errors: [] };
  }

  const seenIds = new Set<string>();
  let sum = 0;

  for (const p of products) {
    const label = p.product_name || p.product_id || "Unknown product";

    if (p.product_id) {
      if (seenIds.has(p.product_id)) {
        errors.push(`Duplicate product configuration for product ${label}.`);
      } else {
        seenIds.add(p.product_id);
      }
    }

    const raw = (p as any).occurrencePercentage;

    if (raw === undefined || raw === null || raw === "") {
      // The exact gap Sprint 1.7 Root Cause 6 documented: Sales was
      // silently defaulting this to "0" client-side instead of rejecting
      // it like Purchase did. Neither behavior is acceptable here — a
      // missing value is always an error, for both batch types.
      errors.push(`Product ${label}: occurrence percentage is required.`);
      continue;
    }

    let pct: number;
    if (typeof raw === "number") {
      pct = raw;
    } else if (typeof raw === "string") {
      // Number(), not parseFloat() — parseFloat("50abc") silently returns
      // 50, which would let a genuinely malformed value through. Number()
      // correctly rejects anything with trailing garbage.
      pct = Number(raw);
    } else {
      errors.push(`Product ${label}: occurrence percentage is not a valid number.`);
      continue;
    }

    if (!Number.isFinite(pct)) {
      errors.push(`Product ${label}: occurrence percentage is not a valid number.`);
      continue;
    }

    if (pct < 0 || pct > 100) {
      errors.push(`Product ${label}: occurrence percentage must be between 0 and 100.`);
      continue;
    }

    sum += pct;
  }

  sum = Math.round(sum * 100) / 100;
  // Rounding the difference too (not just `sum`) absorbs binary
  // floating-point representation noise — e.g. 99.99 - 100 evaluates to
  // -0.010000000000005116 in IEEE 754, which would otherwise fail a
  // literal `> 0.01` check for a value the business tolerance is meant to
  // accept. This is a floating-point safety measure, not a change to the
  // ±0.01 business tolerance itself.
  const diffFromTarget = Math.round(Math.abs(sum - 100) * 1e6) / 1e6;
  if (diffFromTarget > SUM_TOLERANCE) {
    errors.push(
      `Product occurrence percentages must total 100%; current total is ${sum.toFixed(2)}%.`,
    );
  }

  return { valid: errors.length === 0, errors };
}

export interface OccurrenceFeasibilityResult {
  feasible: boolean;
  totalInvoiceCount: number;
  targets: Map<string, number>;
  totalTargetOccurrences: number;
  minRequiredInvoices: number;
  reason?: string;
}

/**
 * Sprint 1.7D — pure feasibility check: given a batch's occurrence
 * configuration and how many invoices will actually be generated, can the
 * resulting integer target occurrence counts (from calculateTargetOccurrences
 * — reused, not reimplemented) actually be represented?
 *
 * IMPORTANT — a mathematical fact worth documenting explicitly rather than
 * leaving implicit: because calculateTargetOccurrences guarantees
 * Σ targets === totalInvoiceCount exactly (Sprint 1.7B's Largest Remainder
 * apportionment), and validateOccurrenceConfiguration requires percentages
 * to sum to exactly 100% (Sprint 1.7C), it follows that
 * max(targets) <= totalInvoiceCount ALWAYS holds for any valid
 * configuration evaluated against the SAME totalInvoiceCount used to
 * compute those targets (if one target exceeded totalInvoiceCount, the
 * other non-negative targets could not possibly bring the sum back down to
 * totalInvoiceCount — a direct pigeonhole contradiction). So `feasible`
 * will always be `true` for any configuration that already passed Sprint
 * 1.7C's validation, when called the way this function is designed to be
 * called (products + the actual totalInvoiceCount, self-consistently).
 * This function still performs the check explicitly (per this sprint's
 * spec, §4) as a defensive invariant — protecting against any future
 * change to calculateTargetOccurrences that might violate the guarantee —
 * rather than being silently omitted as "impossible." See this sprint's
 * report for the full reasoning and how it was tested.
 *
 * Per §3/§10: the sum of per-product targets is NOT compared against
 * totalInvoiceCount anywhere in this function — that would be the wrong
 * rule (one invoice can carry many products at once, so the sum of
 * per-product occurrence targets is routinely larger than the invoice
 * count and that is completely normal). Only each INDIVIDUAL product's own
 * target is ever compared against totalInvoiceCount.
 */
export function checkOccurrenceFeasibility(
  products: ProductConfig[],
  totalInvoiceCount: number,
): OccurrenceFeasibilityResult {
  if (!Number.isInteger(totalInvoiceCount) || totalInvoiceCount < 0) {
    throw new Error(
      `totalInvoiceCount must be a non-negative integer (received: ${totalInvoiceCount}).`,
    );
  }

  // Per §7: reuse Sprint 1.7C's own definition of "valid configuration"
  // rather than inventing a second, feasibility-specific notion of
  // validity. An empty product list is VALID per Sprint 1.7C (it defers to
  // InvoiceEngine's own "No products found" guard) — that decision is
  // preserved here unchanged, not re-litigated.
  const configValidation = validateOccurrenceConfiguration(products);
  if (!configValidation.valid) {
    return {
      feasible: false,
      totalInvoiceCount,
      targets: new Map(),
      totalTargetOccurrences: 0,
      minRequiredInvoices: 0,
      reason: `Occurrence configuration is invalid, feasibility cannot be evaluated: ${configValidation.errors.join(" ")}`,
    };
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
    // The only way calculateTargetOccurrences can still throw here, given
    // configValidation already passed, is the empty-products + N>0 edge
    // case (Sprint 1.7C treats an empty list as VALID configuration, but
    // calculateTargetOccurrences — which has no concept of "defer to
    // InvoiceEngine's guard" — correctly refuses to allocate N invoices
    // across zero products). Reported as infeasible rather than left to
    // propagate as an uncaught exception, so a caller who already saw
    // configValidation.valid === true never gets an unexpected throw here.
    return {
      feasible: false,
      totalInvoiceCount,
      targets: new Map(),
      totalTargetOccurrences: 0,
      minRequiredInvoices: 0,
      reason: err?.message || "Unable to calculate target occurrences.",
    };
  }

  const evaluation = evaluateFeasibilityFromTargets(targets, totalInvoiceCount);

  return {
    feasible: evaluation.feasible,
    totalInvoiceCount,
    targets,
    totalTargetOccurrences: evaluation.totalTargetOccurrences,
    minRequiredInvoices: evaluation.minRequiredInvoices,
    reason: evaluation.reason,
  };
}

/**
 * The reusable comparison core of checkOccurrenceFeasibility, factored out
 * so it can be exercised directly against a hand-constructed target map —
 * this is what makes it possible to test the "target cannot exceed N" /
 * "sum(targets) > N is fine" invariants (§3, §10) in isolation, since (per
 * the doc comment on checkOccurrenceFeasibility above) those specific
 * conditions can never actually arise from calculateTargetOccurrences when
 * targets are computed self-consistently at the same totalInvoiceCount
 * being checked against.
 */
export function evaluateFeasibilityFromTargets(
  targets: Map<string, number>,
  totalInvoiceCount: number,
): {
  feasible: boolean;
  totalTargetOccurrences: number;
  minRequiredInvoices: number;
  reason?: string;
} {
  const totalTargetOccurrences = Array.from(targets.values()).reduce(
    (sum, v) => sum + v,
    0,
  );
  const minRequiredInvoices =
    targets.size === 0 ? 0 : Math.max(...targets.values());
  const feasible = totalInvoiceCount >= minRequiredInvoices;

  return {
    feasible,
    totalTargetOccurrences,
    minRequiredInvoices,
    reason: feasible
      ? undefined
      : `Product occurrence target(s) require at least ${minRequiredInvoices} invoice(s), but only ${totalInvoiceCount} were requested.`,
  };
}

// ── Sprint 1.7J — category + per-category occurrence validation ──────────

export type OccurrenceSemantics = "GLOBAL" | "CATEGORY" | null | undefined;

// Sprint 1.7K: category resolution now comes exclusively from the shared
// ProductCategoryService — CategoryName is kept as an alias so existing
// exported signatures in this file don't need to change.
export type CategoryName = ProductCategory;

export interface CategoryAllocation {
  Meat?: number;
  Fruits?: number;
}


export interface CategoryOccurrenceValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Category-aware occurrence configuration validator (Sprint 1.7J — Phase B
 * of the Sprint 1.7H design). Pure, deterministic, no I/O, no mutation.
 *
 * - occurrenceSemantics === "GLOBAL", or null/undefined (legacy/unset —
 *   NEVER auto-promoted to "CATEGORY"): delegates entirely to the
 *   existing validateOccurrenceConfiguration(products), unchanged,
 *   ignoring categoryAllocation completely — this is what keeps every
 *   pre-existing batch (category_allocation and occurrence_semantics both
 *   NULL, per Sprint 1.7I) validating exactly as it always has.
 * - occurrenceSemantics === "CATEGORY": requires categoryAllocation to be
 *   present, validates it (reusing validateOccurrenceConfiguration's own
 *   rules via two synthetic "Meat"/"Fruits" pseudo-products — no
 *   duplicated percentage-checking logic), checks the two approved
 *   contradiction rules (Sprint 1.7H §4), and validates each active
 *   category's own products sum to 100% independently (also via
 *   validateOccurrenceConfiguration, reused per category).
 *
 * This function only answers "is this configuration internally valid?" —
 * it never computes target counts, checks feasibility against an actual
 * invoice count, or touches stock/majors/8-line constraints. That is
 * explicitly out of scope (Sprint 1.7H Phases C onward).
 */
export function validateCategoryOccurrenceConfiguration(
  products: ProductConfig[],
  categoryAllocation: CategoryAllocation | null | undefined,
  occurrenceSemantics: OccurrenceSemantics,
): CategoryOccurrenceValidation {
  if (occurrenceSemantics !== "CATEGORY") {
    // GLOBAL and NULL/undefined (legacy) are treated identically —
    // existing global behavior, unchanged, categoryAllocation ignored.
    return validateOccurrenceConfiguration(products);
  }

  const errors: string[] = [];

  if (!categoryAllocation) {
    return {
      valid: false,
      errors: [
        "CATEGORY occurrence semantics requires category_allocation to be configured.",
      ],
    };
  }

  const meatPct = categoryAllocation.Meat ?? 0;
  const fruitsPct = categoryAllocation.Fruits ?? 0;

  // A. category_allocation itself — reuse validateOccurrenceConfiguration's
  // range/finite/sum-to-100%-within-±0.01 rules verbatim via two synthetic
  // pseudo-products, rather than reimplementing any of that logic here.
  const allocationValidation = validateOccurrenceConfiguration([
    { product_id: "Meat", product_name: "Meat", occurrencePercentage: meatPct } as ProductConfig,
    { product_id: "Fruits", product_name: "Fruits", occurrencePercentage: fruitsPct } as ProductConfig,
  ]);
  if (!allocationValidation.valid) {
    for (const e of allocationValidation.errors) {
      errors.push(`Category allocation: ${e}`);
    }
  }

  const productsByCategory = new Map<CategoryName, ProductConfig[]>();
  for (const p of products || []) {
    const cat = resolveProductCategory(p);
    if (!productsByCategory.has(cat)) productsByCategory.set(cat, []);
    productsByCategory.get(cat)!.push(p);
  }

  const allocationByCategory: Record<CategoryName, number> = {
    Meat: meatPct,
    Fruits: fruitsPct,
  };

  for (const category of ["Meat", "Fruits"] as CategoryName[]) {
    const pct = allocationByCategory[category];
    const productsInCategory = productsByCategory.get(category) || [];

    // RULE A: allocation is 0% but the category has selected products.
    if (pct === 0 && productsInCategory.length > 0) {
      errors.push(
        `${category}: allocated 0% of invoices, but ${productsInCategory.length} selected product(s) in this category have configured occurrence — they could never be satisfied.`,
      );
    }

    // RULE B: allocation is >0% but the category has no selected products.
    if (pct > 0 && productsInCategory.length === 0) {
      errors.push(
        `${category}: allocated ${pct}% of invoices, but no selected products belong to this category.`,
      );
    }

    // Per-category occurrence: this category's own products must sum to
    // 100% independently — reuse validateOccurrenceConfiguration again,
    // scoped to just this category's product subset. An empty subset
    // (category not in use at all) is already valid by
    // validateOccurrenceConfiguration's own established behavior
    // (Sprint 1.7C §7) and contributes no errors here.
    const categoryProductValidation = validateOccurrenceConfiguration(
      productsInCategory,
    );
    if (!categoryProductValidation.valid) {
      for (const e of categoryProductValidation.errors) {
        errors.push(`${category}: ${e}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
