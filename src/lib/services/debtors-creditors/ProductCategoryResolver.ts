import type { SupabaseClient } from "@supabase/supabase-js";
import { MonthlySplitUpProduct } from "@/lib/services/monthly-splitup/types";
import { PartnerCategory, ResolvedSplitUpProduct } from "./types";

function isPartnerCategory(value: unknown): value is PartnerCategory {
  return value === "Meat" || value === "Fruits";
}

/**
 * Resolves each uploaded product row's category (Meat/Fruits) against the
 * app's own `products` catalog — exact `hsn_code` match first, falling back
 * to a case-insensitive trimmed `product_name` match. Rows that match
 * neither come back with `category: null` — the caller is expected to
 * offer a manual Meat/Fruits picker for those before allocation can run.
 */
export async function resolveProductCategories(
  supabase: SupabaseClient,
  products: MonthlySplitUpProduct[],
): Promise<ResolvedSplitUpProduct[]> {
  const { data, error } = await supabase
    .from("products")
    .select("hsn_code, product_name, category");

  if (error) {
    throw new Error(`Failed to load the products catalog: ${error.message}`);
  }

  const byHsn = new Map<string, PartnerCategory>();
  const byName = new Map<string, PartnerCategory>();
  for (const row of data ?? []) {
    if (!isPartnerCategory(row.category)) continue;
    const hsn = String(row.hsn_code ?? "").trim();
    if (hsn) byHsn.set(hsn, row.category);
    const name = String(row.product_name ?? "").trim().toLowerCase();
    if (name) byName.set(name, row.category);
  }

  return products.map((p) => {
    const hsnKey = p.hsnCode.trim();
    const nameKey = p.description.trim().toLowerCase();

    const hsnMatch = byHsn.get(hsnKey);
    if (hsnMatch) {
      return { ...p, category: hsnMatch, categorySource: "hsn-match" };
    }

    const nameMatch = byName.get(nameKey);
    if (nameMatch) {
      return { ...p, category: nameMatch, categorySource: "name-match" };
    }

    return { ...p, category: null, categorySource: "unmatched" };
  });
}
