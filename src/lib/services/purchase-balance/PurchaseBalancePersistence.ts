import { SupabaseClient } from "@supabase/supabase-js";
import { SolverPlan } from "./types";

export class PurchaseBalancePersistence {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Atomically persists a fully validated purchase balance plan using the database RPC.
   * Performs no candidate generation, rebalancing, or business rule validation.
   */
  public async persistBalancePlan(
    batchId: string,
    editedInvoiceId: string,
    plan: SolverPlan,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
    impactSummary?: any;
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

    const { error: rpcError } = await this.supabase.rpc(
      "save_purchase_invoice_edit_and_balance",
      {
        p_batch_id: batchId,
        p_edited_invoice_id: editedInvoiceId,
        p_edited_invoice_data: editedPayload,
        p_balancing_updates: balancingPayload,
      },
    );

    if (rpcError) {
      throw new Error(`Atomic save failed: ${rpcError.message}`);
    }

    return {
      success: true,
      modifiedInvoicesCount: 1 + plan.balancingInvoices.length,
      message: "Purchase batch successfully rebalanced and persisted.",
    };
  }
}
