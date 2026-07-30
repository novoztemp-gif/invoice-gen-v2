import { SupabaseClient } from "@supabase/supabase-js";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import { roundMoney, SalesSolverPlan } from "./types";

export interface SalesAuditRecord {
  batchId: string;
  editedInvoiceId: string;
  userId?: string;
  editTimestamp: string;
  affectedInvoiceIds: string[];
  numProductsModified: number;
  numInvoicesRebalanced: number;
  transactionStatus: "SUCCESS" | "ROLLED_BACK";
}

export class SalesBalancePersistence {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Atomically persists a fully validated sales balance plan using the database RPC.
   * Performs post-persistence verification and structured error handling.
   */
  public async persistBalancePlan(
    batchId: string,
    editedInvoiceId: string,
    plan: SalesSolverPlan,
    expectedProductTotals?: Map<string, number>,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
    auditRecord: SalesAuditRecord;
  }> {
    const now = new Date().toISOString();

    const editedPayload = {
      products: plan.editedInvoice.products,
      total_amount: plan.editedInvoice.total_amount,
      transport_mode: plan.editedInvoice.transport_mode ?? null,
      vehicle_number: plan.editedInvoice.vehicle_number ?? null,
      date_of_supply: plan.editedInvoice.date_of_supply ?? null,
      is_edited: true,
      edited_at: now,
    };

    const balancingPayload = plan.balancingInvoices.map((inv) => ({
      id: inv.id,
      products: inv.products,
      total_amount: inv.total_amount,
      is_edited: true,
      edited_at: now,
    }));

    const expectedProductTotalsObj: Record<string, number> = {};
    if (expectedProductTotals) {
      for (const [pid, qty] of expectedProductTotals.entries()) {
        expectedProductTotalsObj[pid] = qty;
      }
    }

    // STEP 14 & 15: Call Atomic Database Persistence RPC
    const { error: rpcError } = await this.supabase.rpc(
      "save_sales_invoice_edit_and_balance",
      {
        p_batch_id: batchId,
        p_edited_invoice_id: editedInvoiceId,
        p_edited_invoice_data: editedPayload,
        p_balancing_updates: balancingPayload,
        p_expected_product_totals: expectedProductTotals
          ? expectedProductTotalsObj
          : null,
      },
    );

    if (rpcError) {
      if (
        rpcError.message.includes("Concurrent Edit Detected") ||
        rpcError.message.includes("lock_not_available")
      ) {
        throw new Error(
          "Concurrent Edit Detected: Sales Batch is currently being edited. Please try again.",
        );
      }
      if (rpcError.message.includes("Batch Total Mismatch")) {
        throw new Error(`Batch Total Mismatch: ${rpcError.message}`);
      }
      if (rpcError.message.includes("Product Quantity Mismatch")) {
        throw new Error(`Product Quantity Mismatch: ${rpcError.message}`);
      }
      throw new Error(`Database Persistence Failed: ${rpcError.message}`);
    }

    // STEP 16: Post-Persistence Verification Query
    await this.verifyPersistedData(
      batchId,
      editedInvoiceId,
      plan,
      expectedProductTotals,
    );

    const affectedInvoiceIds = plan.balancingInvoices.map((inv) => inv.id);

    const auditRecord: SalesAuditRecord = {
      batchId,
      editedInvoiceId,
      editTimestamp: now,
      affectedInvoiceIds,
      numProductsModified: plan.editedInvoice.products.length,
      numInvoicesRebalanced: plan.balancingInvoices.length,
      transactionStatus: "SUCCESS",
    };

    return {
      success: true,
      modifiedInvoicesCount: 1 + plan.balancingInvoices.length,
      message: "Sales batch successfully rebalanced, persisted, and verified.",
      auditRecord,
    };
  }

  /**
   * Reads back the persisted batch invoices from Supabase to verify database state consistency.
   */
  private async verifyPersistedData(
    batchId: string,
    editedInvoiceId: string,
    plan: SalesSolverPlan,
    expectedProductTotals?: Map<string, number>,
  ): Promise<void> {
    const { data: batch, error: batchErr } = await this.supabase
      .from("invoice_batch")
      .select("total_amount")
      .eq("id", batchId)
      .single();

    if (batchErr || !batch) {
      throw new Error(
        "Post-Persistence Verification Failed: Could not read back Sales Batch.",
      );
    }

    const { data: invoices, error: invErr } = await this.supabase
      .from("invoice")
      .select("id, total_amount, products")
      .eq("invoice_batch_id", batchId);

    if (invErr || !invoices || invoices.length === 0) {
      throw new Error(
        "Post-Persistence Verification Failed: Could not read back Sales Invoices.",
      );
    }

    // Verify Batch Total Amount
    const calculatedBatchTotal = roundMoney(
      invoices.reduce((sum, inv) => sum + (Number(inv.total_amount) || 0), 0),
    );
    if (Math.abs(calculatedBatchTotal - Number(batch.total_amount)) > 0.01) {
      throw new Error(
        `Post-Persistence Verification Failed: Batch total mismatch (expected ${batch.total_amount}, calculated ${calculatedBatchTotal}).`,
      );
    }

    // Verify Expected Product Totals
    if (expectedProductTotals) {
      const calcTotals = new Map<string, number>();
      for (const inv of invoices) {
        const products = (inv.products as any[]) || [];
        for (const p of products) {
          if (p.product_id) {
            const prev = calcTotals.get(p.product_id) || 0;
            calcTotals.set(
              p.product_id,
              roundToQuarterIncrement(prev + (Number(p.quantity) || 0)),
            );
          }
        }
      }

      for (const [pid, expQty] of expectedProductTotals.entries()) {
        const actualQty = calcTotals.get(pid) || 0;
        if (Math.abs(actualQty - expQty) > 0.001) {
          throw new Error(
            `Post-Persistence Verification Failed: Product "${pid}" quantity mismatch (expected ${expQty} KG, found ${actualQty} KG).`,
          );
        }
      }
    }
  }
}
