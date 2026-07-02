import { SupabaseClient } from "@supabase/supabase-js";

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
      const { data: allOtherInvoices, error: fetchError } = await this.supabase
        .from("invoice")
        .select("*")
        .eq("invoice_batch_id", batchId)
        .neq("id", editedInvoiceId);

      if (fetchError || !allOtherInvoices || allOtherInvoices.length === 0) {
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

      // If we STILL can't balance it, we must abort to maintain data integrity
      if (Math.abs(remainingDiff) >= 0.01) {
        throw new Error(
          `Cannot mathematically absorb the difference within the product limits. Remaining drift: ₹${remainingDiff.toFixed(2)}`,
        );
      }

      // 6. Update modified invoices in database
      for (const inv of modifiedInvoices) {
        const { error: updateError } = await this.supabase
          .from("invoice")
          .update({
            products: inv.products,
            total_amount: inv.total_amount,
            is_edited: inv.is_edited,
            edited_at: inv.edited_at,
          })
          .eq("id", inv.id);

        if (updateError) {
          console.error("Failed to update invoice:", updateError);
          throw new Error("Database error while updating balanced invoices.");
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
      // Recalculate invoice total
      const totalBeforeTax = invoice.products.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0,
      );
      invoice.total_amount = Math.round(totalBeforeTax); // CGST/SGST are "Nil" currently
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
    const minRate = Number(rule.rate_min);
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
    const minQty = Number(rule.quantity_min);
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
