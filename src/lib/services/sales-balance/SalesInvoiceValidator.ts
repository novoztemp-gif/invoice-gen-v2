import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllInvoicesForBatch, fetchAllQueryRows } from "@/lib/supabase/fetchAll";
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
          // A minimum commercial order quantity only matters at GENERATION
          // time (enforced separately in InvoiceEngine.ts) — it must never
          // block EDITING/balancing an already-generated batch. The only
          // invariants balancing has to hold are the batch's total amount
          // and each product's total quantity staying exactly conserved;
          // individual lines are free to carry any fractional quantity
          // (down to the 0.25kg commercial step) while redistributing.
          quantityMin: 0,
          quantityMax: r?.quantity_max ? Number(r.quantity_max) : 1000,
          rateMin: r?.rate_min ? Number(r.rate_min) : 1,
          rateMax: r?.rate_max ? Number(r.rate_max) : 10000,
        });
      }
    }

    // Load stock ledger for available stock
    const availableStockMap = new Map<string, number>();
    const totalPurchasedByProduct = new Map<string, number>();
    const stockSourceStr = batch.stock_source_batch_id;

    if (stockSourceStr) {
      const stockBatchIds = stockSourceStr
        .split(",")
        .map((id: string) => id.trim())
        .filter((id: string) => Boolean(id));

      if (stockBatchIds.length > 0) {
        // Paginated — a source batch with many products/days easily
        // exceeds PostgREST's default 1000-row cap, which would silently
        // drop whichever products' rows fell past the cutoff.
        const ledgerRows = await fetchAllQueryRows((from, to) =>
          supabase
            .from("daily_stock_ledger")
            .select(
              "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
            )
            .in("purchase_batch_id", stockBatchIds)
            .order("ledger_date", { ascending: true })
            .order("product_id", { ascending: true })
            .range(from, to),
        );

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

            // True physical ceiling for this product, batch-wide, ignoring
            // date: opening stock of the very first ledger row plus every
            // day's purchased_quantity. Balancing no longer cares which day
            // a unit lands on, but it must never — in aggregate — sell more
            // of a product than was ever actually purchased.
            totalPurchasedByProduct.set(
              pId,
              (Number(rows[0].opening_stock) || 0) +
                rows.reduce(
                  (s: number, r: any) => s + Number(r.purchased_quantity || 0),
                  0,
                ),
            );

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

    const majorCustomerIds = new Set<string>(
      (batch.major_customers || [])
        .map((m: any) => m.customer_id)
        .filter(Boolean),
    );

    return {
      batchId: String(batch.id),
      batchTotal: Number(batch.total_amount || 0),
      thresholdMin: Number(batch.minimum_invoice_amount || 0),
      thresholdMax: Number(batch.maximum_invoice_amount || 0),
      stockSourceBatchId: stockSourceStr ? String(stockSourceStr) : null,
      originalProductTotals,
      availableStockMap,
      totalPurchasedByProduct,
      invoices,
      constraints,
      majorCustomerIds,
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
          originalLine?.unit_of_measure ||
          rawLine.unit_of_measure ||
          constraint?.unitOfMeasure ||
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
    original?: SalesInvoice,
  ): { valid: boolean; message?: string } {
    // A product can legitimately appear more than once on the same invoice
    // (two lines for the same product, e.g. under different customers). A
    // flat Map keyed by product_id would collapse duplicates down to just
    // the LAST original line, so comparing an EARLIER duplicate's current
    // value against it produces a false "changed" reading — incorrectly
    // subjecting an untouched line to today's bounds instead of grandfathering
    // it. Keep every original line per product_id, matched back up by
    // occurrence order (preserved end-to-end for untouched duplicates).
    const originalLinesByPid = new Map<string, SalesLine[]>();
    for (const line of original?.products || []) {
      const arr = originalLinesByPid.get(line.product_id) || [];
      arr.push(line);
      originalLinesByPid.set(line.product_id, arr);
    }
    const occurrenceSeen = new Map<string, number>();
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

    for (const p of invoice.products) {
      const occIdx = occurrenceSeen.get(p.product_id) || 0;
      occurrenceSeen.set(p.product_id, occIdx + 1);

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

      // Rule 10: Duplicate products check — grandfathered the same way rate/
      // quantity bounds are: a duplicate that already existed before this
      // edit (this occurrence count doesn't exceed what the original invoice
      // already had) isn't something this edit introduced or can silently
      // fix, so it must not block editing an unrelated product on the same
      // batch. A NEW duplicate (no original invoice, or more occurrences
      // than the original had) is still rejected outright.
      const originalOccurrenceCount =
        originalLinesByPid.get(p.product_id)?.length || 0;
      if (occIdx > 0 && occIdx >= originalOccurrenceCount) {
        return {
          valid: false,
          message: `Duplicate Product Error: Product "${p.product_name}" appears multiple times on invoice ${invoice.invoice_number || invoice.id}.`,
        };
      }

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

      // Rule 5: Line Amount validation — amounts are whole-rupee (see
      // computeLineAmount, which is what actually sets p.amount upstream in
      // normaliseEditedInvoice/the solver/repair). Comparing against a
      // 2-decimal roundMoney here instead would spuriously reject any line
      // whose quantity × rate isn't already an exact whole rupee (e.g.
      // 14.25 × 158 = 2251.5 rounds to 2252, which 2-decimal rounding would
      // never match).
      if (
        p.amount <= 0 ||
        computeLineAmount(p.quantity, p.rate) !== p.amount
      ) {
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
      // Bounds can be tightened after an invoice is saved. A line the user
      // didn't actually change (same quantity/rate as originally saved)
      // keeps whatever value was already valid at save time — otherwise a
      // rule change would permanently block editing older invoices.
      if (constraints) {
        const constraint = constraints.get(p.product_id);
        const origLine = originalLinesByPid.get(p.product_id)?.[occIdx];
        const quantityUnchanged =
          origLine !== undefined &&
          Math.abs(origLine.quantity - p.quantity) < 0.001;
        const rateUnchanged =
          origLine !== undefined && Math.abs(origLine.rate - p.rate) < 0.001;
        if (constraint) {
          if (
            !quantityUnchanged &&
            (p.quantity < constraint.quantityMin ||
              p.quantity > constraint.quantityMax)
          ) {
            return {
              valid: false,
              message: `Product Rule Violation: Product "${p.product_name}" quantity (${p.quantity}) is outside allowed bounds [${constraint.quantityMin}, ${constraint.quantityMax}].`,
            };
          }
          if (
            !rateUnchanged &&
            (p.rate < constraint.rateMin || p.rate > constraint.rateMax)
          ) {
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
