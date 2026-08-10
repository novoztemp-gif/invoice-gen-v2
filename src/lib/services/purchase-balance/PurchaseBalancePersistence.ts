import { SupabaseClient } from "@supabase/supabase-js";
import { PurchaseInvoice, SolverPlan } from "./types";

export class PurchaseBalancePersistence {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Atomically persists a fully validated purchase balance plan using the database RPC.
   * Performs no candidate generation, rebalancing, or business rule validation.
   *
   * `newInvoices` are brand-new invoices product-quantity-conservation had to
   * create as a last resort (no existing invoice had room) — inserted in the
   * same atomic transaction as the edited/balancing invoice updates.
   */
  public async persistBalancePlan(
    batchId: string,
    editedInvoiceId: string,
    plan: SolverPlan,
    newInvoices: PurchaseInvoice[] = [],
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

    const newInvoicesPayload = newInvoices.map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      products: inv.products,
      total_amount: inv.total_amount,
      status: "generated",
      transport_mode: inv.transport_mode ?? null,
      vehicle_number: inv.vehicle_number ?? null,
      date_of_supply: inv.date_of_supply ?? null,
      edited_at: now,
    }));

    const { error: rpcError } = await this.supabase.rpc(
      "save_purchase_invoice_edit_and_balance",
      {
        p_batch_id: batchId,
        p_edited_invoice_id: editedInvoiceId,
        p_edited_invoice_data: editedPayload,
        p_balancing_updates: balancingPayload,
        p_new_invoices: newInvoicesPayload,
      },
    );

    if (rpcError) {
      throw new Error(`Atomic save failed: ${rpcError.message}`);
    }

    return {
      success: true,
      modifiedInvoicesCount:
        1 + plan.balancingInvoices.length + newInvoices.length,
      message: "Purchase batch successfully rebalanced and persisted.",
    };
  }
}
