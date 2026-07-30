import { SupabaseClient } from "@supabase/supabase-js";
import {
  SalesAuditRecord,
  SalesBalancePersistence,
} from "./sales-balance/SalesBalancePersistence";
import { SalesCandidateSolver } from "./sales-balance/SalesCandidateSolver";
import { SalesFinalValidator } from "./sales-balance/SalesFinalValidator";
import { SalesInvoiceValidator } from "./sales-balance/SalesInvoiceValidator";
import { SalesResidualRepair } from "./sales-balance/SalesResidualRepair";
import { SalesInvoiceUpdate } from "./sales-balance/types";

export class SalesAutoBalanceEngine {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Executes the 17-step Sales Atomic Transaction workflow:
   * 1. Receive Edit Request
   * 2. Acquire exclusive lock on Sales Batch
   * 3. Load current Sales Batch
   * 4. Load all Sales Invoices
   * 5. Load Product Totals
   * 6. Load Available Stock
   * 7. Validate Edited Invoice
   * 8. Run Sales Product Redistribution
   * 9. Validate Balancing Invoices
   * 10. Validate Entire Batch
   * 11. Validate Product Totals
   * 12. Validate Batch Total Amount
   * 13. Validate Stock Availability
   * 14. Persist Edited Invoice
   * 15. Persist Balancing Invoice Updates
   * 16. Verify persisted data
   * 17. Commit Transaction & Audit Log
   */
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
  }> {
    // STEP 1 & STEP 2: Receive Edit Request & Acquire exclusive concurrency lock on Sales Batch
    const lockAcquired = await this.acquireBatchLock(batchId);
    if (!lockAcquired) {
      throw new Error(
        "Concurrent Edit Detected: Sales Batch is currently being edited. Please try again.",
      );
    }

    try {
      // STEP 3, 4, 5, 6: Load Sales Batch, Sales Invoices, Product Totals, & Available Stock
      const context = await SalesInvoiceValidator.loadContext(
        this.supabase,
        batchId,
      );

      // STEP 7: Validate Edited Invoice
      const normalisedEdited = SalesInvoiceValidator.normaliseEditedInvoice(
        context,
        editedInvoiceId,
        updates,
      );
      const editedValidation =
        SalesInvoiceValidator.validateInvoice(normalisedEdited);
      if (!editedValidation.valid) {
        throw new Error(
          `Invoice Validation Failed: ${editedValidation.message}`,
        );
      }

      // STEP 8: Run Sales Product Redistribution
      const solverResult = SalesCandidateSolver.solveBatchBalance(
        context,
        normalisedEdited,
      );

      if (solverResult.outcome !== "solution_found" || !solverResult.plan) {
        throw new Error(
          `Sales Product Redistribution Failed: ${solverResult.message || solverResult.outcome}`,
        );
      }

      let finalPlan = solverResult.plan;
      if (
        finalPlan.batchDelta !== 0 ||
        Array.from(finalPlan.productDeltas.values()).some((d) => d !== 0)
      ) {
        const repaired = SalesResidualRepair.repairResidual(context, finalPlan);
        if (!repaired) {
          throw new Error(
            "Residual Repair Failed: Unable to close residual batch delta or product quantity delta.",
          );
        }
        finalPlan = repaired;
      }

      // STEP 9, 10, 11, 12, 13: Validate Balancing Invoices, Entire Batch, Product Totals, Batch Total, & Stock Availability
      const finalValidation = SalesFinalValidator.validateRebalancedBatch(
        context,
        finalPlan,
      );
      if (!finalValidation.valid) {
        throw new Error(
          `Batch Validation Failed: ${(finalValidation.errors || []).join("; ")}`,
        );
      }

      // STEP 14, 15, 16, 17: Persist Edited Invoice, Persist Balancing Invoices, Verify Persisted Data, Commit Transaction & Audit Log
      const persistence = new SalesBalancePersistence(this.supabase);
      const result = await persistence.persistBalancePlan(
        batchId,
        editedInvoiceId,
        finalPlan,
        context.originalProductTotals,
      );

      return result;
    } catch (err: any) {
      // Transaction Abort & Rollback Handling
      throw new Error(err.message || "Sales Atomic Transaction Failed.");
    } finally {
      await this.releaseBatchLock(batchId);
    }
  }

  private async acquireBatchLock(batchId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("invoice_batch")
      .update({ is_balancing: true })
      .eq("id", batchId)
      .eq("is_balancing", false)
      .select("id");

    if (error || !data || data.length === 0) {
      return false;
    }
    return true;
  }

  private async releaseBatchLock(batchId: string): Promise<void> {
    await this.supabase
      .from("invoice_batch")
      .update({ is_balancing: false })
      .eq("id", batchId);
  }
}
