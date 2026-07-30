import { SupabaseClient } from "@supabase/supabase-js";
import { CandidateSolver } from "./purchase-balance/CandidateSolver";
import { FinalValidator } from "./purchase-balance/FinalValidator";
import { PurchaseBalancePersistence } from "./purchase-balance/PurchaseBalancePersistence";
import { PurchaseInvoiceValidator } from "./purchase-balance/PurchaseInvoiceValidator";
import { PurchaseInvoiceUpdate } from "./purchase-balance/types";

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

      const normalizedEdited = this.validator.normaliseEditedInvoice(
        originalEdited,
        updates,
        context.constraints,
      );

      this.validator.validateInvoice(normalizedEdited, context);

      const allBatchInvoices = context.invoices.map((inv) =>
        inv.id === editedInvoiceId ? normalizedEdited : inv,
      );

      // 2. Generate Candidates, 3. Score Candidates, 4. Solve DP, 5. Residual Repair
      const solverResult = CandidateSolver.solveBatchBalance(
        normalizedEdited,
        allBatchInvoices,
        context.batchTotal,
        context.constraints,
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
      const plannedInvoices = context.invoices.map((inv) => {
        if (inv.id === editedInvoiceId) return plan.editedInvoice;
        const balancingMatch = plan.balancingInvoices.find(
          (b) => b.id === inv.id,
        );
        return balancingMatch || inv;
      });

      // 6. Final Pre-Persistence Validation
      const finalValidation = FinalValidator.validateRebalancedBatch(
        context.invoices,
        plannedInvoices,
        context.batchTotal,
        context.supplierCategory,
        context.constraints,
      );

      if (!finalValidation.valid) {
        throw new Error(
          `Final validation failed: ${finalValidation.errors.join("; ")}`,
        );
      }

      // 7. Atomic Persistence & Return Success
      const persistResult = await this.persistence.persistBalancePlan(
        batchId,
        editedInvoiceId,
        plan,
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

      const rebalancedInvoices = plan.balancingInvoices.map((inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        const prevTotal = orig ? orig.total_amount : 0;
        const diff = Math.round((inv.total_amount - prevTotal) * 100) / 100;
        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          supplier: (inv as any).supplier_name || "",
          previous_total: prevTotal,
          updated_total: inv.total_amount,
          amount_difference: diff,
        };
      });

      const allAffectedInvoices = [updatedEditedInv, ...plan.balancingInvoices];
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
          supplier: (updatedEditedInv as any).supplier_name || "",
          original_total: originalEditedInv?.total_amount || 0,
          updated_total: updatedEditedInv.total_amount,
          original_quantity: Math.round(origEditedQty * 100) / 100,
          updated_quantity: Math.round(updatedEditedQty * 100) / 100,
        },
        rebalancedInvoices,
        productQuantityChanges,
        batchSummary: {
          invoices_rebalanced_count: plan.balancingInvoices.length,
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

  private async lockBatch(batchId: string, userId: string) {
    const { data, error } = await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: true,
        balancing_locked_at: new Date().toISOString(),
        balancing_locked_by: userId,
      })
      .eq("id", batchId)
      .eq("is_balancing", false)
      .select("id");
    if (error)
      throw new Error(`Unable to acquire batch lock: ${error.message}`);
    return Boolean(data?.length);
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
