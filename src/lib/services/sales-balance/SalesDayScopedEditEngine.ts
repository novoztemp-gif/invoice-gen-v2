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
import { computeAddRoom, diffEditedProductIds } from "./SalesLineCapacity";
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
 * edit can only draw on stock physically available on the edited invoice's
 * OWN day (no cross-day borrowing, no new invoices), while the batch's
 * grand total still never moves — closed via same-day reuse of freed
 * stock first (topping up an existing line, or a brand-new line on
 * another same-day/same-category invoice), then a pure price (never
 * quantity/stock) adjustment elsewhere in the batch for whatever rupee
 * residual is left. A decrease's freed stock must be reused IN FULL on
 * that same day — leftover/carry-forward stock is a decision made once,
 * at generation time, and an edit must never quietly re-create it by
 * leaving freed stock unused; if it genuinely has nowhere to go that day,
 * the whole edit is rejected outright instead. See the approved plan for
 * the full rationale:
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

      // Day-D stock cap: reject outright if any product's new quantity on
      // this invoice exceeds what's actually free on this day, before
      // touching anything else.
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

      const violations: string[] = [];
      for (const pid of allEditedPids) {
        const delta = netDeltaByPid.get(pid) || 0;
        if (delta <= 0.001) continue;
        const newQty = newQtyByPid.get(pid) || 0;
        const avail = availableForEdit.get(pid) || 0;
        if (newQty > avail + 0.001) {
          const excess = roundToQuarterIncrement(newQty - avail);
          violations.push(
            `Only ${avail}kg of ${findProductName(pid)} is available on ${D} — you're adding ${excess}kg more than that.`,
          );
        }
      }
      if (violations.length > 0) {
        throw new Error(violations.join("; "));
      }

      // Candidate pool for both same-day reuse AND the price-nudge fallback:
      // every OTHER invoice in the batch, minor customers only.
      const candidatePool: SalesInvoice[] = context.invoices
        .filter((inv) => inv.id !== editedInvoiceId && !isMajorInvoice(inv))
        .map((inv) => JSON.parse(JSON.stringify(inv)) as SalesInvoice);

      // Same-day reuse: freed quantity from a decrease can only top up a
      // line that ALREADY carries that product on an invoice dated the
      // exact same day; if that's not enough, a brand-new line on any
      // OTHER same-day, same-category invoice that doesn't yet carry it.
      // Freed stock going unused was the original design — overruled by
      // the user after real-batch testing: leftover/carry-forward stock
      // is a decision made once, at generation time. An edit must never
      // quietly re-create "leftover" by leaving freed stock unreused; if
      // it genuinely has nowhere to go on this exact day, the WHOLE edit
      // is rejected instead (see the throw at the end of this block).
      const sameDayPool = candidatePool
        .filter((inv) => inv.invoice_date === D)
        .sort((a, b) =>
          a.invoice_number.localeCompare(b.invoice_number, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );

      for (const pid of allEditedPids) {
        let freed = -(netDeltaByPid.get(pid) || 0);
        if (freed <= 0.001) continue;
        const constraint = context.constraints.get(pid);
        const removedLine =
          originalEdited.products.find((p) => p.product_id === pid) ||
          normalisedEdited.products.find((p) => p.product_id === pid);

        // Pass 1: top up an existing line that already carries this
        // product on a same-day invoice.
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

        // Pass 2: whatever's still freed — place it as a brand-new line
        // on any other same-day, same-category invoice that doesn't
        // already carry this product, at the removed line's own real
        // rate (known-good pricing for this exact product on this exact
        // day — never a guessed midpoint).
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
              inv.products.reduce((s, p) => s + Math.round(p.amount || 0), 0),
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

      const expectedProductTotals = new Map(context.originalProductTotals);
      for (const pid of allEditedPids) {
        const priorQty = context.originalProductTotals.get(pid) || 0;
        const delta = netDeltaByPid.get(pid) || 0;
        expectedProductTotals.set(
          pid,
          roundToQuarterIncrement(priorQty + delta),
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
