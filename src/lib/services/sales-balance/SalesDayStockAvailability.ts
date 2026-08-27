import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import {
  computeDailyChronologicalStock,
  StockLedgerRow,
} from "@/lib/services/StockCalculationService";
import { SalesBalanceContext } from "./types";

/**
 * How much of each product was PHYSICALLY on hand at the start of one
 * specific day, plus that day's own purchases — i.e. `available(day)` in
 * StockCalculationService's chronological recurrence:
 * `available(day) = opening(day) + purchased(day)`,
 * `opening(day) = closing(day-1)`.
 *
 * Deliberately NOT a direct read of the stored `opening_stock` column for
 * that single day's row: StockCalculationService's own documented rule is
 * that the stored value is only authoritative for a ledger's very FIRST
 * row — every later day's true opening balance is the previous day's
 * chronologically-computed closing (which nets out `sold_quantity`).
 * Reading the raw column directly (an earlier version of this function
 * did) ignores every prior day's sales entirely, silently overstating
 * what's actually left — confirmed as the real cause of a production
 * overstock rejection (invoice edit accepted at the day-cap, then the
 * batch-wide ceiling check correctly caught the oversell downstream).
 *
 * `available(day)` (not `closing(day)`) is deliberately what's returned
 * here: it nets out every day BEFORE the target date, but leaves the
 * target date's OWN `sold_quantity` out of it, since that column can be
 * stale relative to an in-flight edit. "Already consumed today" is
 * instead computed live in `computeAvailableForEdit` below, straight from
 * currently-persisted invoices — not from this possibly-stale column.
 */
export async function loadDayAvailability(
  supabase: SupabaseClient,
  stockSourceBatchIds: string[],
  date: string,
): Promise<Map<string, number>> {
  const staticAvailable = new Map<string, number>();
  if (stockSourceBatchIds.length === 0 || !date) return staticAvailable;

  // The full ledger, not just this one date — the chronological chain
  // needs every prior day to correctly compute what's really left going
  // into `date`.
  const rows = await fetchAllQueryRows((from, to) =>
    supabase
      .from("daily_stock_ledger")
      .select("product_id, ledger_date, opening_stock, purchased_quantity, sold_quantity")
      .in("purchase_batch_id", stockSourceBatchIds)
      .order("ledger_date", { ascending: true })
      .range(from, to),
  );

  const dailyStock = computeDailyChronologicalStock(
    (rows || []) as StockLedgerRow[],
  );
  for (const day of dailyStock) {
    if (day.ledger_date !== date) continue;
    const prev = staticAvailable.get(day.product_id) || 0;
    staticAvailable.set(day.product_id, prev + day.available);
  }
  return staticAvailable;
}

/**
 * What's actually free to use TODAY, for editing one specific invoice: the
 * static day-level stock (above) minus whatever every OTHER invoice already
 * dated the same day currently holds. The edited invoice's own current
 * holding is deliberately excluded from "already consumed" — it's being
 * replaced, not added on top of — so keeping a product's quantity exactly
 * the same always trivially fits, and only a genuine net increase can ever
 * be rejected.
 *
 * A product with no static-availability entry at all (no `daily_stock_ledger`
 * row for this exact day) resolves to 0 here (via the `|| 0` at each call
 * site, not by pre-populating every possible product ID) — confirmed
 * policy: missing data blocks any increase rather than treating it as
 * unconstrained, matching "never exceed the batch total, no exceptions."
 */
export function computeAvailableForEdit(
  context: SalesBalanceContext,
  staticAvailable: Map<string, number>,
  date: string,
  excludeInvoiceId: string,
): Map<string, number> {
  const consumedByOthers = new Map<string, number>();
  for (const inv of context.invoices) {
    if (inv.id === excludeInvoiceId) continue;
    if (inv.invoice_date !== date) continue;
    for (const p of inv.products) {
      if (!p.product_id) continue;
      consumedByOthers.set(
        p.product_id,
        (consumedByOthers.get(p.product_id) || 0) + p.quantity,
      );
    }
  }

  const result = new Map<string, number>();
  const allPids = new Set([
    ...staticAvailable.keys(),
    ...consumedByOthers.keys(),
  ]);
  for (const pid of allPids) {
    const avail = staticAvailable.get(pid) || 0;
    const consumed = consumedByOthers.get(pid) || 0;
    result.set(pid, Math.max(0, avail - consumed));
  }
  return result;
}

/**
 * The editable pool for one day: the day's total physical stock minus
 * whatever's already permanently reserved by Major Customer invoices
 * (never touchable, never an edit target — see SalesDayScopedEditEngine).
 * This is what the UI shows as "available stock" — a bigger, more useful
 * reference figure than computeAvailableForEdit's "genuinely unclaimed
 * right now" number, since a day-scoped edit can also redistribute
 * quantity between regular (non-major) invoices, not just draw on
 * leftover. Confirmed with the user: display the theoretical ceiling,
 * let save-time validation decide whether a specific edit is actually
 * possible ("only if possible").
 */
export function computeEditableDayPool(
  context: SalesBalanceContext,
  staticAvailable: Map<string, number>,
  date: string,
): Map<string, number> {
  const majorConsumed = new Map<string, number>();
  for (const inv of context.invoices) {
    if (inv.invoice_date !== date) continue;
    const partyId = inv.products?.[0]?.customer_id;
    if (!partyId || !context.majorCustomerIds.has(partyId)) continue;
    for (const p of inv.products) {
      if (!p.product_id) continue;
      majorConsumed.set(
        p.product_id,
        (majorConsumed.get(p.product_id) || 0) + p.quantity,
      );
    }
  }

  const result = new Map<string, number>();
  const allPids = new Set([...staticAvailable.keys(), ...majorConsumed.keys()]);
  for (const pid of allPids) {
    const avail = staticAvailable.get(pid) || 0;
    const reserved = majorConsumed.get(pid) || 0;
    result.set(pid, Math.max(0, avail - reserved));
  }
  return result;
}
