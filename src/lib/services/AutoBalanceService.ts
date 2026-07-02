import { SupabaseClient } from "@supabase/supabase-js";
import { AutoBalanceEngine } from "./AutoBalanceEngine";
import { InvoiceEngine } from "./InvoiceEngine";

export class AutoBalanceService {
  static balanceBatch(
    supabase: SupabaseClient,
    batchId: string,
    editedInvoiceId: string,
    targetDiff: number,
    userId: string,
  ) {
    const engine = new AutoBalanceEngine(supabase);
    return engine.balanceBatch(batchId, editedInvoiceId, targetDiff, userId);
  }

  static saveInvoiceAndRebalance = InvoiceEngine.saveInvoiceAndRebalance;
}
