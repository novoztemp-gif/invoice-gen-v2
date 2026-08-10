import { SupabaseClient } from "@supabase/supabase-js";
import { CandidateSolver } from "./purchase-balance/CandidateSolver";
import { FinalValidator } from "./purchase-balance/FinalValidator";
import { ProductQuantityConservation } from "./purchase-balance/ProductQuantityConservation";
import { PurchaseBalancePersistence } from "./purchase-balance/PurchaseBalancePersistence";
import { PurchaseInvoiceValidator } from "./purchase-balance/PurchaseInvoiceValidator";
import {
  PurchaseInvoice,
  PurchaseInvoiceUpdate,
  roundMoney,
} from "./purchase-balance/types";

/**
 * Phase 1 Purchase Auto-Balance Orchestrator facade.
 * Executes the Phase 1 balancing pipeline in strict sequence:
 * Validate -> Generate Candidates -> Score Candidates -> Solve -> Residual Repair -> Final Validation -> Persist -> Return Success.
 */
export class AutoBalanceEngine {
  private readonly validator: PurchaseInvoiceValidator;
  private readonly persistence: PurchaseBalancePersistence;

  constructor(private readonly supabase: SupabaseClient) {
    this.validator = new PurchaseInvoiceValidator(supabase);
    this.persistence = new PurchaseBalancePersistence(supabase);
  }

  /**
   * Orchestrates the complete purchase invoice edit and atomic auto-balancing pipeline.
   */
  public async saveEditedInvoiceAndBalance(
    batchId: string,
    editedInvoiceId: string,
    updates: PurchaseInvoiceUpdate,
    userId: string,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
    impactSummary?: any;
  }> {
    const locked = await this.lockBatch(batchId, userId);
    if (!locked) {
      throw new Error(
        "Batch is currently being updated. Please try again shortly.",
      );
    }

    try {
      // 1. Initial Load & Context Validation
      const context = await this.validator.loadContext(batchId);
      const originalEdited = context.invoices.find(
        (inv) => inv.id === editedInvoiceId,
      );
      if (!originalEdited) {
        throw new Error("Invoice does not belong to this purchase batch.");
      }

      // A product being added to the invoice for the first time (via the
      // edit UI's "Quick Add") won't have a constraint yet — loadContext
      // only loaded constraints for products already present in the batch.
      await this.validator.ensureConstraintsForProducts(
        (updates.products || []).map((p) => p.product_id),
        context.constraints,
      );

      const normalizedEdited = this.validator.normaliseEditedInvoice(
        originalEdited,
        updates,
        context.constraints,
      );

      this.validator.validateInvoice(normalizedEdited, context, originalEdited);

      // 1.5. Product Quantity Conservation (Stage 1) — keep the total
      // quantity of every product touched by this edit exactly what it was
      // across the whole batch, by moving the delta onto/off that same
      // product's lines on other invoices — creating a brand-new invoice as
      // a last resort — before any monetary balancing runs. See
      // src/lib/services/purchase-balance/ProductQuantityConservation.ts.
      //
      // First pass has no numbering info, so it can only use Priority 1/2
      // (existing invoices) — avoids paying for a numbering lookup on every
      // single edit. Only if that leaves a shortfall do we fetch numbering
      // and re-run with Priority 3 (new-invoice creation) enabled.
      const otherInvoicesForConservation = context.invoices.filter(
        (inv) => inv.id !== editedInvoiceId,
      );
      let stage1 = ProductQuantityConservation.conserve(
        originalEdited,
        normalizedEdited,
        otherInvoicesForConservation,
        context.constraints,
        context.majorCustomerIds,
        context.supplierCategory,
      );
      if (stage1.errors.length > 0) {
        const { prefix, nextSequence } = await this.getNextInvoiceNumbering(
          context.invoices,
        );
        stage1 = ProductQuantityConservation.conserve(
          originalEdited,
          normalizedEdited,
          otherInvoicesForConservation,
          context.constraints,
          context.majorCustomerIds,
          context.supplierCategory,
          prefix,
          nextSequence,
        );
      }
      // A residual here means this specific product has genuinely no more
      // capacity anywhere in the batch to conserve exactly — every existing
      // line is already at its configured ceiling, no invoice has room for
      // a new line under the 8-line cap, and no category-matched supplier
      // has a free day left for a brand-new invoice. That's a real
      // Product-Rules/batch-composition limit, not a bug, and blocking the
      // save on it would trade a small, unrelated quantity touch (handled
      // by Stage 2 below, exactly like every edit before this feature
      // existed) for a hard failure the user can't do anything about. So:
      // never throw here — log for visibility and let Stage 2's existing,
      // battle-tested money-only solver close the batch total using
      // whatever capacity actually remains.
      if (stage1.errors.length > 0) {
        console.warn(
          `[AutoBalanceEngine] Product-quantity conservation left a residual, falling back to money-only balancing for it: ${stage1.errors.join(" ")}`,
        );
      }

      // Priority 4 inside conserve() may have adjusted the edited invoice's
      // OWN other lines (e.g. to absorb the cost of a product that's brand
      // new to the whole batch) — if so, that adjusted version is now the
      // edited invoice's true post-edit state, and everything downstream
      // (the solver's "don't touch this one" input, the persisted payload,
      // the impact summary) must use it instead of the raw normalisedEdited.
      const editedAfterStage1 = stage1.updatedEditedInvoice ?? normalizedEdited;

      {
        const editedMoneyDelta = roundMoney(
          editedAfterStage1.total_amount - originalEdited.total_amount,
        );
        const origById = new Map(context.invoices.map((i) => [i.id, i]));
        let stage1MoneyDelta = 0;
        for (const [id, w] of stage1.updatedInvoices) {
          const orig = origById.get(id);
          stage1MoneyDelta += roundMoney(
            w.total_amount - (orig?.total_amount || 0),
          );
        }
        for (const inv of stage1.newInvoices) {
          stage1MoneyDelta += inv.total_amount;
        }
        stage1MoneyDelta = roundMoney(stage1MoneyDelta);
        const preStage2BatchSum = roundMoney(
          [
            editedAfterStage1,
            ...context.invoices
              .filter((i) => i.id !== editedInvoiceId)
              .map((i) => stage1.updatedInvoices.get(i.id) || i),
            ...stage1.newInvoices,
          ].reduce((s, i) => s + (i.total_amount || 0), 0),
        );
        console.log("[STAGE1->STAGE2 TRACE]", {
          editedMoneyDelta,
          stage1MoneyDelta,
          netUnaccounted: roundMoney(editedMoneyDelta + stage1MoneyDelta),
          batchTotalTarget: context.batchTotal,
          preStage2BatchSum,
          gapForStage2: roundMoney(context.batchTotal - preStage2BatchSum),
        });
      }

      const allBatchInvoices = [
        ...context.invoices.map((inv) =>
          inv.id === editedInvoiceId
            ? editedAfterStage1
            : stage1.updatedInvoices.get(inv.id) || inv,
        ),
        ...stage1.newInvoices,
      ];

      // 2. Generate Candidates, 3. Score Candidates, 4. Solve DP, 5. Residual Repair
      const solverResult = CandidateSolver.solveBatchBalance(
        editedAfterStage1,
        allBatchInvoices,
        context.batchTotal,
        context.constraints,
        context.majorCustomerIds,
        context.supplierCategory,
      );

      if (solverResult.outcome === "search_capacity_exceeded") {
        throw new Error(`Search capacity exceeded: ${solverResult.reason}`);
      }

      if (solverResult.outcome === "no_valid_solution") {
        throw new Error(
          solverResult.reason ||
            "Unable to rebalance batch while preserving business rules.",
        );
      }

      const plan = solverResult.plan;
      // Merge the "other invoices" sources with correct precedence: Stage 2
      // (the monetary solver) is authoritative for anything it touched;
      // Stage 1 (product-quantity conservation) is authoritative for
      // everything else it touched — including brand-new invoices it
      // created — that Stage 2 left alone. Without this merge, an invoice
      // Stage 1 modified but Stage 2 didn't separately re-touch would
      // silently fall back to its original, pre-edit state (or, for a new
      // invoice, be dropped entirely) — losing Stage 1's changes.
      const otherInvoicesById = new Map<string, PurchaseInvoice>(
        stage1.updatedInvoices,
      );
      for (const inv of stage1.newInvoices) {
        otherInvoicesById.set(inv.id, inv);
      }
      for (const inv of plan.balancingInvoices) {
        otherInvoicesById.set(inv.id, inv);
      }
      const mergedOtherInvoices = Array.from(otherInvoicesById.values());
      const newInvoiceIds = new Set(stage1.newInvoices.map((inv) => inv.id));
      const productConservedInvoiceIds = new Set([
        ...stage1.updatedInvoices.keys(),
        ...newInvoiceIds,
      ]);

      // Map lookup instead of Array.find() inside the .map() below — with a
      // batch of thousands of invoices, an O(1) lookup per invoice avoids an
      // O(N^2) scan (N invoices x an O(N) find for each). Brand-new
      // invoices don't exist in context.invoices at all, so they're
      // appended separately below.
      const plannedInvoices = [
        ...context.invoices.map((inv) => {
          if (inv.id === editedInvoiceId) return plan.editedInvoice;
          return otherInvoicesById.get(inv.id) || inv;
        }),
        ...stage1.newInvoices.map((inv) => otherInvoicesById.get(inv.id)!),
      ];

      // FinalValidator compares planned vs. original invoices by id and
      // requires the counts to match — a brand-new invoice has no real
      // "original" to compare against, so give it a synthetic one: same id
      // and a single zero-quantity line of the same product, so the
      // category-baseline check still validates against the right category
      // rather than falling back to the batch's single default category.
      const syntheticOriginalsForNew = stage1.newInvoices.map((inv) => ({
        ...inv,
        products: inv.products.map((p) => ({ ...p, quantity: 0, amount: 0 })),
        total_amount: 0,
      }));
      const originalInvoicesForValidation = [
        ...context.invoices,
        ...syntheticOriginalsForNew,
      ];

      // 6. Final Pre-Persistence Validation
      const finalValidation = FinalValidator.validateRebalancedBatch(
        originalInvoicesForValidation,
        plannedInvoices,
        context.batchTotal,
        context.supplierCategory,
        context.constraints,
        editedInvoiceId,
        context.majorCustomerIds,
        productConservedInvoiceIds,
      );

      if (!finalValidation.valid) {
        throw new Error(
          `Final validation failed: ${finalValidation.errors.join("; ")}`,
        );
      }

      // 7. Atomic Persistence & Return Success. Existing invoices (edited +
      // balancing) are UPDATEd; brand-new invoices Stage 1 had to create
      // are INSERTed — kept as separate arrays since they're different SQL
      // operations inside the same atomic RPC call.
      const finalNewInvoices = mergedOtherInvoices.filter((inv) =>
        newInvoiceIds.has(inv.id),
      );
      const finalBalancingInvoices = mergedOtherInvoices.filter(
        (inv) => !newInvoiceIds.has(inv.id),
      );
      const persistResult = await this.persistence.persistBalancePlan(
        batchId,
        editedInvoiceId,
        { ...plan, balancingInvoices: finalBalancingInvoices },
        finalNewInvoices,
      );

      const originalEditedInv = context.invoices.find(
        (i) => i.id === editedInvoiceId,
      );
      const updatedEditedInv = plan.editedInvoice;

      const origEditedQty = (originalEditedInv?.products || []).reduce(
        (sum, p) => sum + Number(p.quantity || 0),
        0,
      );
      const updatedEditedQty = (updatedEditedInv.products || []).reduce(
        (sum, p) => sum + Number(p.quantity || 0),
        0,
      );

      const rebalancedInvoices = mergedOtherInvoices.map((inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        const prevTotal = orig ? orig.total_amount : 0;
        const diff = Math.round((inv.total_amount - prevTotal) * 100) / 100;
        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          party: (inv as any).supplier_name || "",
          previous_total: prevTotal,
          updated_total: inv.total_amount,
          amount_difference: diff,
        };
      });

      const allAffectedInvoices = [updatedEditedInv, ...mergedOtherInvoices];
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
        const origLinesMap = new Map(
          (origInv?.products || []).map((p) => [p.product_id, p]),
        );

        for (const line of affectedInv.products || []) {
          const origLine = origLinesMap.get(line.product_id);
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

      const impactSummary = {
        editedInvoice: {
          id: updatedEditedInv.id,
          invoice_number: updatedEditedInv.invoice_number,
          party: (updatedEditedInv as any).supplier_name || "",
          original_total: originalEditedInv?.total_amount || 0,
          updated_total: updatedEditedInv.total_amount,
          original_quantity: Math.round(origEditedQty * 100) / 100,
          updated_quantity: Math.round(updatedEditedQty * 100) / 100,
        },
        rebalancedInvoices,
        productQuantityChanges,
        batchSummary: {
          invoices_rebalanced_count: mergedOtherInvoices.length,
          total_quantity_adjusted:
            Math.round(totalQuantityAdjusted * 100) / 100,
          total_amount_adjusted: Math.round(totalAmountAdjusted * 100) / 100,
        },
      };

      return {
        ...persistResult,
        impactSummary,
      };
    } finally {
      await this.unlockBatch(batchId);
    }
  }

  /** Compatibility entry point retained for existing callers. */
  public async balanceBatch(
    batchId: string,
    editedInvoiceId: string,
    _targetDiff: number,
    userId: string,
    editedInvoiceUpdates?: PurchaseInvoiceUpdate,
  ) {
    if (!editedInvoiceUpdates) {
      throw new Error(
        "An edited invoice payload is required for atomic balancing.",
      );
    }
    return this.saveEditedInvoiceAndBalance(
      batchId,
      editedInvoiceId,
      editedInvoiceUpdates,
      userId,
    );
  }

  // If a process crashes mid-balance (e.g. OOM) the `finally` block that
  // releases the lock never runs, leaving is_balancing stuck true forever.
  // Treat locks older than this as abandoned and allow them to be stolen.
  private static readonly LOCK_TIMEOUT_MS = 3 * 60 * 1000;

  private async lockBatch(batchId: string, userId: string) {
    const staleCutoff = new Date(
      Date.now() - AutoBalanceEngine.LOCK_TIMEOUT_MS,
    ).toISOString();

    const { data, error } = await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: true,
        balancing_locked_at: new Date().toISOString(),
        balancing_locked_by: userId,
      })
      .eq("id", batchId)
      .or(`is_balancing.eq.false,balancing_locked_at.lt.${staleCutoff}`)
      .select("id");
    if (error)
      throw new Error(`Unable to acquire batch lock: ${error.message}`);
    return Boolean(data?.length);
  }

  // Product-quantity conservation's last-resort fallback (Priority 3) needs
  // to number brand-new invoices sequentially. Every invoice in a batch
  // shares the same <abbreviation>-<FY>-<P|S> prefix, so it's derived from
  // any existing invoice's own number rather than a fresh company/FY
  // lookup. The starting sequence is the highest existing number for that
  // exact prefix across the WHOLE invoice table (not just this batch),
  // matching the same auto-detect query used during generation — other
  // batches can share the same company + financial year.
  private async getNextInvoiceNumbering(
    batchInvoices: { invoice_number: string }[],
  ): Promise<{ prefix: string; nextSequence: number }> {
    const sampleNumber = batchInvoices.find((inv) => inv.invoice_number)
      ?.invoice_number;
    const parts = (sampleNumber || "").split("-");
    const prefix = parts.slice(0, -1).join("-");

    let maxSeq = 0;
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const { data } = await this.supabase
        .from("invoice")
        .select("invoice_number")
        .like("invoice_number", `${prefix}-%`)
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (data && data.length > 0) {
        for (const row of data) {
          const rowParts = (row.invoice_number || "").split("-");
          const seq = parseInt(rowParts[rowParts.length - 1], 10);
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    }

    return { prefix, nextSequence: maxSeq + 1 };
  }

  private async unlockBatch(batchId: string) {
    await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: false,
        balancing_locked_at: null,
        balancing_locked_by: null,
      })
      .eq("id", batchId);
  }
}
