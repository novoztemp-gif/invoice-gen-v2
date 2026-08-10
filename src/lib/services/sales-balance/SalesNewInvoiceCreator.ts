import { randomUUID } from "crypto";
import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import { computeAddRoom, SalesAllocationTracker } from "./SalesLineCapacity";
import {
  roundMoney,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesSolverPlan,
} from "./types";

export interface NewInvoiceCreationResult {
  newInvoices: SalesInvoice[];
  remainingProductDeltas: Map<string, number>;
  /** Why each still-unresolved product couldn't be placed — for building a real diagnostic instead of a generic error. */
  blockedReasons: Map<string, Set<string>>;
}

/**
 * Last-resort fallback for the Sales edit/rebalance pipeline, mirroring
 * Purchase's `ProductQuantityConservation` Priority 3: when a reduced
 * product quantity can't be fully absorbed by other EXISTING invoices
 * (the solver + SalesResidualRepair both gave up), spin up brand-new
 * invoice(s) to hold the surplus rather than leaving it unaccounted for.
 *
 * Only ever runs in the "need to ADD quantity somewhere" direction — an
 * increase on the edited invoice is always sourced by reducing that same
 * product on an EXISTING invoice (already handled upstream), never by
 * creating a new one, since there's nothing to "pull" from a brand-new
 * invoice.
 *
 * Every new invoice holds exactly ONE line: the edited product, and only
 * the edited product — never any other product, and never more than the
 * real remaining `daily_stock_ledger` availability for its date.
 */
export class SalesNewInvoiceCreator {
  public static createInvoicesForShortfall(
    context: SalesBalanceContext,
    plan: SalesSolverPlan,
  ): NewInvoiceCreationResult {
    const newInvoices: SalesInvoice[] = [];
    const remainingProductDeltas = new Map(plan.productDeltas);
    const blockedReasons = new Map<string, Set<string>>();
    const addBlockedReason = (pid: string, reason: string) => {
      if (!blockedReasons.has(pid)) blockedReasons.set(pid, new Set());
      blockedReasons.get(pid)!.add(reason);
    };

    const productsNeedingNewInvoice = Array.from(
      remainingProductDeltas.entries(),
    ).filter(([, delta]) => delta > 0.001);

    if (productsNeedingNewInvoice.length === 0) {
      return { newInvoices, remainingProductDeltas, blockedReasons };
    }

    // Invoice numbering: parse the shared prefix from an existing invoice
    // number and find the true next sequence — same approach as Purchase's
    // AutoBalanceEngine.getNextInvoiceNumbering.
    const sampleNumber = context.invoices.find(
      (inv) => inv.invoice_number,
    )?.invoice_number;
    const prefix = (sampleNumber || "").split("-").slice(0, -1).join("-");
    let nextSequence = 1;
    for (const inv of context.invoices) {
      const parts = (inv.invoice_number || "").split("-");
      const seq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(seq) && seq >= nextSequence) nextSequence = seq + 1;
    }

    // Candidate customers: anyone already appearing somewhere in this
    // batch (not fetched from the batch's full configured customer list —
    // matches Purchase's supplierCategoryMap, which is also built purely
    // from the batch's own existing invoices). Major customers are never
    // touched by rebalancing.
    const candidateCustomers = Array.from(
      new Set(
        context.invoices
          .flatMap((inv) => inv.products)
          .map((p) => p.customer_id)
          .filter(
            (cId): cId is string =>
              !!cId && !context.majorCustomerIds.has(cId),
          ),
      ),
    ).sort();

    // Dates to try: the edited invoice's own date first (keeps the new
    // invoice visually close to the edit), then every other date present
    // in the batch.
    const allBatchDates = new Set<string>();
    for (const inv of context.invoices) {
      if (inv.invoice_date) allBatchDates.add(inv.invoice_date);
    }
    const targetDate = plan.editedInvoice.invoice_date;
    const candidateDates = [
      targetDate,
      ...Array.from(allBatchDates)
        .filter((d) => d !== targetDate)
        .sort(),
    ];

    // Which customer already has an invoice on which date — seeded from
    // the current plan (edited + balancing invoices), extended as new
    // invoices get created this run.
    const usedCustomersForDate = new Map<string, Set<string>>();
    const markUsed = (date: string, customerId?: string) => {
      if (!date || !customerId) return;
      if (!usedCustomersForDate.has(date)) {
        usedCustomersForDate.set(date, new Set());
      }
      usedCustomersForDate.get(date)!.add(customerId);
    };
    for (const inv of [plan.editedInvoice, ...plan.balancingInvoices]) {
      for (const p of inv.products) markUsed(inv.invoice_date, p.customer_id);
    }

    // Shared capacity tracker — same one SalesCandidateSolver and
    // SalesResidualRepair use, so a brand-new invoice created here can never
    // disagree with what those stages already decided was available. Seeded
    // from the ORIGINAL (pre-edit) state of the invoices this edit touches,
    // then primed with the CURRENT (already-decided) quantities of the plan
    // entering this step — how much of each date/product is already spoken
    // for by the edited invoice + balancing invoices.
    const relevantPids = new Set(
      productsNeedingNewInvoice.map(([pid]) => pid),
    );
    const origEditedInv = context.invoices.find(
      (i) => i.id === plan.editedInvoice.id,
    );
    const touchedOriginalInvoices = [
      ...(origEditedInv ? [origEditedInv] : []),
      ...plan.balancingInvoices
        .map((inv) => context.invoices.find((i) => i.id === inv.id))
        .filter((inv): inv is SalesInvoice => !!inv),
    ];
    const tracker = SalesAllocationTracker.build(
      context,
      touchedOriginalInvoices,
      relevantPids,
    );
    for (const inv of [plan.editedInvoice, ...plan.balancingInvoices]) {
      for (const p of inv.products) {
        if (relevantPids.has(p.product_id)) {
          tracker.record(inv.invoice_date, p.product_id, p.quantity);
        }
      }
    }

    for (const [productId, deltaNeeded] of productsNeedingNewInvoice) {
      let remaining = deltaNeeded;
      const constraint = context.constraints.get(productId);
      if (!constraint) continue;

      const referenceLine = context.invoices
        .flatMap((inv) => inv.products)
        .find((p) => p.product_id === productId);
      const rate = roundToWholeInteger(
        Math.min(
          constraint.rateMax,
          Math.max(
            constraint.rateMin,
            referenceLine?.rate ||
              Math.round((constraint.rateMin + constraint.rateMax) / 2),
          ),
        ),
      );

      outerDates: for (const date of candidateDates) {
        if (remaining <= 0.001) break;
        const usedForDate = usedCustomersForDate.get(date) || new Set();
        const eligibleCustomers = candidateCustomers.filter(
          (c) => !usedForDate.has(c),
        );

        for (const customerId of eligibleCustomers) {
          if (remaining <= 0.001) break outerDates;

          // Per-date stock availability is no longer a constraint once the
          // batch is generated — only the product's overall batch-wide
          // quantity total matters (enforced elsewhere). Same shared
          // capacity calculation as every other decision point still
          // applies for product quantity max and invoice ₹ cap.
          const { room, blockedBy } = computeAddRoom({
            currentQuantity: 0,
            currentAmount: 0,
            invoiceTotalAmount: 0,
            rate,
            constraint,
            thresholdMax: context.thresholdMax,
            stockCeiling: tracker.ceilingFor(date, productId),
            stockAlreadyUsed: tracker.usedFor(date, productId),
          });
          if (room <= 0) {
            for (const reason of blockedBy) {
              addBlockedReason(
                productId,
                reason === "stock"
                  ? `no stock room left on ${date}`
                  : reason === "invoiceCap"
                    ? `no room under the batch's maximum invoice amount on ${date}`
                    : `at product's configured maximum quantity`,
              );
            }
            continue;
          }

          const qty = roundToQuarterIncrement(Math.min(remaining, room));
          if (qty < constraint.quantityMin) {
            addBlockedReason(
              productId,
              `remaining room on ${date} (${room}) is below the product's minimum order quantity (${constraint.quantityMin})`,
            );
            continue;
          }

          const amount = computeLineAmount(qty, rate);
          const newInvoiceNumber = `${prefix}-${String(
            nextSequence++,
          ).padStart(7, "0")}`;

          const line: SalesLine = {
            product_id: productId,
            product_name: referenceLine?.product_name,
            hsn_code: referenceLine?.hsn_code,
            unit_of_measure: constraint.unitOfMeasure,
            category: constraint.category,
            quantity: qty,
            rate,
            amount,
            customer_id: customerId,
          };

          newInvoices.push({
            id: randomUUID(),
            invoice_batch_id: plan.editedInvoice.invoice_batch_id,
            invoice_number: newInvoiceNumber,
            invoice_date: date,
            products: [line],
            total_amount: amount,
            transport_mode: plan.editedInvoice.transport_mode,
            vehicle_number: plan.editedInvoice.vehicle_number,
            date_of_supply: plan.editedInvoice.date_of_supply,
          });

          markUsed(date, customerId);
          tracker.record(date, productId, qty);
          remaining = roundToQuarterIncrement(remaining - qty);
        }
      }

      remainingProductDeltas.set(productId, roundToQuarterIncrement(remaining));
    }

    // A quantity delta closed via new invoices moves real money too (the
    // new invoice's own amount) — but that amount is computed from the
    // representative rate above, which may not land on the exact rupee
    // still needed to close plan.batchDelta. Nudge the LAST new invoice's
    // own line rate (same product, same invoice — never a different
    // product) within its valid range to close any remaining rupee gap,
    // same as every other "close the last cent" step elsewhere in this
    // codebase.
    if (newInvoices.length > 0) {
      const totalNewAmount = roundMoney(
        newInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
      );
      const totalQuantityClosed = Array.from(
        remainingProductDeltas.entries(),
      ).reduce((sum, [pid, remainingDelta]) => {
        const original = plan.productDeltas.get(pid) || 0;
        return sum + (original - remainingDelta);
      }, 0);

      if (totalQuantityClosed > 0) {
        const lastInv = newInvoices[newInvoices.length - 1];
        const lastLine = lastInv.products[0];
        const constraint = context.constraints.get(lastLine.product_id);
        if (constraint) {
          const moneyStillNeeded = roundMoney(
            plan.batchDelta - totalNewAmount,
          );
          if (Math.abs(moneyStillNeeded) > 0.001) {
            const idealRate = roundToWholeInteger(
              (lastLine.amount + moneyStillNeeded) / lastLine.quantity,
            );
            const boundedRate = Math.min(
              constraint.rateMax,
              Math.max(constraint.rateMin, idealRate),
            );
            lastLine.rate = boundedRate;
            lastLine.amount = computeLineAmount(
              lastLine.quantity,
              boundedRate,
            );
            lastInv.total_amount = lastLine.amount;
          }
        }
      }
    }

    return { newInvoices, remainingProductDeltas, blockedReasons };
  }
}
