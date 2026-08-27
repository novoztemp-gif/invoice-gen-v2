/**
 * Single source of truth for stock quantity calculations against
 * daily_stock_ledger data.
 *
 * The business rule (Sprint 1.2 architecture decision) is a day-by-day
 * chronological recurrence, not an aggregate:
 *
 *   available(day) = opening(day) + purchased(day)
 *   closing(day)   = max(0, available(day) - sold(day))
 *   opening(day+1) = closing(day)
 *
 * This is intentionally NOT the same as either of the two anti-patterns
 * this service replaces:
 *
 *   - `max(0, totalPurchased - totalSold)` (sum first, clamp once) is only
 *     equivalent to the chronological recurrence when stock never
 *     genuinely runs out mid-sequence — if it does (a real oversell
 *     anomaly, e.g. from a data-integrity bug), the aggregate form hides
 *     *that* it happened and nets it against unrelated days instead of
 *     containing it at the day it occurred.
 *   - `max(0, purchased_row - sold_row)` computed independently per row
 *     and then summed is wrong on its own terms: a day legitimately sells
 *     more than it purchased THAT day whenever it's selling from stock
 *     carried over from earlier days (the normal case), and clamping each
 *     row in isolation silently forgives that carried-over consumption,
 *     inflating the total.
 *
 * Every caller that needs "remaining/available/carry-forward stock" from
 * daily_stock_ledger rows should go through this module rather than
 * reimplementing the recurrence.
 */

export interface StockLedgerRow {
  product_id: string;
  ledger_date: string;
  opening_stock?: number | string | null;
  purchased_quantity?: number | string | null;
  sold_quantity?: number | string | null;
  [key: string]: unknown;
}

export interface DailyStockState {
  product_id: string;
  ledger_date: string;
  opening: number;
  purchased: number;
  available: number;
  sold: number;
  closing: number;
}

/** Missing purchased_quantity/sold_quantity/opening_stock are treated as 0. */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Groups rows by product_id and sorts each group chronologically by
 * ledger_date (ascending) — the recurrence is meaningless unless applied
 * in date order, and callers cannot be trusted to have already sorted
 * (rows commonly arrive from paginated, unordered, or multi-batch
 * queries).
 */
function groupSortedByProduct(
  rows: StockLedgerRow[],
): Map<string, StockLedgerRow[]> {
  const grouped = new Map<string, StockLedgerRow[]>();
  for (const row of rows) {
    if (!row || !row.product_id) continue;
    const list = grouped.get(row.product_id);
    if (list) {
      list.push(row);
    } else {
      grouped.set(row.product_id, [row]);
    }
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => String(a.ledger_date).localeCompare(String(b.ledger_date)));
  }
  return grouped;
}

/**
 * (A) Full chronological daily calculation.
 *
 * Returns the day-by-day stock state for every product present in `rows`,
 * in chronological order per product. Each product's own first row's
 * `opening_stock` is respected as the seed (real carry-in from before
 * this data started); every subsequent day's opening is the PREVIOUS
 * day's computed closing, not that row's own stored opening_stock field
 * — the stored field is authoritative only for day 1, since day 2+'s
 * opening is, by the business rule, defined to equal the prior day's
 * closing, and trusting the computed chain over a possibly-stale stored
 * value is what makes this self-correcting.
 *
 * Never sums purchased/sold across rows and never clamps a single row's
 * purchased-minus-sold in isolation — see the module-level comment for
 * why both of those are wrong.
 */
export function computeDailyChronologicalStock(
  rows: StockLedgerRow[],
): DailyStockState[] {
  const grouped = groupSortedByProduct(rows);
  const result: DailyStockState[] = [];

  for (const [productId, sortedRows] of grouped.entries()) {
    let carry = 0;
    sortedRows.forEach((row, idx) => {
      const opening = idx === 0 ? toNumber(row.opening_stock) : carry;
      const purchased = toNumber(row.purchased_quantity);
      const sold = toNumber(row.sold_quantity);
      const available = opening + purchased;
      const closing = Math.max(0, available - sold);

      result.push({
        product_id: productId,
        ledger_date: String(row.ledger_date),
        opening,
        purchased,
        available,
        sold,
        closing,
      });

      carry = closing;
    });
  }

  return result;
}

/**
 * (B) Final closing stock per product — the last chronological day's
 * `closing` value for each product_id present in `rows`. This is what
 * "how much is left" means under the chronological business rule.
 */
export function getFinalClosingStockByProduct(
  rows: StockLedgerRow[],
): Map<string, number> {
  const daily = computeDailyChronologicalStock(rows);
  const finalByProduct = new Map<string, number>();
  // `daily` is grouped and chronologically ordered per product, so the
  // last entry encountered for a given product_id is its final closing.
  for (const day of daily) {
    finalByProduct.set(day.product_id, day.closing);
  }
  return finalByProduct;
}

/**
 * Convenience overload of (B) for a single product's own rows (rows
 * already filtered/known to belong to one product_id). Returns 0 for an
 * empty input, matching the "missing data treated as 0" rule.
 */
export function getFinalClosingStockForProduct(
  rows: StockLedgerRow[],
): number {
  const daily = computeDailyChronologicalStock(rows);
  if (daily.length === 0) return 0;
  return daily[daily.length - 1].closing;
}

/**
 * (C) Carry-forward calculation — the correct carry-forward stock per
 * product, using the exact same chronological recurrence as (A)/(B).
 * "Carry-forward stock" and "final closing stock" are the same quantity
 * under the chronological business rule (today's carry-forward IS
 * yesterday's closing), so this is a thin, non-duplicating alias over
 * getFinalClosingStockByProduct — kept as its own named export because
 * callers reason about it as a distinct concept ("what carries into the
 * next batch/period"), not because the math differs.
 */
export function getCarryForwardStockByProduct(
  rows: StockLedgerRow[],
): Map<string, number> {
  return getFinalClosingStockByProduct(rows);
}

/**
 * (Sprint 1.3B) Server-side stock conservation enforcement.
 *
 * A proposed sale — a set of (product_id, ledger_date, quantity) lines,
 * e.g. every line about to be inserted for a new Sales batch — is valid
 * only if, for every (ledger_date, product_id) it touches, the total
 * requested quantity does not exceed that day's chronological `closing`
 * (opening + purchased, minus whatever is ALREADY recorded as sold for
 * that exact row — from this or any other Sales batch sharing the same
 * stock source). This is the same recurrence as everywhere else in this
 * service; nothing here recomputes stock a different way, it only adds a
 * pass/fail judgment on top of it.
 *
 * Negative quantities are rejected outright and separately from the
 * capacity check — a negative request isn't "under capacity", it's
 * invalid input.
 */
export interface ProposedSaleLine {
  product_id: string;
  ledger_date: string;
  quantity: number;
}

export interface StockConservationViolation {
  product_id: string;
  ledger_date: string;
  requested: number;
  available: number;
}

export interface StockConservationResult {
  valid: boolean;
  violations: StockConservationViolation[];
  negativeQuantityLines: ProposedSaleLine[];
}

export function validateStockConservation(
  ledgerRows: StockLedgerRow[],
  proposedLines: ProposedSaleLine[],
): StockConservationResult {
  const negativeQuantityLines = proposedLines.filter(
    (line) => Number(line.quantity) < 0,
  );

  const daily = computeDailyChronologicalStock(ledgerRows);
  const capacityByKey = new Map<string, number>();
  for (const day of daily) {
    capacityByKey.set(`${day.ledger_date}_${day.product_id}`, day.closing);
  }

  const requestedByKey = new Map<string, number>();
  for (const line of proposedLines) {
    if (Number(line.quantity) < 0) continue; // captured separately above
    const key = `${line.ledger_date}_${line.product_id}`;
    requestedByKey.set(
      key,
      (requestedByKey.get(key) || 0) + Number(line.quantity || 0),
    );
  }

  const violations: StockConservationViolation[] = [];
  for (const [key, requested] of requestedByKey.entries()) {
    const sepIdx = key.indexOf("_");
    const ledgerDate = key.slice(0, sepIdx);
    const productId = key.slice(sepIdx + 1);
    const available = capacityByKey.get(key) || 0;
    if (requested > available + 0.001) {
      violations.push({
        product_id: productId,
        ledger_date: ledgerDate,
        requested,
        available,
      });
    }
  }

  return {
    valid: violations.length === 0 && negativeQuantityLines.length === 0,
    violations,
    negativeQuantityLines,
  };
}
