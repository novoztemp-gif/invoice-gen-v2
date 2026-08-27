import { SupabaseClient } from "@supabase/supabase-js";
import {
  computeLineAmount,
  roundToQuarterIncrement,
} from "@/lib/utils/quantity-rate-utils";
import {
  computeAvailableForEdit,
  loadDayAvailability,
} from "./SalesDayStockAvailability";
import { SalesDayScopedFinalValidator } from "./SalesDayScopedFinalValidator";
import {
  computeAddRoom,
  diffEditedProductIds,
  resolveReduction,
} from "./SalesLineCapacity";
import { SalesInvoiceValidator } from "./SalesInvoiceValidator";
import {
  SalesAuditRecord,
  SalesBalancePersistence,
} from "./SalesBalancePersistence";
import { SalesResidualRepair } from "./SalesResidualRepair";
import {
  roundMoney,
  SalesBalanceContext,
  SalesInvoice,
  SalesInvoiceUpdate,
  SalesLine,
  SalesSolverPlan,
} from "./types";

/**
 * Replaces SalesAutoBalanceEngine for editing an existing Sales invoice.
 * The old engine freely moved a product's quantity across ANY invoice/day
 * in the batch to keep its total conserved. This one is day-scoped: an
 * edit can only move quantity within the edited invoice's OWN day (no
 * cross-day borrowing, no new invoices), never changing that day's own
 * total sold — confirmed with the user: quantity redistribution between
 * same-day invoices runs in BOTH directions —
 *   - a DECREASE's freed quantity is pushed onto a same-day peer (topping
 *     up an existing line, or a brand-new line on a same-category peer);
 *   - an INCREASE first draws on whatever's genuinely unclaimed that day,
 *     then pulls the rest from whichever same-day peer holds the most of
 *     that product, shrinking their line correspondingly.
 * Either direction that can't be fully satisfied within day D rejects the
 * WHOLE edit outright — never partially applied, never silently changes
 * how much of a product the day sold in total (leftover/carry-forward
 * stock is a decision made once, at generation time, and an edit must
 * never quietly touch it). The batch's grand total still never moves —
 * whatever rupee residual is left after quantity settles is closed via a
 * pure price (never quantity/stock) adjustment ANYWHERE in the batch, any
 * day. See the approved plan for the full rationale:
 * /Users/puvanesh/.claude/plans/steady-noodling-abelson.md
 */
export class SalesDayScopedEditEngine {
  constructor(private readonly supabase: SupabaseClient) {}

  private static readonly LOCK_TIMEOUT_MS = 3 * 60 * 1000;

  public async saveEditedInvoiceAndBalance(
    batchId: string,
    editedInvoiceId: string,
    updates: SalesInvoiceUpdate,
    userId: string,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
    auditRecord?: SalesAuditRecord;
    impactSummary?: any;
  }> {
    const lockAcquired = await this.acquireBatchLock(batchId);
    if (!lockAcquired) {
      throw new Error(
        "Concurrent Edit Detected: Sales Batch is currently being edited. Please try again.",
      );
    }

    try {
      const context = await SalesInvoiceValidator.loadContext(
        this.supabase,
        batchId,
      );

      const originalEdited = context.invoices.find(
        (i) => i.id === editedInvoiceId,
      );
      if (!originalEdited) {
        throw new Error(`Edited invoice ${editedInvoiceId} was not found.`);
      }

      const isMajorInvoice = (inv: SalesInvoice): boolean => {
        const partyId = inv.products?.[0]?.customer_id;
        return !!partyId && context.majorCustomerIds.has(partyId);
      };

      if (isMajorInvoice(originalEdited)) {
        throw new Error(
          "This invoice belongs to a major customer and cannot be edited.",
        );
      }

      const normalisedEdited = SalesInvoiceValidator.normaliseEditedInvoice(
        context,
        editedInvoiceId,
        updates,
      );
      const editedValidation = SalesInvoiceValidator.validateInvoice(
        normalisedEdited,
        context.constraints,
        originalEdited,
      );
      if (!editedValidation.valid) {
        throw new Error(editedValidation.message || "Invoice is invalid.");
      }

      const editedProductIds = diffEditedProductIds(
        originalEdited.products,
        normalisedEdited.products,
      );

      const sumQtyByPid = (lines: SalesLine[]): Map<string, number> => {
        const m = new Map<string, number>();
        for (const p of lines) {
          if (!p.product_id) continue;
          m.set(
            p.product_id,
            roundToQuarterIncrement((m.get(p.product_id) || 0) + p.quantity),
          );
        }
        return m;
      };
      const oldQtyByPid = sumQtyByPid(originalEdited.products);
      const newQtyByPid = sumQtyByPid(normalisedEdited.products);
      const allEditedPids = new Set([
        ...oldQtyByPid.keys(),
        ...newQtyByPid.keys(),
      ]);
      const netDeltaByPid = new Map<string, number>();
      for (const pid of allEditedPids) {
        netDeltaByPid.set(
          pid,
          roundToQuarterIncrement(
            (newQtyByPid.get(pid) || 0) - (oldQtyByPid.get(pid) || 0),
          ),
        );
      }

      const D = originalEdited.invoice_date;
      const stockSourceBatchIds = context.stockSourceBatchId
        ? context.stockSourceBatchId
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const staticAvailable = await loadDayAvailability(
        this.supabase,
        stockSourceBatchIds,
        D,
      );
      // Genuinely unclaimed stock only — draw on this FIRST for an
      // increase, before ever touching another invoice.
      const availableForEdit = computeAvailableForEdit(
        context,
        staticAvailable,
        D,
        editedInvoiceId,
      );

      const findProductName = (pid: string): string =>
        normalisedEdited.products.find((p) => p.product_id === pid)
          ?.product_name ||
        originalEdited.products.find((p) => p.product_id === pid)
          ?.product_name ||
        pid;

      // Candidate pool for same-day redistribution AND the price-nudge
      // fallback: every OTHER invoice in the batch, minor customers only.
      const candidatePool: SalesInvoice[] = context.invoices
        .filter((inv) => inv.id !== editedInvoiceId && !isMajorInvoice(inv))
        .map((inv) => JSON.parse(JSON.stringify(inv)) as SalesInvoice);

      // Same-day pool, deterministically ordered — used for BOTH
      // directions below.
      const sameDayPool = candidatePool
        .filter((inv) => inv.invoice_date === D)
        .sort((a, b) =>
          a.invoice_number.localeCompare(b.invoice_number, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );

      // Quantity is redistributed within day D only, in BOTH directions —
      // confirmed with the user: an increase beyond genuinely-free stock
      // pulls the rest from another same-day invoice's existing holding
      // of the same product (their quantity shrinks, this invoice's
      // grows — the day's own total sold stays exactly the same, so the
      // leftover/carry-forward decision from generation time is never
      // touched). A decrease's freed quantity is pushed onto a same-day
      // peer the same way it always was. If either direction genuinely
      // can't be satisfied within day D, the WHOLE edit is rejected
      // outright — never left partially applied, never silently
      // re-creates leftover stock.
      for (const pid of allEditedPids) {
        const delta = netDeltaByPid.get(pid) || 0;
        if (Math.abs(delta) <= 0.001) continue;
        const constraint = context.constraints.get(pid);

        if (delta > 0) {
          // INCREASE: genuinely-free stock first, then pull the rest from
          // whichever same-day peer holds the most of this product
          // (fewest invoices disturbed), down to its own configured
          // quantityMin.
          const newQty = newQtyByPid.get(pid) || 0;
          const freeAvail = availableForEdit.get(pid) || 0;
          let stillNeeded = roundToQuarterIncrement(
            Math.max(0, newQty - freeAvail),
          );
          if (stillNeeded <= 0.001) continue;

          const holders = sameDayPool
            .filter((inv) =>
              inv.products.some((p) => p.product_id === pid),
            )
            .sort((a, b) => {
              const qa =
                a.products.find((p) => p.product_id === pid)?.quantity || 0;
              const qb =
                b.products.find((p) => p.product_id === pid)?.quantity || 0;
              return qb - qa;
            });

          for (const inv of holders) {
            if (stillNeeded <= 0.001) break;
            const line = inv.products.find((p) => p.product_id === pid)!;
            const take = resolveReduction(
              line.quantity,
              stillNeeded,
              constraint,
            );
            if (take <= 0.001) continue;
            line.quantity = roundToQuarterIncrement(line.quantity - take);
            line.amount = computeLineAmount(line.quantity, line.rate);
            if (line.quantity <= 0.001) {
              inv.products = inv.products.filter((p) => p !== line);
            }
            inv.total_amount = Math.round(
              inv.products.reduce((s, p) => s + Math.round(p.amount || 0), 0),
            );
            stillNeeded = roundToQuarterIncrement(stillNeeded - take);
          }

          if (stillNeeded > 0.001) {
            throw new Error(
              `Can't save this edit — only ${freeAvail}kg of ${findProductName(pid)} was free on ${D}, and no other invoice that day had enough spare ${findProductName(pid)} to cover the rest. Try a smaller increase, or edit a different product instead.`,
            );
          }
        } else {
          // DECREASE: push the freed quantity onto a same-day peer —
          // topping up an existing line first, then (if needed) a
          // brand-new line on a same-category peer that doesn't carry it
          // yet, at the removed line's own real rate.
          let freed = -delta;
          const removedLine =
            originalEdited.products.find((p) => p.product_id === pid) ||
            normalisedEdited.products.find((p) => p.product_id === pid);

          for (const inv of sameDayPool) {
            if (freed <= 0.001) break;
            const line = inv.products.find((p) => p.product_id === pid);
            if (!line) continue;
            const { room } = computeAddRoom({
              currentQuantity: line.quantity,
              currentAmount: line.amount,
              invoiceTotalAmount: inv.total_amount,
              rate: line.rate,
              constraint,
              thresholdMax: context.thresholdMax,
              stockCeiling: Number.POSITIVE_INFINITY,
              stockAlreadyUsed: 0,
            });
            const add = roundToQuarterIncrement(Math.min(freed, room));
            if (add <= 0.001) continue;
            line.quantity = roundToQuarterIncrement(line.quantity + add);
            line.amount = computeLineAmount(line.quantity, line.rate);
            inv.total_amount = Math.round(
              inv.products.reduce((s, p) => s + Math.round(p.amount || 0), 0),
            );
            freed = roundToQuarterIncrement(freed - add);
          }

          if (freed > 0.001 && removedLine) {
            const pidCategory = String(
              removedLine.category || constraint?.category || "Meat",
            ).toUpperCase();
            for (const inv of sameDayPool) {
              if (freed <= 0.001) break;
              if (inv.products.some((p) => p.product_id === pid)) continue;
              const invCategory = String(
                inv.products[0]?.category || "Meat",
              ).toUpperCase();
              if (invCategory !== pidCategory) continue;
              const { room } = computeAddRoom({
                currentQuantity: 0,
                currentAmount: 0,
                invoiceTotalAmount: inv.total_amount,
                rate: removedLine.rate,
                constraint,
                thresholdMax: context.thresholdMax,
                stockCeiling: Number.POSITIVE_INFINITY,
                stockAlreadyUsed: 0,
              });
              const add = roundToQuarterIncrement(Math.min(freed, room));
              if (add <= 0.001) continue;
              inv.products.push({
                product_id: pid,
                product_name: removedLine.product_name,
                hsn_code: removedLine.hsn_code,
                unit_of_measure: removedLine.unit_of_measure,
                category: removedLine.category,
                quantity: add,
                rate: removedLine.rate,
                amount: computeLineAmount(add, removedLine.rate),
                customer_id: inv.products[0]?.customer_id,
              });
              inv.total_amount = Math.round(
                inv.products.reduce(
                  (s, p) => s + Math.round(p.amount || 0),
                  0,
                ),
              );
              freed = roundToQuarterIncrement(freed - add);
            }
          }

          if (freed > 0.001) {
            const productName = removedLine?.product_name || pid;
            throw new Error(
              `Can't save this edit — ${freed}kg of ${productName} freed up by this change has nowhere to go on ${D}. No other invoice on that day can take it. Try a smaller decrease, or edit a different product instead.`,
            );
          }
        }
      }

      // Close whatever rupee gap same-day reuse left, over the touched
      // subset so far, via a pure price adjustment (never quantity/stock)
      // somewhere else in the batch — any day, per the approved plan.
      const touchedAfterReuse = candidatePool.filter((inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        return (
          !orig ||
          Math.abs(inv.total_amount - orig.total_amount) > 0.001 ||
          JSON.stringify(inv.products) !== JSON.stringify(orig.products)
        );
      });
      const requiredCombinedTotal = roundMoney(
        originalEdited.total_amount +
          touchedAfterReuse.reduce((sum, inv) => {
            const orig = context.invoices.find((i) => i.id === inv.id)!;
            return sum + orig.total_amount;
          }, 0),
      );
      const currentCombinedTotal = roundMoney(
        normalisedEdited.total_amount +
          touchedAfterReuse.reduce((sum, inv) => sum + inv.total_amount, 0),
      );
      let residual = roundMoney(requiredCombinedTotal - currentCombinedTotal);

      if (Math.abs(residual) > 0.001) {
        residual = SalesResidualRepair.closeAmountResidual(
          candidatePool,
          editedProductIds,
          context,
          residual,
        );
      }

      if (Math.abs(residual) > 0.001) {
        throw new Error(
          "Could not save this edit — the change couldn't be balanced against the rest of the batch within the allowed price limits.",
        );
      }

      const finalBalancingInvoices = candidatePool.filter((inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        return (
          !orig ||
          Math.abs(inv.total_amount - orig.total_amount) > 0.001 ||
          JSON.stringify(inv.products) !== JSON.stringify(orig.products)
        );
      });

      const finalPlan: SalesSolverPlan = {
        editedInvoice: normalisedEdited,
        balancingInvoices: finalBalancingInvoices,
        totalCost: 0,
        batchDelta: 0,
        productDeltas: new Map(),
      };

      const finalValidation = SalesDayScopedFinalValidator.validate(
        context,
        finalPlan,
        editedProductIds,
      );
      if (!finalValidation.valid) {
        throw new Error((finalValidation.errors || []).join("; "));
      }

      // Must account for EVERY touched invoice's own delta per product,
      // not just the edited invoice's — an increase can pull quantity
      // from a same-day peer (whose own line for that product shrinks by
      // the same amount), so the two deltas net against each other. Using
      // only the edited invoice's own requested delta overstated the
      // expected total by exactly whatever was pulled from a peer,
      // tripping the RPC's own "Product Quantity Mismatch" verification
      // on an otherwise perfectly correct, fully-conserving edit — the
      // exact same class of bug already fixed in
      // SalesDayScopedFinalValidator's Rule 5 (Overstock), just missed
      // here too.
      const touchedInvoicesForTotals = [
        finalPlan.editedInvoice,
        ...finalPlan.balancingInvoices,
      ];
      const touchedNewQtyByPid = new Map<string, number>();
      const touchedOldQtyByPid = new Map<string, number>();
      for (const inv of touchedInvoicesForTotals) {
        for (const p of inv.products) {
          if (!p.product_id) continue;
          touchedNewQtyByPid.set(
            p.product_id,
            roundToQuarterIncrement(
              (touchedNewQtyByPid.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
        const orig = context.invoices.find((i) => i.id === inv.id);
        for (const p of orig?.products || []) {
          if (!p.product_id) continue;
          touchedOldQtyByPid.set(
            p.product_id,
            roundToQuarterIncrement(
              (touchedOldQtyByPid.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
      }

      const expectedProductTotals = new Map(context.originalProductTotals);
      const touchedPids = new Set([
        ...touchedNewQtyByPid.keys(),
        ...touchedOldQtyByPid.keys(),
      ]);
      for (const pid of touchedPids) {
        const priorQty = context.originalProductTotals.get(pid) || 0;
        const touchedOldQty = touchedOldQtyByPid.get(pid) || 0;
        const touchedNewQty = touchedNewQtyByPid.get(pid) || 0;
        expectedProductTotals.set(
          pid,
          roundToQuarterIncrement(priorQty - touchedOldQty + touchedNewQty),
        );
      }

      const persistence = new SalesBalancePersistence(this.supabase);
      const result = await persistence.persistBalancePlan(
        batchId,
        editedInvoiceId,
        finalPlan,
        expectedProductTotals,
      );

      const impactSummary = this.buildImpactSummary(
        context,
        editedInvoiceId,
        finalPlan,
      );

      return { ...result, impactSummary };
    } catch (err: any) {
      throw new Error(err.message || "Could not save this invoice edit.");
    } finally {
      await this.releaseBatchLock(batchId);
    }
  }

  private buildImpactSummary(
    context: SalesBalanceContext,
    editedInvoiceId: string,
    finalPlan: SalesSolverPlan,
  ) {
    const originalEditedInv = context.invoices.find(
      (i) => i.id === editedInvoiceId,
    );
    const updatedEditedInv = finalPlan.editedInvoice;

    const origEditedQty = (originalEditedInv?.products || []).reduce(
      (sum, p) => sum + Number(p.quantity || 0),
      0,
    );
    const updatedEditedQty = (updatedEditedInv.products || []).reduce(
      (sum, p) => sum + Number(p.quantity || 0),
      0,
    );

    const rebalancedInvoices = finalPlan.balancingInvoices.map((inv) => {
      const orig = context.invoices.find((i) => i.id === inv.id);
      const prevTotal = orig ? orig.total_amount : 0;
      const diff = Math.round((inv.total_amount - prevTotal) * 100) / 100;
      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        party: "",
        previous_total: prevTotal,
        updated_total: inv.total_amount,
        amount_difference: diff,
      };
    });

    const allAffectedInvoices = [
      updatedEditedInv,
      ...finalPlan.balancingInvoices,
    ];
    const productQuantityChanges: Array<{
      invoice_id: string;
      invoice_number: string;
      product_id: string;
      product_name: string;
      previous_quantity: number;
      updated_quantity: number;
      difference: number;
    }> = [];

    let totalQuantityAdjusted = 0;
    let totalAmountAdjusted = 0;

    for (const affectedInv of allAffectedInvoices) {
      const origInv = context.invoices.find((i) => i.id === affectedInv.id);
      const occurrenceSeen = new Map<string, number>();

      for (const line of affectedInv.products || []) {
        const occIdx = occurrenceSeen.get(line.product_id) || 0;
        occurrenceSeen.set(line.product_id, occIdx + 1);
        const origLine = (origInv?.products || []).filter(
          (p) => p.product_id === line.product_id,
        )[occIdx];
        const prevQty = origLine ? Number(origLine.quantity || 0) : 0;
        const newQty = Number(line.quantity || 0);
        const qtyDiff = Math.round((newQty - prevQty) * 100) / 100;

        if (Math.abs(qtyDiff) > 0.001) {
          totalQuantityAdjusted += Math.abs(qtyDiff);
          productQuantityChanges.push({
            invoice_id: affectedInv.id,
            invoice_number: affectedInv.invoice_number,
            product_id: line.product_id,
            product_name: line.product_name || "Product",
            previous_quantity: prevQty,
            updated_quantity: newQty,
            difference: qtyDiff,
          });
        }
      }
    }

    for (const rebal of rebalancedInvoices) {
      totalAmountAdjusted += Math.abs(rebal.amount_difference);
    }

    return {
      editedInvoice: {
        id: updatedEditedInv.id,
        invoice_number: updatedEditedInv.invoice_number,
        party: "",
        original_total: originalEditedInv?.total_amount || 0,
        updated_total: updatedEditedInv.total_amount,
        original_quantity: Math.round(origEditedQty * 100) / 100,
        updated_quantity: Math.round(updatedEditedQty * 100) / 100,
      },
      rebalancedInvoices,
      productQuantityChanges,
      batchSummary: {
        invoices_rebalanced_count: finalPlan.balancingInvoices.length,
        total_quantity_adjusted: Math.round(totalQuantityAdjusted * 100) / 100,
        total_amount_adjusted: Math.round(totalAmountAdjusted * 100) / 100,
      },
    };
  }

  private async acquireBatchLock(batchId: string): Promise<boolean> {
    const staleCutoff = new Date(
      Date.now() - SalesDayScopedEditEngine.LOCK_TIMEOUT_MS,
    ).toISOString();

    const { data, error } = await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: true,
        balancing_locked_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .or(`is_balancing.eq.false,balancing_locked_at.lt.${staleCutoff}`)
      .select("id");

    if (error || !data || data.length === 0) {
      return false;
    }
    return true;
  }

  private async releaseBatchLock(batchId: string): Promise<void> {
    await this.supabase
      .from("invoice_batch")
      .update({ is_balancing: false, balancing_locked_at: null })
      .eq("id", batchId);
  }
}
