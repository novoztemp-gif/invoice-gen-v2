import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import {
  roundMoney,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesProductConstraint,
} from "./types";

/**
 * Which product IDs actually changed between the edited invoice's original
 * (pre-edit) and new product lines — quantity, rate, or amount. A product
 * can legitimately appear more than once on the same invoice (two lines for
 * the same product, e.g. under different customers); matching by product_id
 * alone (ignoring how many times it appears, and in what order) would
 * compare the wrong pair of duplicate lines whenever counts or order don't
 * line up by coincidence, spuriously marking an untouched product as
 * "edited" — which then lets the whole redistribution pipeline freely move
 * that product's real quantity elsewhere in the batch. Every stage that
 * needs to know "what did the user actually edit" (the solver, the repair
 * fallback, the final validator, the engine's own bookkeeping) must use
 * this exact same definition, or they can disagree about scope.
 */
export function diffEditedProductIds(
  originalProducts: SalesLine[] | undefined,
  newProducts: SalesLine[],
): Set<string> {
  const affected = new Set<string>();

  const groupByPid = (lines: SalesLine[]): Map<string, SalesLine[]> => {
    const map = new Map<string, SalesLine[]>();
    for (const p of lines) {
      const arr = map.get(p.product_id) || [];
      arr.push(p);
      map.set(p.product_id, arr);
    }
    return map;
  };

  const origByPid = groupByPid(originalProducts || []);
  const newByPid = groupByPid(newProducts);
  const allPids = new Set([...origByPid.keys(), ...newByPid.keys()]);

  for (const pid of allPids) {
    const origLines = origByPid.get(pid) || [];
    const newLines = newByPid.get(pid) || [];
    if (origLines.length !== newLines.length) {
      affected.add(pid);
      continue;
    }
    for (let i = 0; i < origLines.length; i++) {
      const o = origLines[i];
      const n = newLines[i];
      if (
        Math.abs(o.quantity - n.quantity) > 0.001 ||
        Math.abs(o.rate - n.rate) > 0.001 ||
        Math.abs((o.amount || 0) - (n.amount || 0)) > 0.01
      ) {
        affected.add(pid);
        break;
      }
    }
  }

  return affected;
}

/**
 * Single shared answer to "how much of this product can this line grow by
 * right now?" — used by every decision point in the Sales edit/rebalance
 * pipeline (SalesCandidateGenerator's search candidates, SalesResidualRepair's
 * deterministic fallback, SalesNewInvoiceCreator's shortfall invoices) so
 * they can never disagree about what's actually allowed. Each caller used to
 * compute its own version of this, one constraint at a time, as bugs
 * surfaced — this folds all three real limits into one place:
 *  - the product's own configured quantityMax
 *  - the shared per-date/product stock ceiling (tracked across every
 *    invoice this run touches via SalesAllocationTracker)
 *  - the invoice's own headroom under the batch's maximum invoice amount
 */
export interface AddRoomResult {
  /** Max ADDITIONAL quantity (beyond the line's current quantity) that's safe to add. */
  room: number;
  /** Which constraint(s) are the binding limit — for building real diagnostics instead of a generic error. */
  blockedBy: string[];
}

export function computeAddRoom(params: {
  currentQuantity: number;
  currentAmount: number;
  invoiceTotalAmount: number;
  rate: number;
  constraint?: SalesProductConstraint;
  thresholdMax?: number;
  stockCeiling: number;
  stockAlreadyUsed: number;
}): AddRoomResult {
  const {
    currentQuantity,
    currentAmount,
    invoiceTotalAmount,
    rate,
    constraint,
    thresholdMax,
    stockCeiling,
    stockAlreadyUsed,
  } = params;

  const qtyMaxRoom = constraint
    ? Math.max(0, constraint.quantityMax - currentQuantity)
    : Number.POSITIVE_INFINITY;

  const stockRoom =
    stockCeiling === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(0, stockCeiling - stockAlreadyUsed);

  let budgetRoom = Number.POSITIVE_INFINITY;
  if (thresholdMax && thresholdMax > 0 && rate > 0) {
    const otherLinesTotal = roundMoney(invoiceTotalAmount - currentAmount);
    const maxAllowedForLine = Math.max(0, thresholdMax - otherLinesTotal);
    const amountRoom = Math.max(0, maxAllowedForLine - currentAmount);
    budgetRoom = amountRoom / rate;
  }

  const room = Math.max(0, Math.min(qtyMaxRoom, stockRoom, budgetRoom));

  const blockedBy: string[] = [];
  if (room < Number.POSITIVE_INFINITY) {
    if (stockRoom <= qtyMaxRoom && stockRoom <= budgetRoom) blockedBy.push("stock");
    if (budgetRoom <= qtyMaxRoom && budgetRoom <= stockRoom) blockedBy.push("invoiceCap");
    if (qtyMaxRoom <= stockRoom && qtyMaxRoom <= budgetRoom && constraint) {
      blockedBy.push("productQuantityMax");
    }
  }

  return { room, blockedBy };
}

/**
 * How much of `requestedReduction` can actually come off this line. A
 * partial take is never allowed to strand the line's quantity between 0 and
 * its configured minimum — either the full amount comes off (down to 0) or
 * it's capped so exactly quantityMin remains, whatever's left over must be
 * sourced elsewhere.
 */
export function resolveReduction(
  currentQuantity: number,
  requestedReduction: number,
  constraint?: SalesProductConstraint,
): number {
  const minQty = constraint?.quantityMin ?? 0;
  let takeAmount = roundToQuarterIncrement(
    Math.min(requestedReduction, currentQuantity),
  );
  const remainAfter = roundToQuarterIncrement(currentQuantity - takeAmount);
  if (remainAfter > 0.001 && remainAfter < minQty) {
    takeAmount = roundToQuarterIncrement(Math.max(0, currentQuantity - minQty));
  }
  return takeAmount;
}

/**
 * A template SalesLine (product_name, hsn_code, unit_of_measure, category)
 * for each edited product ID, used to synthesize a brand-new line when an
 * edit needs to ADD a product to an invoice that doesn't currently carry it
 * at all. Preference order: the edited invoice's own new/old line for that
 * product (guaranteed complete/correct), then any other invoice in the
 * batch that happens to carry it.
 */
export function buildProductTemplates(
  context: SalesBalanceContext,
  editedInvoice: SalesInvoice,
  origEditedInvoice: SalesInvoice | undefined,
  pids: Set<string>,
): Map<string, SalesLine> {
  const templates = new Map<string, SalesLine>();
  const consider = (lines: SalesLine[] | undefined) => {
    for (const line of lines || []) {
      if (pids.has(line.product_id) && !templates.has(line.product_id)) {
        templates.set(line.product_id, line);
      }
    }
  };
  consider(editedInvoice.products);
  consider(origEditedInvoice?.products);
  for (const inv of context.invoices) {
    if (templates.size === pids.size) break;
    consider(inv.products);
  }
  return templates;
}

/**
 * Tracks the shared per-date/product stock ceiling and how much of it has
 * been committed so far during a single edit run. One instance is built
 * once per edit (via `.build`), then `.fork()`ed wherever a decision point
 * needs to explore multiple possibilities without mutating the shared
 * baseline (e.g. the solver's priority-queue search branches).
 */
export class SalesAllocationTracker {
  private constructor(
    private readonly ceilings: Map<string, number>,
    private running: Map<string, number>,
  ) {}

  private static key(date: string, pid: string): string {
    return `${date}_${pid}`;
  }

  /**
   * `context.availableStockMap` already nets out everything currently sold
   * batch-wide, so the real ceiling for a date/product this edit is allowed
   * to redistribute across is: available stock + however much the invoices
   * THIS EDIT IS TOUCHING (editedInvoice + balancingInvoices, in their
   * ORIGINAL pre-edit state) already held there. Adding back the whole
   * batch's original total would double-count invoices this edit never
   * touches, which are already netted out of availableStockMap.
   */
  static build(
    context: SalesBalanceContext,
    touchedOriginalInvoices: SalesInvoice[],
    pids: Set<string>,
  ): SalesAllocationTracker {
    const ceilings = new Map<string, number>();

    // Seed a ceiling for EVERY ledger-backed date this product has stock
    // data for — not just dates a touched invoice already happens to hold
    // the product on. Balancing invoices can now be ANY invoice in the
    // batch (including ones that don't currently carry the edited product
    // at all, e.g. adding it as a brand-new line), so a date can gain a
    // brand-new allocation with no pre-existing touched-invoice entry to
    // seed from. Without this, such a date/product pair fell back to the
    // "no ceiling" (Infinity) default further down, silently skipping the
    // real per-day stock check.
    for (const pid of pids) {
      const suffix = `_${pid}`;
      for (const [key, avail] of context.availableStockMap.entries()) {
        if (key.endsWith(suffix)) {
          ceilings.set(key, avail);
        }
      }
    }

    for (const inv of touchedOriginalInvoices) {
      for (const p of inv.products) {
        if (!pids.has(p.product_id)) continue;
        const key = SalesAllocationTracker.key(inv.invoice_date, p.product_id);
        if (!ceilings.has(key)) {
          // No ledger entry at all for this date/product — unconstrained,
          // consistent with how missing availableStockMap entries are
          // treated everywhere else (e.g. SalesFinalValidator Rule 8).
          ceilings.set(key, Number.POSITIVE_INFINITY);
        }
        const cur = ceilings.get(key)!;
        if (cur !== Number.POSITIVE_INFINITY) {
          ceilings.set(key, cur + p.quantity);
        }
      }
    }
    return new SalesAllocationTracker(ceilings, new Map());
  }

  // Per-date stock ceiling is intentionally NOT enforced during edits. Once
  // a batch is generated, the daily_stock_ledger's day-by-day breakdown is
  // no longer treated as a hard constraint on rebalancing — a product can
  // be freely moved to any date/invoice in the batch. The only thing that
  // must still hold exactly is the product's TOTAL quantity across the
  // whole batch (enforced separately via context.originalProductTotals /
  // SalesFinalValidator's Rule 7). These two methods are kept as no-ops
  // (rather than deleting every call site) so `ceilings`/`build` above stay
  // available if per-date enforcement is ever reinstated.
  hasCeiling(_date: string, _pid: string): boolean {
    return false;
  }

  ceilingFor(_date: string, _pid: string): number {
    return Number.POSITIVE_INFINITY;
  }

  usedFor(date: string, pid: string): number {
    return this.running.get(SalesAllocationTracker.key(date, pid)) || 0;
  }

  record(date: string, pid: string, qty: number): void {
    const key = SalesAllocationTracker.key(date, pid);
    this.running.set(key, (this.running.get(key) || 0) + qty);
  }

  fork(): SalesAllocationTracker {
    return new SalesAllocationTracker(this.ceilings, new Map(this.running));
  }
}
