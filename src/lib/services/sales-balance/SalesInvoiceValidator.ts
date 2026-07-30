import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";
import {
  computeLineAmount,
  isValidQuarterIncrement,
  isValidWholeNumber,
  roundToQuarterIncrement,
} from "@/lib/utils/quantity-rate-utils";
import {
  roundMoney,
  SalesBalanceContext,
  SalesInvoice,
  SalesInvoiceUpdate,
  SalesLine,
  SalesProductConstraint,
} from "./types";

export class SalesInvoiceValidator {
  /**
   * Load context for a Sales batch (invoices, original product totals, available stock, and product constraints).
   */
  public static async loadContext(
    supabase: SupabaseClient,
    batchId: string,
  ): Promise<SalesBalanceContext> {
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      throw new Error(
        `Failed to load sales batch ${batchId}: ${batchError?.message || "Not found"}`,
      );
    }

    if (String(batch.batch_type || "").toUpperCase() !== "SALES") {
      throw new Error(
        "Atomic sales auto balance is available only for sales batches.",
      );
    }

    if (batch.batch_status === "FINALIZED") {
      throw new Error("Batch is finalized and read-only.");
    }

    const invoicesData = await fetchAllInvoicesForBatch(supabase, batchId);
    if (!invoicesData || invoicesData.length === 0) {
      throw new Error("Sales batch contains no invoices.");
    }

    const invoices: SalesInvoice[] = invoicesData.map((inv: any) => ({
      id: String(inv.id),
      invoice_batch_id: String(inv.invoice_batch_id),
      invoice_number: String(inv.invoice_number || ""),
      invoice_date: String(inv.invoice_date || ""),
      products: Array.isArray(inv.products)
        ? inv.products.map((p: any) => ({
            product_id: String(p.product_id),
            product_name: p.product_name ? String(p.product_name) : undefined,
            hsn_code: p.hsn_code ? String(p.hsn_code) : undefined,
            unit_of_measure: p.unit_of_measure
              ? String(p.unit_of_measure)
              : undefined,
            category: p.category ? String(p.category) : undefined,
            quantity: Number(p.quantity || 0),
            rate: Number(p.rate || 0),
            amount: Number(p.amount || 0),
            customer_id: p.customer_id ? String(p.customer_id) : undefined,
          }))
        : [],
      total_amount: Number(inv.total_amount || 0),
      transport_mode: inv.transport_mode ?? null,
      vehicle_number: inv.vehicle_number ?? null,
      date_of_supply: inv.date_of_supply ?? null,
    }));

    // Compute original total sold quantity per product across the batch
    const originalProductTotals = new Map<string, number>();
    const productIds = new Set<string>();

    for (const inv of invoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          productIds.add(p.product_id);
          originalProductTotals.set(
            p.product_id,
            roundToQuarterIncrement(
              (originalProductTotals.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
      }
    }

    // Load product constraints
    const constraints = new Map<string, SalesProductConstraint>();

    if (productIds.size > 0) {
      const pIdArray = Array.from(productIds);
      const [{ data: rules }, { data: prods }] = await Promise.all([
        supabase
          .from("product_rules")
          .select("product_id, quantity_min, quantity_max, rate_min, rate_max")
          .in("product_id", pIdArray),
        supabase
          .from("products")
          .select("id, product_name, unit_of_measure, category, category_id")
          .in("id", pIdArray),
      ]);

      const ruleMap = new Map(
        (rules || []).map((r: any) => [String(r.product_id), r]),
      );
      const prodMap = new Map((prods || []).map((p: any) => [String(p.id), p]));

      for (const pid of pIdArray) {
        const r = ruleMap.get(pid);
        const p = prodMap.get(pid);

        constraints.set(pid, {
          productId: pid,
          category: String(p?.category || p?.category_id || "Meat"),
          unitOfMeasure: String(p?.unit_of_measure || "kg"),
          quantityMin: r?.quantity_min ? Number(r.quantity_min) : 0,
          quantityMax: r?.quantity_max ? Number(r.quantity_max) : 1000,
          rateMin: r?.rate_min ? Number(r.rate_min) : 1,
          rateMax: r?.rate_max ? Number(r.rate_max) : 10000,
        });
      }
    }

    // Load stock ledger for available stock
    const availableStockMap = new Map<string, number>();
    const stockSourceStr = batch.stock_source_batch_id;

    if (stockSourceStr) {
      const stockBatchIds = stockSourceStr
        .split(",")
        .map((id: string) => id.trim())
        .filter(
          (id: string) => Boolean(id) && !id.startsWith("CARRY_FORWARD_"),
        );

      if (stockBatchIds.length > 0) {
        const { data: ledgerRows } = await supabase
          .from("daily_stock_ledger")
          .select(
            "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          .in("purchase_batch_id", stockBatchIds)
          .order("ledger_date", { ascending: true });

        if (ledgerRows && ledgerRows.length > 0) {
          const productGroups = new Map<string, any[]>();
          for (const row of ledgerRows) {
            if (!productGroups.has(row.product_id)) {
              productGroups.set(row.product_id, []);
            }
            productGroups.get(row.product_id)!.push(row);
          }

          for (const [pId, rows] of productGroups.entries()) {
            rows.sort((a: any, b: any) =>
              a.ledger_date.localeCompare(b.ledger_date),
            );
            let carryForward = Number(rows[0].opening_stock) || 0;

            for (const row of rows) {
              const opening = carryForward;
              const purchased = Number(row.purchased_quantity || 0);
              const prevSold = Number(row.sold_quantity || 0);

              const availableBeforeCurrentBatch = Math.max(
                0,
                opening + purchased - prevSold,
              );
              const key = `${row.ledger_date}_${pId}`;
              availableStockMap.set(key, availableBeforeCurrentBatch);

              carryForward = availableBeforeCurrentBatch;
            }
          }
        }
      }
    }

    return {
      batchId: String(batch.id),
      batchTotal: Number(batch.total_amount || 0),
      stockSourceBatchId: stockSourceStr ? String(stockSourceStr) : null,
      originalProductTotals,
      availableStockMap,
      invoices,
      constraints,
    };
  }

  /**
   * Normalise edited invoice fields, preserving metadata and calculating line amounts.
   */
  public static normaliseEditedInvoice(
    context: SalesBalanceContext,
    editedInvoiceId: string,
    updates: SalesInvoiceUpdate,
  ): SalesInvoice {
    const originalInvoice = context.invoices.find(
      (i) => i.id === editedInvoiceId,
    );
    if (!originalInvoice) {
      throw new Error(
        `Edited invoice ${editedInvoiceId} does not exist in batch.`,
      );
    }

    const updatedLines: SalesLine[] = (updates.products || []).map(
      (rawLine) => {
        const pid = String(rawLine.product_id);
        const constraint = context.constraints.get(pid);
        const originalLine = originalInvoice.products.find(
          (p) => p.product_id === pid,
        );

        // Preserve original metadata to prevent client corruption
        const productName = originalLine?.product_name || rawLine.product_name;
        const hsnCode = originalLine?.hsn_code || rawLine.hsn_code;
        const uom =
          constraint?.unitOfMeasure ||
          originalLine?.unit_of_measure ||
          rawLine.unit_of_measure ||
          "kg";
        const category =
          constraint?.category || originalLine?.category || rawLine.category;

        const quantity = roundToQuarterIncrement(rawLine.quantity);
        const rate = roundMoney(rawLine.rate);
        const amount = computeLineAmount(quantity, rate);

        return {
          product_id: pid,
          product_name: productName,
          hsn_code: hsnCode,
          unit_of_measure: uom,
          category,
          quantity,
          rate,
          amount,
          customer_id: rawLine.customer_id || originalLine?.customer_id,
        };
      },
    );

    const calculatedTotal = roundMoney(
      updatedLines.reduce((sum, line) => sum + line.amount, 0),
    );

    return {
      ...originalInvoice,
      products: updatedLines,
      total_amount: calculatedTotal,
      transport_mode: updates.transport_mode ?? originalInvoice.transport_mode,
      vehicle_number: updates.vehicle_number ?? originalInvoice.vehicle_number,
      date_of_supply: updates.date_of_supply ?? originalInvoice.date_of_supply,
    };
  }

  /**
   * Validate that an invoice satisfies all 12 Sales Invoice business rules.
   */
  public static validateInvoice(
    invoice: SalesInvoice,
    constraints?: Map<string, SalesProductConstraint>,
  ): { valid: boolean; message?: string } {
    if (!invoice || invoice.total_amount <= 0) {
      return {
        valid: false,
        message:
          "Negative Amount / Total Error: Invoice total amount must be greater than zero.",
      };
    }

    if (!invoice.products || invoice.products.length === 0) {
      return {
        valid: false,
        message:
          "Missing Product Data: Invoice must contain at least one product line.",
      };
    }

    const seenPids = new Set<string>();

    for (const p of invoice.products) {
      // Rule 10: Missing mandatory fields
      if (
        !p.product_id ||
        !p.product_name ||
        !p.hsn_code ||
        !p.unit_of_measure
      ) {
        return {
          valid: false,
          message: `Missing Product Data: Product on invoice ${invoice.invoice_number || invoice.id} is missing mandatory metadata (ID, Name, HSN, or UOM).`,
        };
      }

      // Rule 10: Duplicate products check
      if (seenPids.has(p.product_id)) {
        return {
          valid: false,
          message: `Duplicate Product Error: Product "${p.product_name}" appears multiple times on invoice ${invoice.invoice_number || invoice.id}.`,
        };
      }
      seenPids.add(p.product_id);

      // Rule 9: Positive values check
      if (p.quantity <= 0) {
        return {
          valid: false,
          message: `Negative Quantity Error: Product "${p.product_name}" must have a positive quantity.`,
        };
      }
      if (p.rate <= 0) {
        return {
          valid: false,
          message: `Negative Rate Error: Product "${p.product_name}" rate must be greater than zero.`,
        };
      }

      // Rule 4: Rate validation (Must be whole integer)
      if (!isValidWholeNumber(p.rate)) {
        return {
          valid: false,
          message: `Invalid Rate: Product "${p.product_name}" rate (${p.rate}) must be a positive whole integer.`,
        };
      }

      // Rule 5: Line Amount validation
      if (p.amount <= 0 || roundMoney(p.quantity * p.rate) !== p.amount) {
        return {
          valid: false,
          message: `Line Amount Mismatch: Product "${p.product_name}" line amount (${p.amount}) does not equal quantity × rate.`,
        };
      }

      // Rule 1: Commercial Quantity validation
      const uom = p.unit_of_measure.toLowerCase();
      const isCountOrPackage = /nos|pcs|pkt|box|case|unit/i.test(uom);
      if (isCountOrPackage && !isValidWholeNumber(p.quantity)) {
        return {
          valid: false,
          message: `Commercial Quantity Invalid: Count/Package product "${p.product_name}" (${p.unit_of_measure}) must be a whole integer (found: ${p.quantity}).`,
        };
      }

      const isWeight = /kg|ton|g/i.test(uom);
      const isQuarterStep =
        Math.abs(p.quantity * 4 - Math.round(p.quantity * 4)) < 0.001;
      if (isWeight && !isQuarterStep) {
        return {
          valid: false,
          message: `Commercial Quantity Invalid: Weight product "${p.product_name}" quantity (${p.quantity}) violates quarter increment rules.`,
        };
      }

      // Rule 2: Product Rule Validation (Min/Max Quantity & Rate)
      if (constraints) {
        const constraint = constraints.get(p.product_id);
        if (constraint) {
          if (
            p.quantity < constraint.quantityMin ||
            p.quantity > constraint.quantityMax
          ) {
            return {
              valid: false,
              message: `Product Rule Violation: Product "${p.product_name}" quantity (${p.quantity}) is outside allowed bounds [${constraint.quantityMin}, ${constraint.quantityMax}].`,
            };
          }
          if (p.rate < constraint.rateMin || p.rate > constraint.rateMax) {
            return {
              valid: false,
              message: `Product Rule Violation: Product "${p.product_name}" rate (₹${p.rate}) is outside allowed bounds [₹${constraint.rateMin}, ₹${constraint.rateMax}].`,
            };
          }
        }
      }
    }

    // Rule 6: Invoice Total recalculation check
    const calculatedInvoiceTotal = roundMoney(
      invoice.products.reduce((sum, p) => sum + p.amount, 0),
    );
    if (Math.abs(calculatedInvoiceTotal - invoice.total_amount) >= 0.01) {
      return {
        valid: false,
        message: `Invoice Total Mismatch: Invoice ${invoice.invoice_number} calculated sum of lines (₹${calculatedInvoiceTotal}) does not match invoice total (₹${invoice.total_amount}).`,
      };
    }

    return { valid: true };
  }
}
