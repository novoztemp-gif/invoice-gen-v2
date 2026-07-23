import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";

interface Product {
  product_id: string;
  product_name: string;
  hsn_code: string;
  quantity: number;
  rate: number;
  amount: number;
}

interface Invoice {
  id: string;
  invoice_batch_id: string;
  invoice_number: string;
  invoice_date: string;
  products: Product[];
  total_amount: number;
  is_edited?: boolean;
  edited_at?: string;
  edited_by?: string;
  remark?: string;
}

interface ProductRule {
  product_id: string;
  quantity_min: number;
  quantity_max: number;
  rate_min: number;
  rate_max: number;
}

export class AutoBalanceEngine {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Main entry point to balance the batch.
   * targetDiff = (Original Total of Edited Invoice) - (New Total of Edited Invoice)
   * This is the amount we need to apply to the REST of the batch to keep the overall total unchanged.
   */
  public async balanceBatch(
    batchId: string,
    editedInvoiceId: string,
    targetDiff: number,
    userId: string,
    editedInvoiceUpdates?: any,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
  }> {
    if (targetDiff === 0) {
      return {
        success: true,
        modifiedInvoicesCount: 0,
        message: "No difference to balance.",
      };
    }

    try {
      // 1. Lock the batch
      const locked = await this.lockBatch(batchId, userId);
      if (!locked) {
        throw new Error(
          "Batch is currently being updated. Please try again shortly.",
        );
      }

      // 2. Fetch all other invoices
      const batchInvoices = await fetchAllInvoicesForBatch(
        this.supabase,
        batchId,
      );
      const allOtherInvoices = batchInvoices.filter(
        (inv) => inv.id !== editedInvoiceId,
      );

      if (!allOtherInvoices || allOtherInvoices.length === 0) {
        throw new Error("Could not fetch remaining invoices to balance.");
      }

      // 3. Select random 10% to 30%
      const selectedInvoices = this.selectRandomInvoices(
        allOtherInvoices as Invoice[],
      );

      // 4. Fetch product rules for products in these invoices
      const productIds = new Set<string>();
      selectedInvoices.forEach((inv) => {
        inv.products.forEach((p) => {
          if (p.product_id) productIds.add(p.product_id);
        });
      });

      const { data: rulesData } = await this.supabase
        .from("product_rules")
        .select("*")
        .in("product_id", Array.from(productIds));

      const rulesMap = new Map<string, ProductRule>();
      if (rulesData) {
        rulesData.forEach((r: ProductRule) => {
          rulesMap.set(r.product_id, r);
        });
      }

      // 5. Distribute difference
      let remainingDiff = targetDiff;
      const modifiedInvoices: Invoice[] = [];

      // We shuffle to avoid always hitting the same invoices first
      this.shuffleArray(selectedInvoices);

      for (const invoice of selectedInvoices) {
        if (Math.abs(remainingDiff) < 0.01) break;

        const hasModifications = this.adjustInvoice(
          invoice,
          remainingDiff,
          rulesMap,
        );
        if (hasModifications.modified) {
          remainingDiff -= hasModifications.appliedDiff;
          invoice.is_edited = true;
          invoice.edited_at = new Date().toISOString();
          invoice.edited_by = userId;
          invoice.remark = `Automatically adjusted by Auto Balance Engine.`;
          modifiedInvoices.push(invoice);
        }
      }

      // If we still have significant diff, fallback and select ALL other invoices to absorb
      if (Math.abs(remainingDiff) >= 0.01) {
        const remainingUnselected = allOtherInvoices.filter(
          (i) => !modifiedInvoices.some((m) => m.id === i.id),
        );
        this.shuffleArray(remainingUnselected);

        for (const invoice of remainingUnselected as Invoice[]) {
          if (Math.abs(remainingDiff) < 0.01) break;

          // Fetch rules if missing
          for (const p of invoice.products) {
            if (p.product_id && !rulesMap.has(p.product_id)) {
              const { data: rule } = await this.supabase
                .from("product_rules")
                .select("*")
                .eq("product_id", p.product_id)
                .single();
              if (rule) rulesMap.set(p.product_id, rule);
            }
          }

          const hasModifications = this.adjustInvoice(
            invoice,
            remainingDiff,
            rulesMap,
          );
          if (hasModifications.modified) {
            remainingDiff -= hasModifications.appliedDiff;
            invoice.is_edited = true;
            invoice.edited_at = new Date().toISOString();
            invoice.edited_by = userId;
            invoice.remark = `Automatically adjusted by Auto Balance Engine (Fallback).`;
            modifiedInvoices.push(invoice);
          }
        }
      }

      // If remainingDiff is very small (under ₹1.00), try to absorb it in one of the modified invoices
      if (
        Math.abs(remainingDiff) >= 0.01 &&
        Math.abs(remainingDiff) < 1.0 &&
        modifiedInvoices.length > 0
      ) {
        let absorbed = false;
        for (const inv of modifiedInvoices) {
          for (const p of inv.products) {
            const rule = rulesMap.get(p.product_id);
            if (!rule) continue;

            const minRate = Math.max(
              0.01,
              isNaN(Number(rule.rate_min)) ? 0.01 : Number(rule.rate_min),
            );
            const maxRate = Number(rule.rate_max);

            const currentAmount = Number(p.amount);
            const newAmount =
              Math.round((currentAmount + remainingDiff) * 100) / 100;
            const newRate = Math.round((newAmount / p.quantity) * 100) / 100;

            if (newRate >= minRate && newRate <= maxRate && newAmount > 0.01) {
              p.amount = newAmount;
              p.rate = newRate;

              // Recalculate invoice total to 2 decimal places
              const totalBeforeTax = inv.products.reduce(
                (sum, prod) => sum + (Number(prod.amount) || 0),
                0,
              );
              inv.total_amount = Math.round(totalBeforeTax * 100) / 100;

              remainingDiff = 0;
              absorbed = true;
              break;
            }
          }
          if (absorbed) break;
        }
      }

      // If we STILL can't balance it, we must abort to maintain data integrity
      if (Math.abs(remainingDiff) >= 0.01) {
        throw new Error(
          `Cannot mathematically absorb the difference within the product limits. Remaining drift: ₹${remainingDiff.toFixed(2)}`,
        );
      }

      // 6. Update modified invoices in database atomically
      for (const inv of modifiedInvoices) {
        // Enforce positive checks before committing
        if (inv.total_amount <= 0) {
          throw new Error(
            `Balancing generated an invalid invoice total amount: ${inv.total_amount}`,
          );
        }
        for (const p of inv.products) {
          if (p.quantity <= 0 || p.rate <= 0 || p.amount <= 0) {
            throw new Error(
              `Balancing generated invalid product metrics: qty=${p.quantity}, rate=${p.rate}, amount=${p.amount}`,
            );
          }
        }
      }

      const rpcUpdates = modifiedInvoices.map((inv) => ({
        id: inv.id,
        products: inv.products,
        total_amount: inv.total_amount,
        is_edited: inv.is_edited,
        edited_at: inv.edited_at,
      }));

      // 6.5. Pre-validate batch total invariant in-memory before submitting database updates
      const allInvoices = await fetchAllInvoicesForBatch(
        this.supabase,
        batchId,
        "id, total_amount",
      );

      if (!allInvoices || allInvoices.length === 0) {
        throw new Error(
          "Validation failed: Could not fetch invoices to verify batch total.",
        );
      }

      const { data: batchData } = await this.supabase
        .from("invoice_batch")
        .select("total_amount")
        .eq("id", batchId)
        .single();

      const expectedBatchTotal = Number(batchData?.total_amount || 0);

      const invoiceTotalsMap = new Map<string, number>();
      for (const inv of allInvoices) {
        invoiceTotalsMap.set(inv.id, Number(inv.total_amount));
      }

      // Apply the edited invoice updates (which aren't saved yet)
      if (editedInvoiceUpdates) {
        invoiceTotalsMap.set(
          editedInvoiceId,
          Number(editedInvoiceUpdates.total_amount),
        );
      }

      // Apply rebalancing updates
      for (const update of rpcUpdates) {
        invoiceTotalsMap.set(update.id, Number(update.total_amount));
      }

      let calculatedBatchTotal = 0;
      for (const amount of invoiceTotalsMap.values()) {
        calculatedBatchTotal += amount;
      }
      calculatedBatchTotal = Math.round(calculatedBatchTotal * 100) / 100;

      if (Math.abs(calculatedBatchTotal - expectedBatchTotal) > 0.01) {
        throw new Error(
          `Batch total mismatch: expected ₹${expectedBatchTotal.toFixed(2)}, calculated ₹${calculatedBatchTotal.toFixed(2)} (diff: ₹${(calculatedBatchTotal - expectedBatchTotal).toFixed(2)})`,
        );
      }

      if (editedInvoiceUpdates) {
        const { error: rpcError } = await this.supabase.rpc(
          "save_and_balance_invoices",
          {
            edited_invoice_id: editedInvoiceId,
            edited_invoice_data: editedInvoiceUpdates,
            balancing_updates: rpcUpdates,
          },
        );
        if (rpcError) {
          console.error(
            "Failed to execute atomic save & balance RPC:",
            rpcError,
          );
          throw new Error(`Database transaction error: ${rpcError.message}`);
        }
      } else {
        const { error: rpcError } = await this.supabase.rpc(
          "atomic_balance_invoices",
          {
            updates: rpcUpdates,
          },
        );
        if (rpcError) {
          console.error("Failed to execute atomic balance RPC:", rpcError);
          throw new Error(`Database transaction error: ${rpcError.message}`);
        }
      }

      return {
        success: true,
        modifiedInvoicesCount: modifiedInvoices.length,
        message: `Successfully balanced. Adjusted ${modifiedInvoices.length} invoices.`,
      };
    } finally {
      // 7. Always unlock the batch
      await this.unlockBatch(batchId);
    }
  }

  private async lockBatch(batchId: string, userId: string): Promise<boolean> {
    const { data: batch } = await this.supabase
      .from("invoice_batch")
      .select("is_balancing")
      .eq("id", batchId)
      .single();

    if (batch?.is_balancing) {
      return false; // Already locked
    }

    const { error } = await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: true,
        balancing_locked_at: new Date().toISOString(),
        balancing_locked_by: userId,
      })
      .eq("id", batchId)
      .eq("is_balancing", false); // Optimistic concurrency check

    return !error;
  }

  private async unlockBatch(batchId: string): Promise<void> {
    await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: false,
        balancing_locked_at: null,
        balancing_locked_by: null,
      })
      .eq("id", batchId);
  }

  private selectRandomInvoices(invoices: Invoice[]): Invoice[] {
    const minPercent = 0.1;
    const maxPercent = 0.3;
    const percentage = Math.random() * (maxPercent - minPercent) + minPercent;

    let targetCount = Math.ceil(invoices.length * percentage);
    // Ensure we select at least one if there are invoices
    if (targetCount === 0 && invoices.length > 0) targetCount = 1;

    const shuffled = [...invoices];
    this.shuffleArray(shuffled);
    return shuffled.slice(0, targetCount);
  }

  private adjustInvoice(
    invoice: Invoice,
    targetDiff: number,
    rulesMap: Map<string, ProductRule>,
  ): { modified: boolean; appliedDiff: number } {
    let appliedDiff = 0;
    let modified = false;

    // Shuffle products so we don't always hit the first product line
    const productIndices = Array.from(
      { length: invoice.products.length },
      (_, i) => i,
    );
    this.shuffleArray(productIndices);

    for (const idx of productIndices) {
      if (Math.abs(targetDiff - appliedDiff) < 0.01) break;

      const product = invoice.products[idx];
      if (!product.product_id) continue;

      const rule = rulesMap.get(product.product_id);
      if (!rule) continue;

      const remainingNeeded = targetDiff - appliedDiff;

      // Step 1: Try adjusting rate
      const rateDiff = this.attemptRateAdjustment(
        product,
        rule,
        remainingNeeded,
      );
      if (Math.abs(rateDiff) > 0) {
        appliedDiff += rateDiff;
        modified = true;
      }

      // Step 2: Try adjusting quantity if still need more
      const stillNeeded = targetDiff - appliedDiff;
      if (Math.abs(stillNeeded) >= 0.01) {
        const qtyDiff = this.attemptQuantityAdjustment(
          product,
          rule,
          stillNeeded,
        );
        if (Math.abs(qtyDiff) > 0) {
          appliedDiff += qtyDiff;
          modified = true;
        }
      }
    }

    if (modified) {
      // Recalculate invoice total to 2 decimal places
      const totalBeforeTax = invoice.products.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0,
      );
      invoice.total_amount = Math.round(totalBeforeTax * 100) / 100; // CGST/SGST are "Nil" currently
    }

    return { modified, appliedDiff };
  }

  private attemptRateAdjustment(
    product: Product,
    rule: ProductRule,
    targetDiff: number,
  ): number {
    const qty = Number(product.quantity);
    if (qty <= 0) return 0;

    const currentRate = Number(product.rate);
    const minRate = Math.max(
      0.01,
      isNaN(Number(rule.rate_min)) ? 0.01 : Number(rule.rate_min),
    );
    const maxRate = Number(rule.rate_max);

    // How much rate change do we need to perfectly hit targetDiff?
    const requiredRateChange = targetDiff / qty;
    let newRate = currentRate + requiredRateChange;

    // Clamp to min/max
    if (newRate < minRate) newRate = minRate;
    if (newRate > maxRate) newRate = maxRate;

    // Round rate to 2 decimal places to be realistic
    newRate = Math.round(newRate * 100) / 100;

    if (newRate === currentRate) return 0;

    const newAmount = Math.round(qty * newRate * 100) / 100;
    const currentAmount = Number(product.amount);

    product.rate = newRate;
    product.amount = newAmount;

    return newAmount - currentAmount;
  }

  private attemptQuantityAdjustment(
    product: Product,
    rule: ProductRule,
    targetDiff: number,
  ): number {
    const rate = Number(product.rate);
    if (rate <= 0) return 0;

    const currentQty = Number(product.quantity);
    const minQty = Math.max(
      0.01,
      isNaN(Number(rule.quantity_min)) ? 0.01 : Number(rule.quantity_min),
    );
    const maxQty = Number(rule.quantity_max);

    // How much qty change do we need?
    const requiredQtyChange = targetDiff / rate;
    let newQty = currentQty + requiredQtyChange;

    // Clamp to min/max
    if (newQty < minQty) newQty = minQty;
    if (newQty > maxQty) newQty = maxQty;

    // Preserve 2 decimal places
    newQty = Math.round(newQty * 100) / 100;

    if (newQty === currentQty) return 0;

    const newAmount = Math.round(newQty * rate * 100) / 100;
    const currentAmount = Number(product.amount);

    product.quantity = newQty;
    product.amount = newAmount;

    return newAmount - currentAmount;
  }

  private shuffleArray(array: any[]) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}
