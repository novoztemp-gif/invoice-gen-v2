/**
 * Sprint 1.7K — the ONE authoritative product-category resolver.
 *
 * Previously, InvoiceEngine.getProductCategory (private) and
 * ProductOccurrenceService.resolveProductCategoryForValidation (a
 * deliberately narrower, documented stand-in — see Sprint 1.7J's report)
 * were two separate implementations of "what category is this product."
 * This module is the single source of truth both now delegate to, so
 * generation and occurrence validation can never again classify the same
 * product differently.
 *
 * This is a leaf module: it imports nothing from InvoiceEngine.ts or
 * ProductOccurrenceService.ts (and never will), so both of those files can
 * depend on it without any risk of a circular import.
 *
 * Business meaning of the two categories is unchanged — this is a pure
 * relocation of existing logic, not a redesign.
 */

export type ProductCategory = "Meat" | "Fruits";

/**
 * Resolves a product's category, in exactly this precedence order (moved
 * verbatim from InvoiceEngine.getProductCategory, comments included,
 * behavior byte-for-byte identical):
 *
 * 1. Explicit `category` or `category_name` field, case-insensitive,
 *    trimmed — trusted first, since the `products` table's own `category`
 *    column is schema-constrained to exactly 'Meat' | 'Fruits'.
 * 2. Product-name keyword fallback for Fruits, then Meat — a last-resort
 *    heuristic for the rare case the explicit field is genuinely missing.
 * 3. Final default: "Fruits" if the (empty, since we only reach here when
 *    step 1 found nothing) explicit-category string happens to contain
 *    "FRUIT", otherwise "Meat".
 */
export function resolveProductCategory(p: any): ProductCategory {
  // The products table's own `category` column (constrained to exactly
  // 'Meat' | 'Fruits' by schema) is the real source of truth — trust it
  // first. Name-based guessing is a last-resort fallback for the rare
  // case that field is genuinely missing, and previously ran BEFORE this
  // check, which meant a product with a perfectly valid category could
  // still get silently overridden by a keyword match (or, far more often
  // for this catalog, fall through both keyword lists — YAMS, SEER,
  // GOOSEBERRY, SAPOTA, POMFRET etc. match neither — straight into a
  // hardcoded "Meat" default regardless of what it actually was).
  const explicitCategory = String(p?.category || p?.category_name || "")
    .trim()
    .toUpperCase();
  if (explicitCategory === "FRUITS") return "Fruits";
  if (explicitCategory === "MEAT") return "Meat";

  const name = String(p?.product_name || "").toUpperCase();
  if (
    /APPLE|BANANA|BLUEBERRY|CUSTARD APPLE|KIWI|LYCHEE|CHERRY|FIG|ORANGE|GRAPE|MANGO|PEACH|PEAR|PLUM|WATERMELON|PINEAPPLE|PAPAYA|FRUIT/i.test(
      name,
    )
  ) {
    return "Fruits";
  }
  if (
    /CHICKEN|GOAT|DUCK|CLAM|FISH|MACKEREL|MUSSEL|OYSTER|CRAB|SHRIMP|MEAT/i.test(
      name,
    )
  ) {
    return "Meat";
  }
  return explicitCategory.includes("FRUIT") ? "Fruits" : "Meat";
}
