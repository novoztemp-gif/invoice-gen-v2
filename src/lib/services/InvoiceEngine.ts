import { SupabaseClient } from "@supabase/supabase-js";
import { MAX_INVOICES_PER_BATCH } from "@/lib/constants/invoice";
import { fetchAllInvoicesForBatch, fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import {
  computeLineAmount,
  generateCommercialQuantity,
  isValidQuarterIncrement,
  isValidWholeNumber,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import { AutoBalanceEngine } from "./AutoBalanceEngine";
import { InvoiceNumberingService } from "./InvoiceNumberingService";
import { SalesAutoBalanceEngine } from "./SalesAutoBalanceEngine";

export interface ProductConfig {
  product_id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
  occurrencePercentage?: number | null;
}

export interface MajorCustomerConfig {
  customer_id: string;
  amount: number;
  invoice_count: number;
  max_invoice_amount?: number;
}

export interface RecurringProductConfig {
  product_id: string;
  percentage: number;
}

export interface InvoiceBatch {
  id: string;
  issuing_company_id: string;
  financial_year?: string;
  issuing_company_abbreviation?: string;
  invoice_date_from: string;
  invoice_date_to: string;
  minimum_invoice_amount: number;
  maximum_invoice_amount: number;
  total_amount: number;
  products: ProductConfig[];
  recurring_products?: RecurringProductConfig[] | null;
  selected_customers?: string[] | null;
  major_customers?: MajorCustomerConfig[] | null;
  receiving_company_id?: string | null;
  supplier_id?: string | null;
  batch_type?: string;
  stock_source_batch_id?: string | null;
}

export interface CreateBatchParams {
  issuingCompanyId: string;
  receivingCompanyId?: string | null;
  selectedCustomers: string[];
  majorCustomers: Array<{
    customer_id: string;
    amount: string | number;
    invoice_count: string | number;
    max_invoice_amount?: string | number;
  }>;
  transportMode: string;
  vehicleNumber?: string;
  invoiceDateFrom: Date | string;
  invoiceDateTo: Date | string;
  minimumInvoiceAmount: string | number;
  maximumInvoiceAmount: string | number;
  totalAmount: string | number;
  financialYearStart: number;
  financialYearEnd: number;
  products: Array<{
    product: {
      id: string;
      product_name: string;
      hsn_code: string;
      unit_of_measure: string;
    };
    perDayQtyMin: string | number;
    perDayQtyMax: string | number;
    perDayRateMin: string | number;
    perDayRateMax: string | number;
    occurrencePercentage?: string | number | null;
  }>;
  recurringProducts: Array<{
    product_id: string;
    percentage: string | number;
  }>;
  createdBy: string;
  batchType: "SALES" | "PURCHASE";
}

export interface ValidateBatchParams {
  products: Array<{
    product: {
      id: string;
      product_name: string;
      hsn_code: string;
      unit_of_measure: string;
    };
    perDayQtyMin: string | number;
    perDayQtyMax: string | number;
    perDayRateMin: string | number;
    perDayRateMax: string | number;
    occurrencePercentage?: string | number | null;
  }>;
  recurringProducts?: Array<{
    product_id: string;
    percentage: string | number;
  }>;
  majorCustomers?: MajorCustomerConfig[] | null;
  invoiceDateFrom: string;
  invoiceDateTo: string;
  minimumInvoiceAmount: string | number;
  maximumInvoiceAmount: string | number;
  totalAmount: string | number;
}

function formatDateForStorage(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class InvoiceEngine {
  /**
   * Validate parameters before batch creation
   */
  public static validateBatchParams(params: ValidateBatchParams): {
    isValid: boolean;
    message: string;
    details?: {
      numberOfDays: number;
      smallestProductMin: string;
      maxAmountPerDay: string;
      avgAmountPerDay: string;
      estimatedInvoices: number;
      maxThreshold: string;
    };
  } {
    const {
      products,
      recurringProducts = [],
      invoiceDateFrom,
      invoiceDateTo,
      minimumInvoiceAmount,
      maximumInvoiceAmount,
      totalAmount,
    } = params;

    const fromDate = new Date(invoiceDateFrom);
    const toDate = new Date(invoiceDateTo);

    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    if (numberOfDays <= 0) {
      return {
        isValid: false,
        message:
          "Invalid date range. 'From Date' must be before or equal to 'To Date'.",
      };
    }

    const minThreshold =
      typeof minimumInvoiceAmount === "string"
        ? parseFloat(minimumInvoiceAmount)
        : minimumInvoiceAmount;
    const maxThreshold =
      typeof maximumInvoiceAmount === "string"
        ? parseFloat(maximumInvoiceAmount)
        : maximumInvoiceAmount;
    const total =
      typeof totalAmount === "string" ? parseFloat(totalAmount) : totalAmount;

    const majorTotal = (params.majorCustomers || []).reduce(
      (sum, m) =>
        sum +
        (typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0),
      0,
    );

    if (total && !isNaN(total) && total > 0 && majorTotal > total) {
      return {
        isValid: false,
        message: `Major Customer Total (₹${majorTotal.toFixed(2)}) exceeds Purchase Batch Total (₹${total.toFixed(2)}). Remaining Batch Amount cannot be negative.`,
      };
    }

    for (const m of params.majorCustomers || []) {
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount > 0 && mInvCount > 0 && mMaxLimit > 0) {
        const maxPossible = mInvCount * mMaxLimit;
        if (maxPossible < mAmount) {
          return {
            isValid: false,
            message: `Major Customer configuration cannot satisfy requested amount. Customer requires ₹${mAmount.toFixed(2)} across ${mInvCount} invoice(s), but maximum possible total is ₹${maxPossible.toFixed(2)} (max limit ₹${mMaxLimit.toFixed(2)} per invoice).`,
          };
        }
      }
    }

    // Validation 1: Check if we have at least one product
    if (products.length === 0) {
      return {
        isValid: false,
        message: "No products selected. Please add at least one product.",
      };
    }

    // Calculate minimum and maximum possible amounts per day
    let smallestProductMin = Number.POSITIVE_INFINITY;
    let maxAmountPerDay = 0;

    for (const product of products) {
      const qtyMin =
        typeof product.perDayQtyMin === "string"
          ? parseFloat(product.perDayQtyMin)
          : product.perDayQtyMin;
      const qtyMax =
        typeof product.perDayQtyMax === "string"
          ? parseFloat(product.perDayQtyMax)
          : product.perDayQtyMax;
      const rateMin =
        typeof product.perDayRateMin === "string"
          ? parseFloat(product.perDayRateMin)
          : product.perDayRateMin;
      const rateMax =
        typeof product.perDayRateMax === "string"
          ? parseFloat(product.perDayRateMax)
          : product.perDayRateMax;

      // Minimum amount for this single product (smallest possible invoice)
      const productMinAmount = qtyMin * rateMin;
      if (productMinAmount < smallestProductMin) {
        smallestProductMin = productMinAmount;
      }

      // Maximum amount for this product per day
      maxAmountPerDay += qtyMax * rateMax;
    }

    // Validation 2: Check if threshold can accommodate at least one product
    if (smallestProductMin > maxThreshold) {
      return {
        isValid: false,
        message: `Maximum Invoice Amount (₹${maxThreshold.toFixed(2)}) is too small! Even the smallest product requires at least ₹${smallestProductMin.toFixed(2)} per day. Increase the Maximum Invoice Amount.`,
      };
    }

    // Validation 3: Calculate maximum total possible
    const maxTotalPossible = maxAmountPerDay * numberOfDays;

    if (total && !isNaN(total) && total > 0) {
      if (total > maxTotalPossible) {
        return {
          isValid: false,
          message: `Total amount (₹${total.toFixed(2)}) exceeds maximum possible! Maximum amount achievable for ${numberOfDays} day(s) is ₹${maxTotalPossible.toFixed(2)} (₹${maxAmountPerDay.toFixed(2)} per day maximum).`,
        };
      }

      // Validation 4: Check basic feasibility
      const avgAmountPerDay = total / numberOfDays;

      if (avgAmountPerDay > maxAmountPerDay) {
        return {
          isValid: false,
          message: `Average amount per day (₹${avgAmountPerDay.toFixed(2)}) exceeds maximum possible (₹${maxAmountPerDay.toFixed(2)}). Cannot generate invoices for all ${numberOfDays} day(s).`,
        };
      }
    }

    const hasTotal = total && !isNaN(total) && total > 0;
    const avgAmountPerDay = hasTotal ? total / numberOfDays : 0;
    const estimatedInvoicesPerDay = hasTotal
      ? Math.ceil(avgAmountPerDay / maxThreshold)
      : 0;
    const totalInvoicesEstimated = estimatedInvoicesPerDay * numberOfDays;

    if (totalInvoicesEstimated > MAX_INVOICES_PER_BATCH) {
      return {
        isValid: false,
        message: `Estimated batch size (${totalInvoicesEstimated.toLocaleString()} invoices) exceeds the maximum supported capacity of ${MAX_INVOICES_PER_BATCH.toLocaleString()} invoices per batch. Please adjust the total batch amount, threshold limits, or date range.`,
      };
    }

    return {
      isValid: true,
      message: hasTotal
        ? `✓ Validation successful! Estimated ${estimatedInvoicesPerDay}+ invoice(s) per day over ${numberOfDays} day(s).`
        : `✓ Validation successful for product and date range rules over ${numberOfDays} day(s).`,
      details: {
        numberOfDays,
        smallestProductMin: smallestProductMin.toFixed(2),
        maxAmountPerDay: maxAmountPerDay.toFixed(2),
        avgAmountPerDay: avgAmountPerDay.toFixed(2),
        estimatedInvoices: totalInvoicesEstimated,
        maxThreshold: maxThreshold.toFixed(2),
      },
    };
  }

  /**
   * Create an invoice batch record in the database
   */
  public static async createBatch(
    supabase: SupabaseClient,
    params: CreateBatchParams,
  ) {
    const {
      issuingCompanyId,
      receivingCompanyId = null,
      selectedCustomers,
      majorCustomers,
      transportMode,
      vehicleNumber = "",
      invoiceDateFrom,
      invoiceDateTo,
      minimumInvoiceAmount,
      maximumInvoiceAmount,
      totalAmount,
      financialYearStart,
      financialYearEnd,
      products,
      recurringProducts,
      createdBy,
      batchType,
    } = params;

    const resolvedPartyId =
      receivingCompanyId ||
      selectedCustomers[0] ||
      (majorCustomers[0] ? majorCustomers[0].customer_id : null);

    const isPurchase = batchType.toUpperCase() === "PURCHASE";

    const { data, error } = await supabase
      .from("invoice_batch")
      .insert({
        issuing_company_id: issuingCompanyId,
        supplier_id: isPurchase ? resolvedPartyId : null,
        receiving_company_id: isPurchase ? null : resolvedPartyId,
        selected_customers: selectedCustomers,
        major_customers: majorCustomers.map((m) => ({
          customer_id: m.customer_id,
          amount:
            typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0,
          invoice_count:
            typeof m.invoice_count === "string"
              ? parseInt(m.invoice_count, 10)
              : m.invoice_count || 1,
          max_invoice_amount:
            typeof m.max_invoice_amount === "string"
              ? parseFloat(m.max_invoice_amount)
              : m.max_invoice_amount || undefined,
        })),
        batch_type: batchType.toUpperCase(),
        transport_mode: transportMode,
        vehicle_number: vehicleNumber,
        date_of_supply: invoiceDateTo
          ? formatDateForStorage(invoiceDateTo)
          : formatDateForStorage(new Date()),
        invoice_date_from: invoiceDateFrom
          ? formatDateForStorage(invoiceDateFrom)
          : null,
        invoice_date_to: invoiceDateTo
          ? formatDateForStorage(invoiceDateTo)
          : null,
        minimum_invoice_amount:
          typeof minimumInvoiceAmount === "string"
            ? parseFloat(minimumInvoiceAmount)
            : minimumInvoiceAmount,
        maximum_invoice_amount:
          typeof maximumInvoiceAmount === "string"
            ? parseFloat(maximumInvoiceAmount)
            : maximumInvoiceAmount,
        total_amount:
          typeof totalAmount === "string"
            ? parseFloat(totalAmount)
            : totalAmount,
        financial_year: `FY${financialYearStart}-${String(financialYearEnd).slice(2)}`,
        products: products.map((item) => ({
          product_id: item.product.id,
          product_name: item.product.product_name,
          hsn_code: item.product.hsn_code,
          unit_of_measure: item.product.unit_of_measure,
          perDayQtyMin: item.perDayQtyMin.toString(),
          perDayQtyMax: item.perDayQtyMax.toString(),
          perDayRateMin: item.perDayRateMin.toString(),
          perDayRateMax: item.perDayRateMax.toString(),
          occurrencePercentage: item.occurrencePercentage
            ? typeof item.occurrencePercentage === "string"
              ? parseFloat(item.occurrencePercentage)
              : item.occurrencePercentage
            : null,
        })),
        recurring_products: recurringProducts.map((rp) => ({
          product_id: rp.product_id,
          percentage:
            typeof rp.percentage === "string"
              ? parseFloat(rp.percentage)
              : rp.percentage,
        })),
        status: "pending",
        created_by: createdBy,
      })
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return data;
  }

  /**
   * Update the status of a batch (FINALIZE or REOPEN)
   */
  public static async updateBatchStatus(
    supabase: SupabaseClient,
    batchId: string,
    action: "FINALIZE" | "REOPEN",
    userId: string,
  ) {
    const updates: any = {
      batch_status: action === "FINALIZE" ? "FINALIZED" : "REOPENED",
    };

    if (action === "FINALIZE") {
      updates.finalized_at = new Date().toISOString();
      updates.finalized_by = userId;
    } else {
      updates.reopened_at = new Date().toISOString();
      updates.reopened_by = userId;
    }

    const { data, error } = await supabase
      .from("invoice_batch")
      .update(updates)
      .eq("id", batchId)
      .select()
      .single();

    if (error) {
      throw new Error(error.message);
    }

    if (action === "FINALIZE" && data?.batch_type === "PURCHASE") {
      await this.postPurchaseBatchStockLedger(supabase, batchId);
    } else if (action === "REOPEN" && data?.batch_type === "PURCHASE") {
      await supabase
        .from("daily_stock_ledger")
        .delete()
        .eq("purchase_batch_id", batchId);
    }

    return data;
  }

  /**
   * Posts daily_stock_ledger records for each Purchase Invoice's exact invoice_date when a Purchase Batch is finalized.
   * Does NOT aggregate all quantities onto Day 1; saves exact purchase stock movements by date.
   */
  public static async postPurchaseBatchStockLedger(
    supabase: SupabaseClient,
    batchId: string,
  ) {
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      throw new Error(
        `Failed to load batch for stock ledger posting: ${batchError?.message || "Not found"}`,
      );
    }

    if (String(batch.batch_type || "").toUpperCase() !== "PURCHASE") {
      return;
    }

    const invoices = await fetchAllInvoicesForBatch(supabase, batchId);

    const productIds = new Set<string>();
    for (const p of batch.products || []) {
      if (p.product_id) productIds.add(p.product_id);
    }
    for (const inv of invoices || []) {
      for (const p of inv.products || []) {
        if (p.product_id) productIds.add(p.product_id);
      }
    }

    if (productIds.size === 0) {
      return;
    }

    const purchasedByDateAndProduct = new Map<string, number>();
    const invoiceDates = new Set<string>();

    for (const inv of invoices || []) {
      const dateStr = inv.invoice_date;
      if (dateStr) invoiceDates.add(dateStr);

      for (const p of inv.products || []) {
        if (p.product_id) {
          const qty = Number(p.quantity || 0);
          const key = `${dateStr}_${p.product_id}`;
          purchasedByDateAndProduct.set(
            key,
            (purchasedByDateAndProduct.get(key) || 0) + qty,
          );
        }
      }
    }

    let startDateStr = batch.invoice_date_from;
    let endDateStr = batch.invoice_date_to;

    if (!startDateStr || !endDateStr) {
      const sortedDates = Array.from(invoiceDates).sort();
      startDateStr =
        startDateStr || sortedDates[0] || new Date().toISOString().slice(0, 10);
      endDateStr =
        endDateStr || sortedDates[sortedDates.length - 1] || startDateStr;
    }

    const dateList: string[] = [];
    const curDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    while (curDate <= endDate) {
      dateList.push(curDate.toISOString().slice(0, 10));
      curDate.setDate(curDate.getDate() + 1);
    }

    await supabase
      .from("daily_stock_ledger")
      .delete()
      .eq("purchase_batch_id", batchId);

    const ledgerRows: any[] = [];

    for (const productId of productIds) {
      for (const dateStr of dateList) {
        const key = `${dateStr}_${productId}`;
        const purchasedQty =
          Math.round((purchasedByDateAndProduct.get(key) || 0) * 100) / 100;

        ledgerRows.push({
          purchase_batch_id: batchId,
          ledger_date: dateStr,
          product_id: productId,
          opening_stock: 0,
          purchased_quantity: purchasedQty,
          sold_quantity: 0,
        });
      }
    }

    if (ledgerRows.length > 0) {
      const { error: insertError } = await supabase
        .from("daily_stock_ledger")
        .insert(ledgerRows);

      if (insertError) {
        throw new Error(
          `Failed to insert daily stock ledger rows: ${insertError.message}`,
        );
      }
    }
  }

  /**
   * Validate that all quantities, rates, line amounts, and invoice totals are strictly greater than zero.
   */
  public static validateInvoiceData(invoice: any): {
    isValid: boolean;
    message: string;
  } {
    if (!invoice) {
      return { isValid: false, message: "Invoice is null or undefined." };
    }

    const totalAmount = Number(invoice.total_amount);
    if (isNaN(totalAmount) || totalAmount <= 0) {
      return {
        isValid: false,
        message: `Invoice total amount must be greater than zero. Found: ${invoice.total_amount}`,
      };
    }

    if (!Array.isArray(invoice.products) || invoice.products.length === 0) {
      return {
        isValid: false,
        message: "Invoice must contain at least one product line.",
      };
    }

    for (let i = 0; i < invoice.products.length; i++) {
      const p = invoice.products[i];
      const qty = Number(p.quantity);
      const rate = Number(p.rate);
      const amount = Number(p.amount);

      if (isNaN(qty) || qty <= 0) {
        return {
          isValid: false,
          message: `Product "${p.product_name || p.product_id || i}" has invalid quantity: ${p.quantity}. Must be greater than zero.`,
        };
      }

      if (isNaN(rate) || rate <= 0) {
        return {
          isValid: false,
          message: `Product "${p.product_name || p.product_id || i}" has invalid rate: ${p.rate}. Must be greater than zero.`,
        };
      }

      if (!isValidWholeNumber(rate)) {
        return {
          isValid: false,
          message: `Rate must be a whole number.\n\nDecimal rates are not permitted.\n\nFound: ${rate}`,
        };
      }

      if (isNaN(amount) || amount <= 0) {
        return {
          isValid: false,
          message: `Product "${p.product_name || p.product_id || i}" has invalid line amount: ${p.amount}. Must be greater than zero.`,
        };
      }
    }

    return { isValid: true, message: "OK" };
  }

  /**
   * Save an edited invoice and rebalance the rest of the batch if needed
   */
  public static async saveInvoiceAndRebalance(
    supabase: SupabaseClient,
    batchId: string,
    invoiceId: string,
    updates: any,
    userId: string,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
  }> {
    // 1. Check if batch is finalized and get batch_type
    const { data: batchCheck } = await supabase
      .from("invoice_batch")
      .select("batch_status, batch_type")
      .eq("id", batchId)
      .single();

    if (batchCheck?.batch_status === "FINALIZED") {
      throw new Error("Batch is finalized and read-only.");
    }

    // Run strict validation on updates
    const validation = this.validateInvoiceData(updates);
    if (!validation.isValid) {
      throw new Error(validation.message);
    }

    // 2. Fetch original invoice to get its original total/products before saving
    const { data: originalInvoice } = await supabase
      .from("invoice")
      .select("total_amount, invoice_number, products")
      .eq("id", invoiceId)
      .single();

    if (
      updates.invoice_number &&
      originalInvoice?.invoice_number &&
      updates.invoice_number !== originalInvoice.invoice_number
    ) {
      throw new Error(
        "Invoice Numbers are permanent and system-generated. Modifying invoice numbers is prohibited.",
      );
    }

    const originalTotal = Number(originalInvoice?.total_amount || 0);
    const newTotal = Number(updates.total_amount || 0);

    // A product swap (e.g. -5kg Orange, +equivalent-value Apple) can leave
    // the invoice's own total_amount unchanged while still needing full
    // cross-invoice rebalancing to keep each product's batch-wide total
    // conserved — checking total_amount alone would let this through as a
    // plain, unbalanced update.
    const originalProducts: any[] = Array.isArray(originalInvoice?.products)
      ? originalInvoice.products
      : [];
    const newProducts: any[] = Array.isArray(updates.products)
      ? updates.products
      : [];
    const productsChanged = (() => {
      if (originalProducts.length !== newProducts.length) return true;
      const origByPid = new Map(
        originalProducts.map((p: any) => [p.product_id, p]),
      );
      for (const p of newProducts) {
        const orig = origByPid.get(p.product_id);
        if (!orig) return true;
        if (
          Math.abs(Number(p.quantity || 0) - Number(orig.quantity || 0)) >
            0.001 ||
          Math.abs(Number(p.rate || 0) - Number(orig.rate || 0)) > 0.001
        ) {
          return true;
        }
      }
      return false;
    })();

    // 3. Save and Rebalance atomically if the total or product composition
    // changed, otherwise perform a single update (e.g. transport details only).
    if (originalTotal !== newTotal || productsChanged) {
      if (batchCheck?.batch_type === "SALES") {
        const salesEngine = new SalesAutoBalanceEngine(supabase);
        return await salesEngine.saveEditedInvoiceAndBalance(
          batchId,
          invoiceId,
          updates,
          userId,
        );
      } else {
        const targetDiff = originalTotal - newTotal;
        const engine = new AutoBalanceEngine(supabase);
        const editedInvoiceUpdates = {
          products: updates.products,
          total_amount: updates.total_amount,
          is_edited: true,
          edited_at: new Date().toISOString(),
        };
        return await engine.balanceBatch(
          batchId,
          invoiceId,
          targetDiff,
          userId,
          editedInvoiceUpdates,
        );
      }
    } else {
      const { error: updateError } = await supabase
        .from("invoice")
        .update({
          ...updates,
          is_edited: true,
          edited_at: new Date().toISOString(),
        })
        .eq("id", invoiceId);

      if (updateError) {
        throw new Error(`Failed to update invoice: ${updateError.message}`);
      }
    }

    return {
      success: true,
      modifiedInvoicesCount: 0,
      message: "Invoice updated successfully. No rebalancing was required.",
    };
  }

  /**
   * Dynamically calculate continuous carry-forward stock from all past daily stock ledger records
   */
  public static async getCarryForwardStock(
    supabase: SupabaseClient,
    currentBatchFromDate: string,
  ): Promise<Map<string, number>> {
    const carryForwardMap = new Map<string, number>();

    // Load all ledger rows before currentBatchFromDate. Paginated —
    // easily exceeds PostgREST's default 1000-row cap.
    const ledgerRows = await fetchAllQueryRows((from, to) =>
      supabase
        .from("daily_stock_ledger")
        .select("product_id, purchased_quantity, sold_quantity, ledger_date")
        .lt("ledger_date", currentBatchFromDate)
        .range(from, to),
    );

    if (!ledgerRows || ledgerRows.length === 0) {
      return carryForwardMap;
    }

    const netStockMap = new Map<string, { purchased: number; sold: number }>();

    for (const row of ledgerRows) {
      const pId = row.product_id;
      const current = netStockMap.get(pId) || { purchased: 0, sold: 0 };
      current.purchased += Number(row.purchased_quantity || 0);
      current.sold += Number(row.sold_quantity || 0);
      netStockMap.set(pId, current);
    }

    for (const [pId, totals] of netStockMap.entries()) {
      const netRemaining = Math.max(0, totals.purchased - totals.sold);
      carryForwardMap.set(pId, Math.round(netRemaining * 100) / 100);
    }

    return carryForwardMap;
  }

  /**
   * Validate that proposed invoice quantities do not exceed total available stock per product
   */
  public static validateStockLimits(
    proposedInvoices: any[],
    availableStockMap: Map<string, number>,
  ): { isValid: boolean; message?: string; exceedDetails?: any[] } {
    const proposedSums = new Map<string, number>();

    for (const inv of proposedInvoices || []) {
      for (const p of inv.products || []) {
        proposedSums.set(
          p.product_id,
          (proposedSums.get(p.product_id) || 0) + Number(p.quantity || 0),
        );
      }
    }

    const exceeds: any[] = [];
    for (const [pId, proposedQty] of proposedSums.entries()) {
      const available = availableStockMap.get(pId) || 0;
      if (proposedQty > available + 0.001) {
        exceeds.push({
          productId: pId,
          proposed: proposedQty,
          available: available,
          deficit: Math.round((proposedQty - available) * 100) / 100,
        });
      }
    }

    if (exceeds.length > 0) {
      return {
        isValid: false,
        message:
          "Stock allocation exceeds available inventory for one or more products.",
        exceedDetails: exceeds,
      };
    }

    return { isValid: true };
  }

  // Purchase/sales generation draws heavily on Math.random() for supplier
  // assignment, product selection, and budget partitioning, so the strict
  // pre-persistence guards (max amount, batch total, major customer exact
  // balance, line-count, category) occasionally reject a single random draw
  // even though the batch configuration itself is perfectly feasible — a
  // different draw succeeds. Rather than surface that as an error to a user
  // who can't do anything about it besides clicking "Generate" again,
  // transparently retry with a fresh draw a bounded number of times. A
  // configuration that's genuinely infeasible (e.g. minimum invoice amount
  // unreachable within Product Rules) fails identically on every attempt and
  // still surfaces after the budget is exhausted.
  private static readonly MAX_GENERATION_ATTEMPTS = 8;

  private static generateWithAutoRetry<T>(generate: () => T): T {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        return generate();
      } catch (err) {
        lastError = err;
        if (attempt < this.MAX_GENERATION_ATTEMPTS) {
          console.warn(
            `[generateWithAutoRetry] Attempt ${attempt}/${this.MAX_GENERATION_ATTEMPTS} failed, retrying with a fresh draw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    throw lastError;
  }

  /**
   * Generate invoice split-ups and save them to the database
   */
  public static async generateAndSaveInvoices(
    supabase: SupabaseClient,
    batchId: string,
  ) {
    // Fetch batch details
    const { data: batch, error: batchError } = await supabase
      .from("invoice_batch")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError || !batch) {
      throw new Error("Batch not found");
    }

    // If batch_status is null or FINALIZED, reset batch_status to draft so RLS allows regenerating/saving invoices
    if (
      !(batch as any).batch_status ||
      (batch as any).batch_status === "FINALIZED"
    ) {
      await supabase
        .from("invoice_batch")
        .update({ batch_status: "draft" })
        .eq("id", batchId);
      (batch as any).batch_status = "draft";
    }

    const typedBatch = batch as unknown as InvoiceBatch;

    // STEP 1: Immediately after reading the batch
    console.log("=========================");
    console.log("STEP 1: READ BATCH");
    console.log("=========================");
    console.log({
      previousEndingSequence: (typedBatch as any).previous_ending_sequence,
      rawBatchPreviousEndingSequence: (typedBatch as any)
        .previous_ending_sequence,
    });

    if (!typedBatch.products || typedBatch.products.length === 0) {
      throw new Error(
        "No products found in batch. The products field may not have been saved.",
      );
    }

    // Calculate number of days
    const fromDate = new Date(typedBatch.invoice_date_from);
    const toDate = new Date(typedBatch.invoice_date_to);
    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    const invType: "P" | "S" = typedBatch.batch_type === "PURCHASE" ? "P" : "S";
    const canonicalFy = InvoiceNumberingService.normalizeFinancialYear(
      typedBatch.financial_year || "2026-27",
    );

    if (typedBatch.issuing_company_id) {
      const { data: company } = await supabase
        .from("issuing_companies")
        .select("abbreviation, company_name")
        .eq("id", typedBatch.issuing_company_id)
        .single();

      if (company) {
        (typedBatch as any).issuing_company_abbreviation =
          company.abbreviation ||
          company.company_name
            .substring(0, 4)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "");
      }
    }

    // Manual Sequence Override or Auto-Detection of Highest Existing Sequence Number
    const prevEndingSeq = (typedBatch as any).previous_ending_sequence;
    let startingCounter = 1;
    const isManualSequenceOverride =
      prevEndingSeq !== undefined &&
      prevEndingSeq !== null &&
      prevEndingSeq !== "" &&
      !isNaN(Number(prevEndingSeq)) &&
      Number(prevEndingSeq) >= 0;

    if (isManualSequenceOverride) {
      startingCounter = Number(prevEndingSeq) + 1;
    } else {
      const debugAbbr =
        (typedBatch as any).issuing_company_abbreviation || "IC";
      const prefix = `${debugAbbr}-${canonicalFy}-${invType}`;

      let maxSeq = 0;
      let page = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const { data: pageInvoices } = await supabase
          .from("invoice")
          .select("invoice_number")
          .like("invoice_number", `${prefix}-%`)
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (pageInvoices && pageInvoices.length > 0) {
          for (const row of pageInvoices) {
            const parts = (row.invoice_number || "").split("-");
            const seqNum = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(seqNum) && seqNum > maxSeq) {
              maxSeq = seqNum;
            }
          }
          if (pageInvoices.length < pageSize) {
            hasMore = false;
          } else {
            page++;
          }
        } else {
          hasMore = false;
        }
      }
      startingCounter = maxSeq + 1;
    }

    // STEP 2: Immediately before invoice numbers are generated
    console.log("=========================");
    console.log("STEP 2: BEFORE GENERATION");
    console.log("=========================");
    const debugAbbr = (typedBatch as any).issuing_company_abbreviation || "IC";
    console.log({
      startingCounter,
      firstInvoiceNumber: InvoiceNumberingService.formatInvoiceNumber(
        debugAbbr,
        canonicalFy,
        invType,
        startingCounter,
      ),
    });

    let invoices: any[] = [];
    if (typedBatch.batch_type === "PURCHASE") {
      const supplierCategoryMap = new Map<string, "Fruits" | "Meat">();
      const selectedCustomers = typedBatch.selected_customers || [];
      const majorCustomers = typedBatch.major_customers || [];

      const supplierIdsToFetch = new Set<string>();
      for (const id of selectedCustomers) supplierIdsToFetch.add(id);
      for (const m of majorCustomers) {
        if (m.customer_id) supplierIdsToFetch.add(m.customer_id);
      }
      if (typedBatch.supplier_id)
        supplierIdsToFetch.add(typedBatch.supplier_id);
      if (typedBatch.receiving_company_id)
        supplierIdsToFetch.add(typedBatch.receiving_company_id);

      if (supplierIdsToFetch.size > 0) {
        const { data: sups } = await supabase
          .from("suppliers")
          .select("id, category")
          .in("id", Array.from(supplierIdsToFetch));

        for (const s of sups || []) {
          const cat = String(s.category || "Meat")
            .toUpperCase()
            .includes("FRUIT")
            ? "Fruits"
            : "Meat";
          supplierCategoryMap.set(s.id, cat);
        }
      }

      invoices = this.generateWithAutoRetry(() =>
        this.generatePurchaseInvoiceSplitupsInternal(
          typedBatch,
          numberOfDays,
          fromDate,
          startingCounter,
          undefined,
          supplierCategoryMap,
        ),
      );
    } else {
      let availableStockMap: Map<string, any> | null = null;
      // True physical ceiling per product (opening stock + every day's
      // purchased_quantity, batch-wide, ignoring date) — a final safety
      // check compares total GENERATED quantity per product against this
      // after generation completes, so a bug in the per-day sourcing logic
      // (like the ledger pagination tie-break bug fixed alongside this)
      // gets caught loudly instead of silently over-selling stock.
      const totalPurchasedByProductForCheck = new Map<string, number>();
      if (typedBatch.stock_source_batch_id) {
        const batchIds = typedBatch.stock_source_batch_id
          .split(",")
          .map((id: string) => id.trim())
          .filter((id: string) => Boolean(id));

        let ledgerData: any[] = [];
        try {
          ledgerData = await fetchAllQueryRows((from, to) =>
            supabase
              .from("daily_stock_ledger")
              .select(
                "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
              )
              .in(
                "purchase_batch_id",
                batchIds.length > 0
                  ? batchIds
                  : [typedBatch.stock_source_batch_id],
              )
              // Ordering by ledger_date ALONE is not deterministic across
              // separate paginated .range() calls when many rows share the
              // same date (every product purchased that day) — Postgres is
              // free to break ties differently per page query, so a
              // same-date row can land in two consecutive pages (counted
              // twice, inflating that product's available stock) or in
              // neither (dropped, starving it) once the ledger exceeds a
              // page size. product_id as a secondary sort key makes the
              // order — and therefore the pagination split — stable.
              .order("ledger_date", { ascending: true })
              .order("product_id", { ascending: true })
              .range(from, to),
          );
        } catch (err: any) {
          throw new Error(
            `Failed to load daily stock ledger: ${err?.message || "Unknown error"}`,
          );
        }

        let effectiveLedger = ledgerData || [];

        if (effectiveLedger.length === 0 && batchIds.length > 0) {
          const { data: purchaseInvoices } = await supabase
            .from("invoice")
            .select("invoice_batch_id, products")
            .in("invoice_batch_id", batchIds);

          const { data: purchaseBatches } = await supabase
            .from("invoice_batch")
            .select("id, products")
            .in("id", batchIds);

          const productQtyMap = new Map<string, number>();
          if (purchaseInvoices && purchaseInvoices.length > 0) {
            for (const inv of purchaseInvoices) {
              for (const p of inv.products || []) {
                if (p.product_id) {
                  const qty = Number(p.quantity || 0);
                  productQtyMap.set(
                    p.product_id,
                    (productQtyMap.get(p.product_id) || 0) + qty,
                  );
                }
              }
            }
          } else if (purchaseBatches && purchaseBatches.length > 0) {
            for (const b of purchaseBatches) {
              for (const p of b.products || []) {
                if (p.product_id) {
                  const qty = Number(p.monthly_quantity || p.quantity || 0);
                  productQtyMap.set(
                    p.product_id,
                    (productQtyMap.get(p.product_id) || 0) + qty,
                  );
                }
              }
            }
          }

          const syntheticRows: any[] = [];
          const curD = new Date(fromDate);
          const endD = new Date(typedBatch.invoice_date_to);
          const dates: string[] = [];
          while (curD <= endD) {
            dates.push(curD.toISOString().slice(0, 10));
            curD.setDate(curD.getDate() + 1);
          }

          for (const [prodId, totalQty] of productQtyMap.entries()) {
            dates.forEach((dateStr, idx) => {
              syntheticRows.push({
                ledger_date: dateStr,
                product_id: prodId,
                opening_stock: 0,
                purchased_quantity: idx === 0 ? totalQty : 0,
                sold_quantity: 0,
              });
            });
          }
          effectiveLedger = syntheticRows;
        }

        availableStockMap = new Map<string, any>();
        const productGroups = new Map<string, any[]>();
        for (const row of effectiveLedger) {
          if (!productGroups.has(row.product_id)) {
            productGroups.set(row.product_id, []);
          }
          productGroups.get(row.product_id)!.push(row);
        }

        for (const [productId, rows] of productGroups.entries()) {
          totalPurchasedByProductForCheck.set(
            productId,
            (Number(rows[0].opening_stock) || 0) +
              rows.reduce(
                (s: number, r: any) => s + (Number(r.purchased_quantity) || 0),
                0,
              ),
          );
          let carryForward = Number(rows[0].opening_stock) || 0;
          for (const row of rows) {
            const opening = carryForward;
            const purchased = Number(row.purchased_quantity) || 0;
            const sold = Number(row.sold_quantity) || 0;
            const available = opening + purchased - sold;

            const key = `${row.ledger_date}_${row.product_id}`;
            availableStockMap.set(key, {
              opening: opening,
              purchased: Math.max(0, purchased - sold),
            });
            carryForward = Math.max(0, available);
          }
        }
      }

      invoices = this.generateWithAutoRetry(() =>
        this.generateInvoiceSplitupsInternal(
          typedBatch,
          numberOfDays,
          fromDate,
          startingCounter,
          availableStockMap,
        ),
      );

      // Final safety net: no product's GENERATED total may exceed what was
      // actually purchased for it, batch-wide, regardless of which day it
      // landed on. Every per-day sourcing step is meant to guarantee this by
      // construction, but a bug in that sourcing (e.g. the ledger
      // pagination tie-break issue fixed alongside this check) can silently
      // over-allocate — this catches that class of bug loudly, at
      // generation time, instead of it surfacing later as a stock
      // discrepancy discovered by chance.
      if (totalPurchasedByProductForCheck.size > 0) {
        const generatedByProduct = new Map<string, number>();
        for (const inv of invoices) {
          for (const p of (inv as any).products || []) {
            if (!p.product_id) continue;
            generatedByProduct.set(
              p.product_id,
              (generatedByProduct.get(p.product_id) || 0) +
                Number(p.quantity || 0),
            );
          }
        }
        for (const [pid, purchased] of totalPurchasedByProductForCheck.entries()) {
          const generated = generatedByProduct.get(pid) || 0;
          if (generated > purchased + 0.01) {
            throw new Error(
              `Overstock Error: Generated ${generated} KG of product ${pid}, exceeding total purchased ${purchased} KG. Generation aborted.`,
            );
          }
        }
      }
    }

    // Validate all generated invoices before saving
    for (const inv of invoices) {
      const validation = this.validateInvoiceData(inv);
      if (!validation.isValid) {
        throw new Error(`Generation validation failed: ${validation.message}`);
      }
    }

    // Save generated invoices directly into database (manual previous_ending_sequence + 1 numbering)
    const invoicesToInsert = invoices.map((inv: any) => ({
      invoice_batch_id: inv.invoice_batch_id || batchId,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      products: inv.products,
      total_amount: inv.total_amount,
      status: inv.status || "generated",
      batch_type: inv.batch_type || typedBatch.batch_type || "PURCHASE",
      pdf_link: inv.pdf_link || null,
      transport_mode: inv.transport_mode || null,
      vehicle_number: inv.vehicle_number || null,
      date_of_supply: inv.date_of_supply || null,
      is_edited: inv.is_edited || false,
      edited_at: inv.edited_at || null,
    }));

    // Invoice numbers are assigned strictly from the user-provided Previous
    // Ending Sequence Number + 1, with no auto-detection or collision-based
    // renumbering against existing invoices. If the numbers collide with
    // something already in the database, the insert below fails on the
    // table's own uniqueness constraint rather than silently reassigning
    // numbers the user didn't ask for.

    // STEP 3: Immediately before inserting into the invoice table
    console.log("==========================================");
    console.log("[INSERT PATH A - InvoiceEngine.generateAndSaveInvoices]");
    console.log("process.pid:", process.pid);
    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("batchId:", batchId);
    console.log("==========================================");
    console.log("STEP 3: BEFORE INSERTION (First 5)");
    console.log("=========================");
    for (const inv of invoicesToInsert.slice(0, 5)) {
      console.log("invoice_number:", inv.invoice_number);
    }

    // Delete any existing invoices for this batch to ensure clean re-generation
    await supabase.from("invoice").delete().eq("invoice_batch_id", batchId);

    const { data: selectInvoices, error: insertError } = await supabase
      .from("invoice")
      .insert(invoicesToInsert)
      .select();

    if (insertError) {
      throw new Error(`Failed to save invoices: ${insertError.message}`);
    }
    const savedInvoices = selectInvoices || [];

    // STEP 4: Immediately AFTER insertion - Read back from DB
    console.log("=========================");
    console.log("STEP 4: AFTER INSERTION (Read Back First 5)");
    console.log("=========================");
    const { data: readBackInvoices } = await supabase
      .from("invoice")
      .select("invoice_number")
      .eq("invoice_batch_id", batchId)
      .order("invoice_number", { ascending: true })
      .limit(5);

    for (const inv of readBackInvoices || []) {
      console.log("invoice_number:", inv.invoice_number);
    }

    // Update daily stock ledger for Sales batch stock consumption
    if (typedBatch.batch_type === "SALES" && typedBatch.stock_source_batch_id) {
      await this.postSalesBatchStockLedger(
        supabase,
        batchId,
        typedBatch.stock_source_batch_id,
      );
    }

    // Update batch status
    const { error: updateError } = await supabase
      .from("invoice_batch")
      .update({ status: "generated" })
      .eq("id", batchId);

    if (updateError) {
      console.error("Error updating batch status:", updateError);
    }

    return invoices.length;
  }

  /**
   * Posts daily_stock_ledger updates for a Sales Batch.
   * Updates sold_quantity for the source purchase batch so that Purchased Quantity == Sold Quantity
   * and no remaining stock is left after Sales generation.
   */
  public static async postSalesBatchStockLedger(
    supabase: SupabaseClient,
    salesBatchId: string,
    stockSourceBatchId?: string,
  ) {
    if (!stockSourceBatchId) return;

    const batchIds = stockSourceBatchId
      .split(",")
      .map((id: string) => id.trim())
      .filter((id: string) => Boolean(id));

    if (batchIds.length === 0) return;

    const salesInvoices = await fetchAllInvoicesForBatch(
      supabase,
      salesBatchId,
    );
    if (!salesInvoices || salesInvoices.length === 0) return;

    // Sum sold quantities per product and date
    const soldByDateAndProduct = new Map<string, number>();
    const soldByProductTotal = new Map<string, number>();

    for (const inv of salesInvoices) {
      const dateStr = inv.invoice_date;
      for (const p of inv.products || []) {
        if (p.product_id) {
          const qty = Number(p.quantity || 0);
          if (dateStr) {
            const key = `${dateStr}_${p.product_id}`;
            soldByDateAndProduct.set(
              key,
              (soldByDateAndProduct.get(key) || 0) + qty,
            );
          }
          soldByProductTotal.set(
            p.product_id,
            (soldByProductTotal.get(p.product_id) || 0) + qty,
          );
        }
      }
    }

    // Fetch existing daily_stock_ledger entries for the source purchase
    // batch(es). Paginated — easily exceeds PostgREST's default 1000-row
    // cap, which would silently leave whichever products' rows fell past
    // the cutoff with a stale/wrong sold_quantity.
    let ledgerRows: any[] = [];
    try {
      ledgerRows = await fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select("*")
          .in("purchase_batch_id", batchIds)
          .order("ledger_date", { ascending: true })
          .order("product_id", { ascending: true })
          .range(from, to),
      );
    } catch {
      return;
    }

    if (!ledgerRows || ledgerRows.length === 0) return;

    // Group ledger rows by product_id
    const rowsByProduct = new Map<string, any[]>();
    for (const row of ledgerRows) {
      if (!rowsByProduct.has(row.product_id)) {
        rowsByProduct.set(row.product_id, []);
      }
      rowsByProduct.get(row.product_id)!.push(row);
    }

    // Collect every row's new sold_quantity across all products first, then
    // write them all in bounded concurrent chunks — writing one row at a
    // time here previously meant a batch with many products/days (1000+
    // ledger rows) issued that many sequential DB round-trips in a single
    // request, which could time out partway through and silently leave most
    // rows' sold_quantity unset (stock that was genuinely sold still showing
    // as available/leftover).
    const pendingUpdates: { id: string; sold_quantity: number }[] = [];

    for (const [productId, rows] of rowsByProduct.entries()) {
      // Chronological walk across all selected purchase batches' rows for this
      // product. Only the quantity actually sold on a row's own date (plus any
      // genuinely unmatched spillover) is added to that row's sold_quantity —
      // never the full available amount just because *something* was sold.
      const sortedRows = [...rows].sort((a, b) => {
        if (a.ledger_date !== b.ledger_date) {
          return a.ledger_date < b.ledger_date ? -1 : 1;
        }
        return (
          batchIds.indexOf(a.purchase_batch_id) -
          batchIds.indexOf(b.purchase_batch_id)
        );
      });

      const dateQtyRemaining = new Map<string, number>();
      for (const [key, qty] of soldByDateAndProduct.entries()) {
        const sepIdx = key.lastIndexOf("_");
        const dateStr = key.slice(0, sepIdx);
        const keyProductId = key.slice(sepIdx + 1);
        if (keyProductId === productId) {
          dateQtyRemaining.set(dateStr, qty);
        }
      }

      const totalSoldForProd = soldByProductTotal.get(productId) || 0;
      let allocatedSoFar = 0;
      let carry = 0;
      const rowConsumed = new Map<string, number>();

      for (const row of sortedRows) {
        const existingSold = Number(row.sold_quantity || 0);
        const purchased = Number(row.purchased_quantity || 0);
        const available = Math.max(0, carry + purchased - existingSold);

        const dateRemaining = dateQtyRemaining.get(row.ledger_date) || 0;
        const consumed = Math.min(available, dateRemaining);

        if (consumed > 0) {
          dateQtyRemaining.set(row.ledger_date, dateRemaining - consumed);
          allocatedSoFar += consumed;
        }
        rowConsumed.set(row.id, consumed);

        carry = available - consumed;
      }

      // Safety net: spill over any unmatched remainder (e.g. a sold date with
      // no corresponding ledger row) across rows in chronological order,
      // bounded by each row's real remaining capacity — never forced.
      let spillover = Math.max(0, totalSoldForProd - allocatedSoFar);
      if (spillover > 0.001) {
        for (const row of sortedRows) {
          if (spillover <= 0.001) break;
          const existingSold = Number(row.sold_quantity || 0);
          const purchased = Number(row.purchased_quantity || 0);
          const alreadyConsumed = rowConsumed.get(row.id) || 0;
          const remainingCapacity = Math.max(
            0,
            purchased - existingSold - alreadyConsumed,
          );
          const extra = Math.min(remainingCapacity, spillover);
          if (extra > 0) {
            rowConsumed.set(row.id, alreadyConsumed + extra);
            spillover -= extra;
          }
        }
      }

      for (const row of sortedRows) {
        const consumed = rowConsumed.get(row.id) || 0;
        if (consumed <= 0.001) continue;

        const newSoldQuantity =
          Math.round((Number(row.sold_quantity || 0) + consumed) * 100) / 100;

        pendingUpdates.push({ id: row.id, sold_quantity: newSoldQuantity });
      }
    }

    const CHUNK = 25;
    const updatedAt = new Date().toISOString();
    for (let i = 0; i < pendingUpdates.length; i += CHUNK) {
      const chunk = pendingUpdates.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map((u) =>
          supabase
            .from("daily_stock_ledger")
            .update({ sold_quantity: u.sold_quantity, updated_at: updatedAt })
            .eq("id", u.id),
        ),
      );
    }
  }

  private static formatDateString(dateStr: string): string {
    const date = new Date(dateStr);
    const day = date.getDate();
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  private static getProductCategory(p: any): "Meat" | "Fruits" {
    // The products table's own `category` column (constrained to exactly
    // 'Meat' | 'Fruits' by schema) is the real source of truth — trust it
    // first. Name-based guessing is a last-resort fallback for the rare
    // case that field is genuinely missing, and previously ran BEFORE this
    // check, which meant a product with a perfectly valid category could
    // still get silently overridden by a keyword match (or, far more often
    // for this catalog, fall through both keyword lists — YAMS, SEER,
    // GOOSEBERRY, SAPOTA, POMFRET etc. match neither — straight into a
    // hardcoded "Meat" default regardless of what it actually was).
    const explicitCategory = String(p?.category || p?.category_name || "")
      .trim()
      .toUpperCase();
    if (explicitCategory === "FRUITS") return "Fruits";
    if (explicitCategory === "MEAT") return "Meat";

    const name = String(p?.product_name || "").toUpperCase();
    if (
      /APPLE|BANANA|BLUEBERRY|CUSTARD APPLE|KIWI|LYCHEE|CHERRY|FIG|ORANGE|GRAPE|MANGO|PEACH|PEAR|PLUM|WATERMELON|PINEAPPLE|PAPAYA|FRUIT/i.test(
        name,
      )
    ) {
      return "Fruits";
    }
    if (
      /CHICKEN|GOAT|DUCK|CLAM|FISH|MACKEREL|MUSSEL|OYSTER|CRAB|SHRIMP|MEAT/i.test(
        name,
      )
    ) {
      return "Meat";
    }
    return explicitCategory.includes("FRUIT") ? "Fruits" : "Meat";
  }

  /**
   * Internal generator logic
   */
  private static generateInvoiceSplitupsInternal(
    batch: InvoiceBatch,
    numberOfDays: number,
    startDate: Date,
    startingCounter: number = 1,
    availableStockMap?: Map<string, any> | null,
  ) {
    const invoices = [];
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    let invoiceCounter = startingCounter;

    let selectedCustomers = batch.selected_customers || [];
    const majorCustomers = batch.major_customers || [];

    if (
      selectedCustomers.length === 0 &&
      majorCustomers.length === 0 &&
      batch.receiving_company_id
    ) {
      selectedCustomers = [batch.receiving_company_id];
    }

    // ── STEP 1: Pre-generation Validation for Sales Major Customers ───────
    let totalMajorAmount = 0;
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount > 0) {
        totalMajorAmount += mAmount;
      }

      if (mAmount > 0 && mInvCount > 0 && mMaxLimit > 0) {
        const maxPossible = mInvCount * mMaxLimit;
        if (maxPossible < mAmount) {
          throw new Error(
            `Major Customer configuration cannot satisfy requested amount. Customer requires ₹${mAmount.toFixed(2)} across ${mInvCount} invoice(s), but maximum possible total is ₹${maxPossible.toFixed(2)} (max limit ₹${mMaxLimit.toFixed(2)} per invoice). Major Customer configuration cannot satisfy requested amount.`,
          );
        }
      }
    }

    if (totalMajorAmount > batch.total_amount) {
      throw new Error(
        `Major Customer Total (₹${totalMajorAmount.toFixed(2)}) exceeds Sales Batch Total (₹${batch.total_amount.toFixed(2)}). Remaining Batch Amount cannot be negative.`,
      );
    }

    const majorTracking = majorCustomers.map((m) => ({
      customer_id: m.customer_id,
      remainingInvoices: m.invoice_count,
      remainingAmount: m.amount,
    }));

    // Build the date list
    const dateList: string[] = [];
    for (let dayOffset = 0; dayOffset < numberOfDays; dayOffset++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + dayOffset);
      const dateStr = `${currentDate.getFullYear()}-${String(
        currentDate.getMonth() + 1,
      ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;
      dateList.push(dateStr);
    }

    // Compute proportional category totals across batch products — used both
    // to pick a category for each Major Customer invoice (keeping every
    // invoice category-pure, same rule as regular invoices) and to size
    // regular-customer category quotas below.
    const categoryTotals = new Map<string, number>();
    for (const p of batch.products) {
      const cat = this.getProductCategory(p);
      const avgRate =
        (parseFloat(p.perDayRateMin) + parseFloat(p.perDayRateMax)) / 2;
      const avgQty =
        (parseFloat(p.perDayQtyMin) + parseFloat(p.perDayQtyMax)) / 2;
      const estAmt =
        (isNaN(avgRate) ? 100 : avgRate) * (isNaN(avgQty) ? 10 : avgQty);
      categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + estAmt);
    }
    const grandTotalEst =
      Array.from(categoryTotals.values()).reduce((a, b) => a + b, 0) || 1;
    const categoryKeys = Array.from(categoryTotals.keys());
    const productConfigById = new Map<string, ProductConfig>(
      (batch.products || []).map((p: any) => [p.product_id, p]),
    );

    // Which customer_id already has an invoice on which date — shared across
    // Major Customer generation (below) and the regular day-first loop
    // (further down), so no customer (major or regular) ever gets two
    // invoices on the same date.
    const usedPartiesByDate = new Map<string, Set<string>>();
    const markPartyUsed = (dateStr: string, customerId: string | null) => {
      if (!customerId) return;
      if (!usedPartiesByDate.has(dateStr)) {
        usedPartiesByDate.set(dateStr, new Set());
      }
      usedPartiesByDate.get(dateStr)!.add(customerId);
    };

    // ── STEP 1: Process Configured Sales Major Customers FIRST (Reserving Stock) ──
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const customerId = m.customer_id;
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount <= 0 || mInvCount <= 0) continue;

      // Determine invoice budgets for this Major Customer
      const majorBudgets: number[] = [];
      if (mInvCount === 1) {
        majorBudgets.push(mAmount);
      } else {
        const avgBudget = Math.round((mAmount / mInvCount) * 100) / 100;
        let unallocatedM = mAmount;

        for (let b = 0; b < mInvCount; b++) {
          const alloc = Math.min(unallocatedM, avgBudget);
          majorBudgets.push(alloc);
          unallocatedM = Math.round((unallocatedM - alloc) * 100) / 100;
        }

        for (let b = 0; b < mInvCount; b++) {
          if (unallocatedM <= 0) break;
          const headroom = Math.max(0, mMaxLimit - majorBudgets[b]);
          if (headroom > 0) {
            const maxAdd = Math.min(unallocatedM, headroom);
            const add =
              b === mInvCount - 1
                ? maxAdd
                : Math.round(Math.random() * maxAdd * 100) / 100;
            majorBudgets[b] = Math.round((majorBudgets[b] + add) * 100) / 100;
            unallocatedM = Math.round((unallocatedM - add) * 100) / 100;
          }
        }
      }

      // Generate exact Major Customer Invoices
      for (let b = 0; b < majorBudgets.length; b++) {
        const targetBudget = majorBudgets[b];
        // Per-customer-local index/total — never the global invoices.length,
        // which would misalign date spacing for every major customer after
        // the first.
        const dateStr: string = this.getSequentialDateForIndex(
          b,
          majorBudgets.length,
          dateList,
        );

        // Pick ONE category for this invoice (weighted by its share of the
        // batch's configured value), same rule regular invoices already
        // follow — an invoice never mixes Meat and Fruits, even though a
        // customer isn't locked to a category.
        let categoryRoll = Math.random() * grandTotalEst;
        let chosenCategory = categoryKeys[0] || "Meat";
        for (const catKey of categoryKeys) {
          categoryRoll -= categoryTotals.get(catKey) || 0;
          if (categoryRoll <= 0) {
            chosenCategory = catKey;
            break;
          }
        }
        const categoryProducts = batch.products.filter(
          (p) => this.getProductCategory(p) === chosenCategory,
        );

        const shuffled = [...categoryProducts].sort(() => Math.random() - 0.5);
        const targetSubsetCount = Math.min(
          shuffled.length,
          Math.floor(Math.random() * 6) + 3,
        );
        const chosenProducts = shuffled.slice(0, targetSubsetCount);

        let currentInvoiceProducts: any[] = [];
        let currentInvoiceAmount = 0;

        for (let j = 0; j < chosenProducts.length; j++) {
          const p = chosenProducts[j];
          const minR = parseFloat(p.perDayRateMin) || 10;
          const maxR = parseFloat(p.perDayRateMax) || 500;
          let rate = roundToWholeInteger(minR + Math.random() * (maxR - minR));

          const minQ = parseFloat(p.perDayQtyMin) || 10;
          const maxQ = Math.max(minQ, parseFloat(p.perDayQtyMax) || 100);

          const remBudget = targetBudget - currentInvoiceAmount;
          if (remBudget <= 0) break;

          // The invoice's first line is exempt from the "don't exceed
          // budget" check below (an invoice can't end up with zero lines) —
          // so its rate must itself be capped to whatever the target budget
          // can actually afford at the minimum commercial quantity, instead
          // of using an uncapped random rate that can blow straight past a
          // tight budget before any line has even been added.
          if (currentInvoiceProducts.length === 0) {
            const maxAffordableRate = remBudget / minQ;
            if (rate > maxAffordableRate) {
              // A cap must always round DOWN — rounding to the nearest
              // whole number (e.g. 999.9 -> 1000) can land back above the
              // budget it was supposed to enforce.
              rate = Math.max(minR, Math.floor(maxAffordableRate));
            }
          }

          // Never exempt the first line from budget fit — an invoice with
          // no viable product for its date/budget must end up with zero
          // lines and be skipped (handled below), not seeded with a
          // product that doesn't actually fit.
          const maxQtyFitting = remBudget / (rate || 1);
          if (maxQtyFitting < minQ) {
            continue;
          }

          // Check available stock for this product on this date
          let availStock = 999999;
          if (availableStockMap) {
            const ledgerKey = `${dateStr}_${p.product_id}`;
            const val = availableStockMap.get(ledgerKey);
            if (val !== undefined && val !== null) {
              if (typeof val === "object") {
                availStock = (val.opening || 0) + (val.purchased || 0);
              } else if (typeof val === "number") {
                availStock = val;
              }
            } else {
              let sumProdStock = 0;
              for (const [k, v] of availableStockMap.entries()) {
                if (k.endsWith(`_${p.product_id}`)) {
                  if (typeof v === "object" && v !== null) {
                    sumProdStock += (v.opening || 0) + (v.purchased || 0);
                  } else if (typeof v === "number") {
                    sumProdStock += v;
                  }
                }
              }
              availStock = sumProdStock;
            }
          }

          // Never exempt the first line from the stock check either — a
          // product with less real remaining stock than its own minimum
          // commercial quantity cannot go on ANY invoice for this date,
          // first line or not. (The old `Math.max(availStock, minQ)` below
          // used to inflate the ceiling back up to minQ in exactly this
          // case, which could oversell beyond what was actually
          // purchased — skip instead.)
          if (availStock < minQ) continue;

          // Same product can't appear twice on one invoice.
          if (
            currentInvoiceProducts.some(
              (cp) => cp.product_id === p.product_id,
            )
          ) {
            continue;
          }

          // Deterministic: take as much of the real remaining stock as
          // fits this invoice's budget and the line's own max quantity —
          // never a random pick within that ceiling. If that ceiling is
          // itself below minQ, the line genuinely doesn't fit — skip it
          // rather than forcing quantity back up past what's actually
          // available/affordable.
          const upperLimit = Math.min(availStock, maxQ, maxQtyFitting);
          const qtyToPut =
            upperLimit < minQ ? 0 : Math.max(minQ, Math.floor(upperLimit * 4) / 4);

          if (qtyToPut <= 0) continue;

          const lineAmt = Math.round(qtyToPut * rate * 100) / 100;
          if (
            currentInvoiceAmount + lineAmt > mMaxLimit &&
            currentInvoiceProducts.length > 0
          ) {
            continue;
          }

          // Deduct / Reserve stock from availableStockMap
          if (availableStockMap) {
            const ledgerKey = `${dateStr}_${p.product_id}`;
            const val = availableStockMap.get(ledgerKey);
            if (typeof val === "object" && val !== null) {
              val.purchased = Math.max(
                0,
                Math.round((val.purchased - qtyToPut) * 100) / 100,
              );
            } else if (typeof val === "number") {
              availableStockMap.set(
                ledgerKey,
                Math.max(0, Math.round((val - qtyToPut) * 100) / 100),
              );
            }
          }

          currentInvoiceProducts.push({
            product_id: p.product_id,
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            unit_of_measure: p.unit_of_measure,
            quantity: qtyToPut,
            rate,
            amount: lineAmt,
            customer_id: customerId,
          });

          currentInvoiceAmount =
            Math.round((currentInvoiceAmount + lineAmt) * 100) / 100;
        }

        // Fallback: a Major Customer's invoice count/amount is a
        // configured commitment, so this invoice must still get built even
        // if the deterministic pass above found nothing that fit. Pick
        // whichever batch product actually has the MOST real remaining
        // stock for this date (never blindly batch.products[0]) so this
        // last resort still respects the ledger rather than fabricating a
        // sale from nothing whenever any real option exists at all.
        if (currentInvoiceProducts.length === 0 && batch.products.length > 0) {
          let fallbackProd = batch.products[0];
          let fallbackStock = -1;
          for (const cand of batch.products) {
            let candStock = 999999;
            if (availableStockMap) {
              const ledgerKey = `${dateStr}_${cand.product_id}`;
              const val = availableStockMap.get(ledgerKey);
              if (val && typeof val === "object") {
                candStock = (val.opening || 0) + (val.purchased || 0);
              } else if (typeof val === "number") {
                candStock = val;
              } else {
                candStock = 0;
              }
            }
            if (candStock > fallbackStock) {
              fallbackStock = candStock;
              fallbackProd = cand;
            }
          }

          const minR = parseFloat(fallbackProd.perDayRateMin) || 10;
          const maxR = parseFloat(fallbackProd.perDayRateMax) || 500;
          const rate = roundToWholeInteger(
            minR + Math.random() * (maxR - minR),
          );
          const minQ = Math.max(
            10,
            parseFloat(fallbackProd.perDayQtyMin) || 10,
          );
          const lineAmt = targetBudget;
          let qtyToPut = Math.max(minQ, Math.round(lineAmt / (rate || 1)));
          // Cap to real remaining stock when the ledger has an answer for
          // this product/date at all (fallbackStock stays 999999 only for
          // Purchase batches, which don't carry an availableStockMap).
          if (availableStockMap && fallbackStock < 999999) {
            qtyToPut = Math.min(qtyToPut, Math.max(0, fallbackStock));
          }
          if (qtyToPut <= 0) {
            // Truly nothing left anywhere for this date — nothing safe to
            // add without overselling; leave this invoice slot empty
            // rather than fabricate a line with zero real stock behind it.
          } else {
            if (availableStockMap) {
              const ledgerKey = `${dateStr}_${fallbackProd.product_id}`;
              const val = availableStockMap.get(ledgerKey);
              if (val && typeof val === "object") {
                val.purchased = Math.max(
                  0,
                  Math.round((val.purchased - qtyToPut) * 100) / 100,
                );
              }
            }
            currentInvoiceProducts.push({
              product_id: fallbackProd.product_id,
              product_name: fallbackProd.product_name,
              hsn_code: fallbackProd.hsn_code,
              unit_of_measure: fallbackProd.unit_of_measure,
              quantity: qtyToPut,
              rate,
              amount: Math.round(qtyToPut * rate * 100) / 100,
              customer_id: customerId,
            });
          }
        }

        // Adjust line item amounts / rate so total equals targetBudget
        const currentSum = Math.round(
          currentInvoiceProducts.reduce(
            (sum, item) => sum + Math.round(item.amount || 0),
            0,
          ),
        );
        const invDrift = Math.round(targetBudget) - currentSum;
        if (Math.abs(invDrift) > 0 && currentInvoiceProducts.length > 0) {
          const lastItem =
            currentInvoiceProducts[currentInvoiceProducts.length - 1];
          lastItem.amount = Math.round(lastItem.amount + invDrift);
          lastItem.rate = roundToWholeInteger(
            lastItem.amount / (lastItem.quantity || 1),
          );
        }

        let finalInvoiceTotal = Math.round(
          currentInvoiceProducts.reduce(
            (sum, item) => sum + Math.round(item.amount || 0),
            0,
          ),
        );

        if (
          finalInvoiceTotal > mMaxLimit &&
          currentInvoiceProducts.length > 0
        ) {
          const excess = finalInvoiceTotal - mMaxLimit;
          const lastItem =
            currentInvoiceProducts[currentInvoiceProducts.length - 1];
          const newAmt = Math.round(lastItem.amount - excess);
          if (newAmt > 0) {
            lastItem.amount = newAmt;
            lastItem.rate = roundToWholeInteger(
              lastItem.amount / (lastItem.quantity || 1),
            );
            finalInvoiceTotal = Math.round(
              currentInvoiceProducts.reduce(
                (sum, item) => sum + Math.round(item.amount || 0),
                0,
              ),
            );
          }
        }

        // Nothing safe to sell for this date anywhere in the batch — skip
        // this invoice slot entirely rather than persist an empty/
        // zero-amount invoice. (Rare: only when every configured product
        // is genuinely out of real stock on this exact date.)
        if (currentInvoiceProducts.length === 0) continue;

        const abbr = (batch as any).issuing_company_abbreviation || "IC";
        const fy = (batch.financial_year || "2026-27").replace(/^FY/i, "");
        const invType = batch.batch_type === "PURCHASE" ? "P" : "S";
        const invoiceNumber = InvoiceNumberingService.formatInvoiceNumber(
          abbr,
          fy,
          invType,
          invoiceCounter++,
        );

        invoices.push({
          invoice_batch_id: batch.id,
          invoice_number: invoiceNumber,
          invoice_date: dateStr,
          customer_id: customerId,
          products: currentInvoiceProducts,
          total_amount: finalInvoiceTotal,
          status: "generated",
          batch_type: batch.batch_type,
        });
        markPartyUsed(dateStr, customerId);
      }

      // Major Customer Exact Balance Correction Guard
      const mCustInvoices = invoices.filter(
        (inv) =>
          inv.customer_id === customerId ||
          inv.products?.[0]?.customer_id === customerId,
      );
      if (mCustInvoices.length > 0) {
        const generatedSum = Math.round(
          mCustInvoices.reduce(
            (s, i) => s + Math.round(i.total_amount || 0),
            0,
          ),
        );
        const mTarget = Math.round(mAmount);
        const majorDrift = mTarget - generatedSum;

        if (Math.abs(majorDrift) > 0) {
          // Spread the drift across every line of every invoice belonging to
          // this major customer, solving each line back onto a valid
          // rate/quantity via solveLineForTarget (never a raw amount/qty
          // rate that could fall outside the product's configured range),
          // until it's closed or every line is exhausted.
          const productConfigById = new Map<string, ProductConfig>(
            (batch.products || []).map((p: any) => [p.product_id, p]),
          );
          let remainingDrift = majorDrift;
          for (const inv of mCustInvoices) {
            if (Math.abs(remainingDrift) <= 0.5) break;
            if (!inv.products || inv.products.length === 0) continue;
            for (const item of inv.products) {
              if (Math.abs(remainingDrift) <= 0.5) break;
              const targetLineAmt = Math.round(
                (item.amount || 0) + remainingDrift,
              );
              if (targetLineAmt <= 0) continue;
              const previousAmount = item.amount || 0;
              const solved = this.solveLineForTarget(
                item.product_id,
                item.quantity,
                targetLineAmt,
                productConfigById,
              );
              item.quantity = solved.quantity;
              item.rate = solved.rate;
              item.amount = computeLineAmount(item.quantity, item.rate);
              remainingDrift =
                Math.round(
                  (remainingDrift - (item.amount - previousAmount)) * 100,
                ) / 100;
            }
            inv.total_amount = Math.round(
              inv.products.reduce(
                (sum: number, item: any) => sum + Math.round(item.amount || 0),
                0,
              ),
            );
          }
        }
      }
    }

    // Mark Major Customers as fully satisfied so they are not picked again during normal customer assignment
    for (const mTrack of majorTracking) {
      mTrack.remainingInvoices = 0;
      mTrack.remainingAmount = 0;
    }

    // ── Sequential per-product stock tracker ───────────────────────────────
    // runningRemaining[productId] = remaining stock carried into the NEXT day
    const runningRemaining = new Map<string, number>();

    // Seed with the opening stock from the ledger for each product on the first date
    for (const prodConfig of batch.products) {
      runningRemaining.set(prodConfig.product_id, 0);
    }

    // Natural Active Subset Sampling for Sales Batch Customers
    let activeSelectedCustomers = [...selectedCustomers];
    if (activeSelectedCustomers.length > 10) {
      const poolRatio = 0.3 + Math.random() * 0.2; // 30% to 50%
      const targetSubCount = Math.max(
        5,
        Math.min(
          activeSelectedCustomers.length,
          Math.ceil(activeSelectedCustomers.length * poolRatio),
        ),
      );
      activeSelectedCustomers = [...activeSelectedCustomers]
        .sort(() => Math.random() - 0.5)
        .slice(0, targetSubCount);
    }

    const customerBatchCategoryMap = new Map<string, string>();

    for (const invoiceDate of dateList) {
      const productsOnDay: any[] = [];

      for (const prodConfig of batch.products) {
        let available = 0;
        let dayOpening = 0;
        let dayPurchased = 0;

        const ledgerKey = `${invoiceDate}_${prodConfig.product_id}`;
        const val = availableStockMap ? availableStockMap.get(ledgerKey) : null;

        if (availableStockMap) {
          if (val !== undefined && val !== null) {
            if (typeof val === "object" && val !== null) {
              // New format: { opening: number, purchased: number }
              const isFirstDate = invoiceDate === dateList[0];
              if (isFirstDate) {
                dayOpening = (val as any).opening || 0;
              } else {
                dayOpening = runningRemaining.get(prodConfig.product_id) ?? 0;
              }
              dayPurchased = (val as any).purchased || 0;
              available = Math.round((dayOpening + dayPurchased) * 100) / 100;
            } else if (typeof val === "number") {
              // Old format: pre-calculated available stock number
              available = val;
            }
          } else {
            // Key not found in map, default to 0 available stock
            available = 0;
          }
        } else {
          // No availableStockMap provided (e.g. Purchase Batch), default to unlimited
          available = 999999;
        }

        if (available <= 0) {
          // Nothing to sell today for this product; carry forward 0
          runningRemaining.set(prodConfig.product_id, 0);
          continue;
        }

        // Sell exactly 100% of today's real available stock — this
        // deterministic default is what makes it match Null mode exactly
        // (see DailyStockReviewModal's computeNullModeRows), so the Daily
        // Stock Ledger's initial proposal is never a random subset of what
        // was actually purchased. Auto Allocate / manual edits in the
        // review modal are the only place a smaller amount gets chosen —
        // never here, never randomly.
        const qtyToSell = roundToQuarterIncrement(available);
        const actualRemaining = 0;

        runningRemaining.set(prodConfig.product_id, actualRemaining);

        if (qtyToSell <= 0) continue;

        const minRate = parseFloat(prodConfig.perDayRateMin) || 0;
        const maxRate = parseFloat(prodConfig.perDayRateMax) || 0;
        const rate = roundToWholeInteger(
          minRate + Math.random() * (maxRate - minRate),
        );

        const amount = computeLineAmount(qtyToSell, rate);

        productsOnDay.push({
          product_id: prodConfig.product_id,
          product_name: prodConfig.product_name,
          category:
            (prodConfig as any).category_name ||
            (prodConfig as any).category ||
            "Meat",
          hsn_code: prodConfig.hsn_code,
          unit_of_measure: prodConfig.unit_of_measure,
          quantity: qtyToSell,
          rate,
          amount,
        });
      }

      if (productsOnDay.length === 0) {
        continue;
      }

      // ── Redesigned Invoice Composition Algorithm (3-8 Products, Commercial Quantities First) ──
      const productsByCategory = new Map<string, any[]>();
      for (const p of productsOnDay) {
        const catKey = this.getProductCategory(p);
        p.category = catKey;

        if (!productsByCategory.has(catKey)) {
          productsByCategory.set(catKey, []);
        }
        productsByCategory.get(catKey)!.push(p);
      }

      const dayInvoices: any[] = [];

      for (const [catKey, categoryProducts] of productsByCategory.entries()) {
        let pool = [...categoryProducts];

        while (pool.length > 0) {
          // 1. Natural product subset count (3 to 8 distinct products)
          const targetSubsetCount = Math.min(
            pool.length,
            Math.floor(Math.random() * 6) + 3,
          );

          // Shuffle pool and select targetSubsetCount products
          pool.sort(() => Math.random() - 0.5);
          const chosenProducts = pool.slice(0, targetSubsetCount);
          const remainingPool: any[] = [];

          let currentInvoiceProducts: any[] = [];
          let currentInvoiceAmount = 0;

          for (const p of chosenProducts) {
            const minRate = parseFloat(p.perDayRateMin) || 10;
            const maxRate = parseFloat(p.perDayRateMax) || 500;
            let rate = roundToWholeInteger(
              minRate + Math.random() * (maxRate - minRate),
            );

            const prodMinQty = parseFloat(p.perDayQtyMin) || 10;
            const prodMaxQty = Math.max(
              prodMinQty,
              parseFloat(p.perDayQtyMax) || 100,
            );

            // The invoice's first line is exempt from the "don't exceed"
            // check below (an invoice can't end up with zero lines) — so
            // its rate must itself be capped to whatever thresholdMax can
            // actually afford at the minimum commercial quantity, instead
            // of using an uncapped random rate that can blow straight past
            // the invoice ceiling before any line has even been added.
            if (currentInvoiceProducts.length === 0) {
              const remBudget = thresholdMax - currentInvoiceAmount;
              const maxAffordableRate = remBudget / prodMinQty;
              if (rate > maxAffordableRate) {
                if (maxAffordableRate < minRate) {
                  // Even at this product's cheapest legal rate, its own
                  // minimum commercial quantity alone exceeds thresholdMax
                  // — there is no legal line for this product that fits
                  // under the invoice ceiling. Forcing it in anyway (the
                  // old behaviour: Math.max(minRate, ...) silently pushed
                  // the "capped" rate back ABOVE the budget) is exactly
                  // what let generated invoices exceed the configured
                  // maximum. Skip it as this invoice's first line instead —
                  // the next candidate product gets a turn at being first,
                  // and this one is retried on a future invoice/day.
                  remainingPool.push(p);
                  continue;
                }
                // A cap must always round DOWN — rounding to the nearest
                // whole number (e.g. 999.9 -> 1000) can land back above the
                // budget it was supposed to enforce.
                rate = Math.max(minRate, Math.floor(maxAffordableRate));
              }
            }
            p.rate = rate;

            const maxQtyFitting =
              (thresholdMax - currentInvoiceAmount) / (rate || 1);

            if (
              maxQtyFitting < prodMinQty &&
              currentInvoiceProducts.length > 0
            ) {
              remainingPool.push(p);
              continue;
            }

            const upperLimit = Math.min(
              p.quantity,
              prodMaxQty,
              Math.max(prodMinQty, maxQtyFitting),
            );

            // Deterministic: always take as much of the real remaining
            // stock as fits (this invoice's budget, the line's own max
            // quantity, and what's actually left for the day) — never a
            // random pick within that ceiling. The product naturally
            // spreads across multiple invoices for the day (via
            // remainingPool below) purely because each invoice's own
            // budget bounds maxQtyFitting, not because of randomness.
            const qtyToPut =
              upperLimit < prodMinQty
                ? 0
                : Math.max(prodMinQty, Math.floor(upperLimit * 4) / 4);

            if (qtyToPut <= 0) {
              remainingPool.push(p);
              continue;
            }

            // Same product can't appear twice on one invoice.
            if (
              currentInvoiceProducts.some(
                (cp) => cp.product_id === p.product_id,
              )
            ) {
              remainingPool.push(p);
              continue;
            }

            const amt = Math.round(qtyToPut * rate * 100) / 100;

            if (
              currentInvoiceAmount + amt > thresholdMax &&
              currentInvoiceProducts.length > 0
            ) {
              remainingPool.push(p);
              continue;
            }

            currentInvoiceProducts.push({
              ...p,
              quantity: qtyToPut,
              rate,
              amount: amt,
            });
            currentInvoiceAmount =
              Math.round((currentInvoiceAmount + amt) * 100) / 100;

            p.quantity = Math.round((p.quantity - qtyToPut) * 100) / 100;
            if (p.quantity >= prodMinQty) {
              remainingPool.push(p);
            }
          }

          const unchosen = pool.slice(targetSubsetCount);
          pool = [...remainingPool, ...unchosen];

          if (currentInvoiceProducts.length > 0) {
            dayInvoices.push({
              category_key: catKey,
              products: currentInvoiceProducts,
              total_amount: currentInvoiceAmount,
            });
          } else {
            break;
          }
        }
      }

      // Merge any below-thresholdMin invoice into another SAME-CATEGORY
      // invoice from the same day (not just the last one into its immediate
      // predecessor), repeating until no more under-threshold invoice can be
      // improved. Category purity is preserved throughout. Invoices that
      // have no eligible merge target are marked unfixable so they don't
      // block other invoices from still being checked.
      const unfixable = new Set<any>();
      let mergedSomething = true;
      while (mergedSomething) {
        mergedSomething = false;
        const belowMinIdx = dayInvoices.findIndex(
          (inv) => inv.total_amount < thresholdMin && !unfixable.has(inv),
        );
        if (belowMinIdx === -1) break;

        const belowMinInv = dayInvoices[belowMinIdx];
        const belowMinProductIds = new Set(
          belowMinInv.products.map((p: any) => p.product_id),
        );
        const targetIdx = dayInvoices.findIndex(
          (inv, idx) =>
            idx !== belowMinIdx &&
            inv.category_key === belowMinInv.category_key &&
            inv.total_amount + belowMinInv.total_amount <= thresholdMax &&
            // Concatenating product lines blindly would create a duplicate
            // line (same product, two different rates) whenever the two
            // invoices being merged happen to both carry it — reject any
            // candidate target that already has ANY product belowMinInv
            // is also carrying.
            !inv.products.some((p: any) => belowMinProductIds.has(p.product_id)),
        );

        if (targetIdx !== -1) {
          const targetInv = dayInvoices[targetIdx];
          targetInv.products.push(...belowMinInv.products);
          targetInv.total_amount =
            Math.round(
              (targetInv.total_amount + belowMinInv.total_amount) * 100,
            ) / 100;
          dayInvoices.splice(belowMinIdx, 1);
          mergedSomething = true;
        } else {
          unfixable.add(belowMinInv);
          mergedSomething = true;
        }
      }

      // Last resort for invoices no merge could fix: grow their existing
      // lines toward thresholdMin via solveLineForTarget (same mechanism
      // already used for the Major Customer balance guard above) before
      // accepting a below-minimum invoice.
      for (const inv of unfixable) {
        if (inv.total_amount >= thresholdMin) continue;
        const shortfall = thresholdMin - inv.total_amount;
        let remaining = shortfall;
        for (const item of inv.products) {
          if (remaining <= 0) break;
          const targetLineAmt = Math.round((item.amount || 0) + remaining);
          const previousAmount = item.amount || 0;
          const solved = this.solveLineForTarget(
            item.product_id,
            item.quantity,
            targetLineAmt,
            productConfigById,
          );
          item.quantity = solved.quantity;
          item.rate = solved.rate;
          item.amount = computeLineAmount(item.quantity, item.rate);
          remaining =
            Math.round((remaining - (item.amount - previousAmount)) * 100) /
            100;
        }
        inv.total_amount = Math.round(
          inv.products.reduce(
            (sum: number, p: any) => sum + Math.round(p.amount || 0),
            0,
          ),
        );
      }

      for (const inv of dayInvoices) {
        let assignedCustomerId = null;
        const invCategory = inv.category_key || "Meat";
        if (!usedPartiesByDate.has(invoiceDate)) {
          usedPartiesByDate.set(invoiceDate, new Set());
        }
        const usedPartiesOnDay = usedPartiesByDate.get(invoiceDate)!;

        // Filter major customer eligible by day AND customer category lock for this batch
        const eligibleMajor =
          majorTracking.find(
            (m) =>
              m.remainingInvoices > 0 &&
              !usedPartiesOnDay.has(m.customer_id) &&
              (!customerBatchCategoryMap.has(m.customer_id) ||
                customerBatchCategoryMap.get(m.customer_id) === invCategory),
          ) ||
          majorTracking.find(
            (m) =>
              m.remainingInvoices > 0 &&
              (!customerBatchCategoryMap.has(m.customer_id) ||
                customerBatchCategoryMap.get(m.customer_id) === invCategory),
          );

        if (eligibleMajor) {
          assignedCustomerId = eligibleMajor.customer_id;
          eligibleMajor.remainingInvoices--;
          eligibleMajor.remainingAmount =
            Math.round(
              (eligibleMajor.remainingAmount - inv.total_amount) * 100,
            ) / 100;
        } else if (activeSelectedCustomers.length > 0) {
          const catEst = categoryTotals.get(invCategory) || 0;
          const catRatio = catEst / grandTotalEst;
          const catQuota = Math.max(
            1,
            Math.round(activeSelectedCustomers.length * catRatio),
          );
          const assignedCountForCat = Array.from(
            customerBatchCategoryMap.values(),
          ).filter((c) => c === invCategory).length;

          // Customers already assigned to invCategory or unassigned (if quota allows)
          const categoryAndDayEligible = activeSelectedCustomers.filter(
            (cId) => {
              if (usedPartiesOnDay.has(cId)) return false;
              const currentCat = customerBatchCategoryMap.get(cId);
              if (currentCat === invCategory) return true;
              if (!currentCat && assignedCountForCat < catQuota) return true;
              return false;
            },
          );

          const categoryEligibleOnly = activeSelectedCustomers.filter((cId) => {
            if (usedPartiesOnDay.has(cId)) return false;
            const currentCat = customerBatchCategoryMap.get(cId);
            if (currentCat === invCategory) return true;
            if (!currentCat && assignedCountForCat < catQuota) return true;
            return false;
          });

          const fallbackAnySameCategory = activeSelectedCustomers.filter(
            (cId) =>
              !usedPartiesOnDay.has(cId) &&
              (!customerBatchCategoryMap.has(cId) ||
                customerBatchCategoryMap.get(cId) === invCategory),
          );

          const fallbackAnyUnusedToday = activeSelectedCustomers.filter(
            (cId) => !usedPartiesOnDay.has(cId),
          );

          if (categoryAndDayEligible.length > 0) {
            const randomCustomerIndex = Math.floor(
              Math.random() * categoryAndDayEligible.length,
            );
            assignedCustomerId = categoryAndDayEligible[randomCustomerIndex];
          } else if (categoryEligibleOnly.length > 0) {
            const randomCustomerIndex = Math.floor(
              Math.random() * categoryEligibleOnly.length,
            );
            assignedCustomerId = categoryEligibleOnly[randomCustomerIndex];
          } else if (fallbackAnySameCategory.length > 0) {
            const randomCustomerIndex = Math.floor(
              Math.random() * fallbackAnySameCategory.length,
            );
            assignedCustomerId = fallbackAnySameCategory[randomCustomerIndex];
          } else if (fallbackAnyUnusedToday.length > 0) {
            const randomCustomerIndex = Math.floor(
              Math.random() * fallbackAnyUnusedToday.length,
            );
            assignedCustomerId = fallbackAnyUnusedToday[randomCustomerIndex];
          } else {
            // Every selected customer already has an invoice on this date —
            // never double-book a customer for the same day. Merge this
            // invoice's products into another already-generated invoice
            // for the same date/category that has headroom, instead.
            const invProductIds = new Set(
              inv.products.map((p: any) => p.product_id),
            );
            const mergeTarget = invoices.find(
              (existingInv: any) =>
                existingInv.invoice_date === invoiceDate &&
                existingInv.products?.[0]?.category === invCategory &&
                Math.round(existingInv.total_amount || 0) +
                  Math.round(inv.total_amount || 0) <=
                  thresholdMax &&
                // Never merge in a product the target invoice already
                // carries — that would create a duplicate line for the
                // same product at two different rates.
                !(existingInv.products || []).some((p: any) =>
                  invProductIds.has(p.product_id),
                ),
            );
            if (mergeTarget) {
              const mergedProducts = inv.products.map((p: any) => ({
                ...p,
                customer_id: mergeTarget.products?.[0]?.customer_id,
              }));
              mergeTarget.products.push(...mergedProducts);
              mergeTarget.total_amount = Math.round(
                mergeTarget.products.reduce(
                  (s: number, p: any) => s + Math.round(p.amount || 0),
                  0,
                ),
              );
              continue;
            }
            // Genuinely no merge target and no unused customer for this
            // date — last-resort double-book rather than drop the invoice.
            const randomCustomerIndex = Math.floor(
              Math.random() * activeSelectedCustomers.length,
            );
            assignedCustomerId = activeSelectedCustomers[randomCustomerIndex];
          }
        } else {
          assignedCustomerId = batch.receiving_company_id;
        }

        if (assignedCustomerId) {
          usedPartiesOnDay.add(assignedCustomerId);
          customerBatchCategoryMap.set(assignedCustomerId, invCategory);
        }

        const abbr = (batch as any).issuing_company_abbreviation || "IC";
        const fy = (batch.financial_year || "2026-27").replace(/^FY/i, "");
        const invType = batch.batch_type === "PURCHASE" ? "P" : "S";
        const invoiceNumber = InvoiceNumberingService.formatInvoiceNumber(
          abbr,
          fy,
          invType,
          invoiceCounter++,
        );

        const productsWithCustomerId = inv.products.map((p: any) => ({
          ...p,
          customer_id: assignedCustomerId,
        }));

        invoices.push({
          invoice_batch_id: batch.id,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          products: productsWithCustomerId,
          total_amount: inv.total_amount,
          status: "generated",
          batch_type: batch.batch_type,
        });
      }
    }

    // ── Final Minimum-Amount Safety Net ──
    // The per-day merge/grow logic above only ever looks at OTHER invoices
    // from the SAME day — a day with very little leftover stock can end up
    // with one small invoice that has no same-day, same-category merge
    // partner and no rate/quantity headroom left to grow into thresholdMin
    // (both are hard product-rule ceilings), silently persisting a
    // below-minimum invoice. Give every remaining below-minimum invoice one
    // more chance against the WHOLE batch (any day, same category, no
    // overlapping product, ₹ headroom under thresholdMax) before accepting
    // defeat — date is not treated as a hard constraint elsewhere in this
    // pipeline either.
    if (thresholdMin > 0) {
      let mergedGlobally = true;
      while (mergedGlobally) {
        mergedGlobally = false;
        const belowIdx = invoices.findIndex(
          (inv: any) => Math.round(inv.total_amount || 0) < thresholdMin,
        );
        if (belowIdx === -1) break;

        const belowInv: any = invoices[belowIdx];
        const belowCategory = belowInv.products?.[0]?.category;
        const belowProductIds = new Set(
          belowInv.products.map((p: any) => p.product_id),
        );
        const targetIdx = invoices.findIndex(
          (inv: any, idx: number) =>
            idx !== belowIdx &&
            inv.products?.[0]?.category === belowCategory &&
            Math.round(inv.total_amount || 0) +
              Math.round(belowInv.total_amount || 0) <=
              thresholdMax &&
            !inv.products.some((p: any) => belowProductIds.has(p.product_id)),
        );

        if (targetIdx === -1) break;

        const targetInv: any = invoices[targetIdx];
        targetInv.products.push(...belowInv.products);
        targetInv.total_amount = Math.round(
          (Number(targetInv.total_amount) || 0) +
            (Number(belowInv.total_amount) || 0),
        );
        invoices.splice(belowIdx, 1);
        mergedGlobally = true;
      }

      const stillBelow = invoices.filter(
        (inv: any) => Math.round(inv.total_amount || 0) < thresholdMin,
      );
      if (stillBelow.length > 0) {
        throw new Error(
          `Minimum Invoice Amount Violation: ${stillBelow.length} generated invoice(s) (e.g. ${stillBelow[0].invoice_number || "unnumbered"} at ₹${stillBelow[0].total_amount}) could not be brought up to the batch's minimum invoice amount (₹${thresholdMin}) — no compatible same-category invoice anywhere in the batch had room to absorb it. Try lowering the minimum invoice amount or regenerating.`,
        );
      }
    }

    // ── Exact Batch Total Balancing Routine (Issue 6) ──
    // Guarantees sum(invoice.total_amount) === batch.total_amount to exact ₹0 (whole integer rupees)
    const targetTotal = Math.round(batch.total_amount);
    let currentTotal = Math.round(
      invoices.reduce((sum, inv) => sum + Math.round(inv.total_amount || 0), 0),
    );
    let batchDiff = targetTotal - currentTotal;

    // Major Customer invoices must keep their own exact sum/max-limit
    // (enforced by STEP 4 below) — never touch them here.
    const majorCustomerIds = new Set(
      majorCustomers.map((m) => m.customer_id).filter(Boolean),
    );
    const balanceableInvoices = invoices.filter(
      (inv: any) => !majorCustomerIds.has(inv.customer_id),
    );

    // Spread the diff across balanceable invoices via solveLineForTarget,
    // always keeping each invoice within [thresholdMin, thresholdMax] where
    // possible — never dumping the whole diff onto a single invoice
    // regardless of its limits.
    if (Math.abs(batchDiff) > 0 && balanceableInvoices.length > 0) {
      let remainingBatchDiff = batchDiff;
      for (const inv of balanceableInvoices) {
        if (Math.abs(remainingBatchDiff) <= 0) break;
        if (!inv.products || inv.products.length === 0) continue;
        const currentInvTotal = Math.round(inv.total_amount || 0);
        const room =
          remainingBatchDiff > 0
            ? thresholdMax - currentInvTotal
            : currentInvTotal - thresholdMin;
        const applied =
          room > 0
            ? remainingBatchDiff > 0
              ? Math.min(remainingBatchDiff, room)
              : Math.max(remainingBatchDiff, -room)
            : 0;
        if (applied === 0) continue;

        const lastItem = inv.products[inv.products.length - 1];
        const previousAmount = lastItem.amount || 0;
        const targetLineAmt = Math.round(previousAmount + applied);
        if (targetLineAmt <= 0) continue;
        const solved = this.solveLineForTarget(
          lastItem.product_id,
          lastItem.quantity,
          targetLineAmt,
          productConfigById,
        );
        lastItem.quantity = solved.quantity;
        lastItem.rate = solved.rate;
        lastItem.amount = computeLineAmount(lastItem.quantity, lastItem.rate);
        inv.total_amount = Math.round(
          inv.products.reduce(
            (s: number, p: any) => s + Math.round(p.amount || 0),
            0,
          ),
        );
        remainingBatchDiff =
          Math.round(
            (remainingBatchDiff - (inv.total_amount - currentInvTotal)) * 100,
          ) / 100;
      }

      // No balanceable invoice had room to absorb the rest of the diff
      // within [thresholdMin, thresholdMax]. Exceeding an invoice's
      // configured maximum to force an exact batch total is exactly the
      // bug this was meant to guard against — leave the residual unclosed
      // (a small, logged drift) rather than violate the invoice cap.
      if (Math.abs(remainingBatchDiff) > 0) {
        console.warn(
          `[generateInvoiceSplitupsInternal] ₹${remainingBatchDiff} of batch total drift could not be closed without exceeding a balanceable invoice's configured min/max — left as a residual rather than violating thresholdMax.`,
        );
      }
    }

    // ── STEP 4: Pre-Persistence Validation Guard for Sales Major Customers ────
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount <= 0) continue;

      const custInvoices = invoices.filter(
        (inv) =>
          inv.products?.[0]?.customer_id === m.customer_id ||
          (inv as any).customer_id === m.customer_id,
      );

      if (custInvoices.length !== mInvCount) {
        throw new Error(
          `Major Customer invoice count mismatch: expected ${mInvCount} invoices for customer ${m.customer_id}, got ${custInvoices.length}. Major Customer invoice count mismatch.`,
        );
      }

      for (const inv of custInvoices) {
        const amt = Math.round(inv.total_amount || 0);
        if (amt > mMaxLimit) {
          throw new Error(
            `Major Customer invoice exceeds configured maximum: invoice total ₹${amt} exceeds max limit ₹${mMaxLimit}. Major Customer invoice exceeds configured maximum.`,
          );
        }
      }

      const custSum = Math.round(
        custInvoices.reduce((s, i) => s + Math.round(i.total_amount || 0), 0),
      );
      if (custSum !== Math.round(mAmount)) {
        throw new Error(
          `Major Customer balancing failed: expected ₹${Math.round(mAmount)}, got ₹${custSum}. Major Customer balancing failed.`,
        );
      }
    }

    // ── Chronological & Ascending Invoice Number Sort ──
    invoices.sort((a, b) => {
      const dateCmp = (a.invoice_date || "").localeCompare(
        b.invoice_date || "",
      );
      if (dateCmp !== 0) return dateCmp;
      return (a.invoice_number || "").localeCompare(
        b.invoice_number || "",
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      );
    });

    return invoices;
  }

  private static pickRandomProductsSubset(
    allProducts: ProductConfig[],
    recurringProducts: RecurringProductConfig[],
    targetAmount: number,
  ): ProductConfig[] {
    const productData = allProducts.map((config) => {
      const minQty = parseFloat(config.perDayQtyMin);
      const minRate = parseFloat(config.perDayRateMin);
      const maxQty = parseFloat(config.perDayQtyMax);
      const maxRate = parseFloat(config.perDayRateMax);

      return {
        config,
        minAmount: minQty * minRate,
        maxAmount: maxQty * maxRate,
      };
    });

    const results: ProductConfig[][] = [];
    const maxResults = 50;

    const shuffledProducts = [...productData].sort(() => Math.random() - 0.5);

    function backtrack(
      index: number,
      currentSubset: ProductConfig[],
      currentMin: number,
      currentMax: number,
    ) {
      if (results.length >= maxResults) return;

      if (
        currentSubset.length > 0 &&
        currentMin <= targetAmount &&
        targetAmount <= currentMax
      ) {
        results.push([...currentSubset]);
      }

      for (let i = index; i < shuffledProducts.length; i++) {
        const p = shuffledProducts[i];
        if (currentMin + p.minAmount > targetAmount) {
          continue;
        }

        currentSubset.push(p.config);
        backtrack(
          i + 1,
          currentSubset,
          currentMin + p.minAmount,
          currentMax + p.maxAmount,
        );
        currentSubset.pop();
      }
    }

    backtrack(0, [], 0, 0);

    if (results.length === 0) {
      throw new Error(
        `No valid combination of available products can satisfy the requested amount ₹${targetAmount.toFixed(2)} within the configured rules.`,
      );
    }

    const scoredSubsets = results.map((subset) => {
      let score = 0;
      for (const p of subset) {
        const rec = recurringProducts.find(
          (r) => r.product_id === p.product_id,
        );
        if (rec) {
          score += rec.percentage;
        } else {
          score += 5;
        }
      }
      score += Math.random() * 20;
      return { subset, score };
    });

    scoredSubsets.sort((a, b) => b.score - a.score);
    return scoredSubsets[0].subset;
  }

  private static distributeAmountToProducts(
    productConfigs: ProductConfig[],
    targetAmount: number,
  ) {
    const products: Array<{
      product_id: string;
      product_name: string;
      hsn_code: string;
      unit_of_measure: string;
      quantity: number;
      rate: number;
      amount: number;
    }> = [];

    if (!productConfigs || productConfigs.length === 0) {
      return products;
    }

    const productData = productConfigs.map((config) => {
      const minQty = parseFloat(config.perDayQtyMin);
      const minRate = parseFloat(config.perDayRateMin);
      const maxQty = parseFloat(config.perDayQtyMax);
      const maxRate = parseFloat(config.perDayRateMax);

      return {
        config,
        minAmount: minQty * minRate,
        maxAmount: maxQty * maxRate,
        minQty,
        minRate,
        maxQty,
        maxRate,
      };
    });

    const selectedProducts = productData;
    const totalMin = selectedProducts.reduce((sum, p) => sum + p.minAmount, 0);

    const A = selectedProducts.map((p) => p.minAmount);
    let remaining = targetAmount - totalMin;

    const indices = selectedProducts
      .map((_, i) => i)
      .sort(() => Math.random() - 0.5);

    for (const idx of indices) {
      if (remaining <= 0) break;
      const p = selectedProducts[idx];
      const maxAdd = p.maxAmount - A[idx];
      const add = Math.min(remaining, maxAdd);
      A[idx] = Math.round((A[idx] + add) * 100) / 100;
      remaining -= add;
    }

    let currentSum = A.reduce((sum, val) => sum + val, 0);
    let diff = Math.round((targetAmount - currentSum) * 100) / 100;

    if (Math.abs(diff) > 0.01) {
      for (const idx of indices) {
        const p = selectedProducts[idx];
        const newAmount = Math.round((A[idx] + diff) * 100) / 100;
        if (newAmount >= p.minAmount && newAmount <= p.maxAmount) {
          A[idx] = newAmount;
          diff = 0;
          break;
        }
      }
    }

    const existingQuantitiesInInvoice = new Set<number>();

    selectedProducts.forEach((item, index) => {
      const targetProdAmount = A[index];

      const qMinPossible = Math.ceil(targetProdAmount / item.maxRate);
      const qMaxPossible = Math.floor(targetProdAmount / item.minRate);
      const qLow = Math.max(item.minQty, qMinPossible);
      const qHigh = Math.min(item.maxQty, qMaxPossible);

      const lowBound = qLow <= qHigh ? qLow : item.minQty;
      const highBound = qLow <= qHigh ? qHigh : item.maxQty;
      let quantity = generateCommercialQuantity(lowBound, highBound, {
        productName: item.config.product_name,
        existingQuantities: existingQuantitiesInInvoice,
      });
      quantity = Math.max(item.minQty, Math.min(item.maxQty, quantity));
      quantity = roundToQuarterIncrement(quantity);
      existingQuantitiesInInvoice.add(quantity);

      let rate = Math.round(targetProdAmount / (quantity || 1));
      rate = Math.max(
        Math.round(item.minRate),
        Math.min(Math.round(item.maxRate), rate),
      );
      rate = roundToWholeInteger(rate);

      const finalAmount = computeLineAmount(quantity, rate);

      products.push({
        product_id: item.config.product_id,
        product_name: item.config.product_name,
        hsn_code: item.config.hsn_code,
        unit_of_measure: item.config.unit_of_measure,
        quantity,
        rate,
        amount: finalAmount,
      });
    });

    const totalAfter = products.reduce((s, p) => s + p.amount, 0);
    let finalDiff = Math.round((targetAmount - totalAfter) * 100) / 100;

    if (Math.abs(finalDiff) > 0.001) {
      let absorbed = false;
      for (let i = products.length - 1; i >= 0; i--) {
        const p = products[i];
        const config = selectedProducts.find(
          (pd) => pd.config.product_id === p.product_id,
        )!;
        const newAmount = Math.round((p.amount + finalDiff) * 100) / 100;
        const newRate = Math.round((newAmount / p.quantity) * 100) / 100;

        if (
          newAmount >= config.minAmount &&
          newAmount <= config.maxAmount &&
          newRate >= config.minRate &&
          newRate <= config.maxRate
        ) {
          p.amount = newAmount;
          p.rate = newRate;
          absorbed = true;
          break;
        }
      }

      if (!absorbed) {
        for (let i = products.length - 1; i >= 0; i--) {
          const p = products[i];
          const config = selectedProducts.find(
            (pd) => pd.config.product_id === p.product_id,
          )!;
          const newAmount = Math.round((p.amount + finalDiff) * 100) / 100;

          for (let q = config.minQty; q <= config.maxQty; q++) {
            const newRate = Math.round((newAmount / q) * 100) / 100;
            if (
              newRate >= config.minRate &&
              newRate <= config.maxRate &&
              Math.abs(q * newRate - newAmount) < 0.01
            ) {
              p.quantity = q;
              p.amount = newAmount;
              p.rate = newRate;
              absorbed = true;
              break;
            }
          }
          if (absorbed) break;
        }
      }

      if (!absorbed) {
        throw new Error(
          `Cannot distribute target amount ₹${targetAmount} to products without violating configured min/max rules.`,
        );
      }
    }

    return products;
  }

  private static partitionAmountRandomly(
    totalAmount: number,
    thresholdMin: number,
    thresholdMax: number,
  ): number[] {
    if (totalAmount <= 0) return [];
    if (totalAmount <= thresholdMax) return [totalAmount];

    const avgThreshold = (thresholdMin + thresholdMax) / 2;
    let targetInvoiceCount = Math.round(totalAmount / avgThreshold);
    const minInvoices = Math.ceil(totalAmount / thresholdMax);
    const maxInvoices = Math.floor(totalAmount / thresholdMin);

    targetInvoiceCount = Math.max(
      minInvoices,
      Math.min(maxInvoices, targetInvoiceCount),
    );
    if (targetInvoiceCount < 1) targetInvoiceCount = 1;

    // 1. Assign random weights to distribute headroom uniformly across all target invoices
    const weights: number[] = [];
    let sumWeights = 0;
    for (let i = 0; i < targetInvoiceCount; i++) {
      const w = Math.random() + 0.1;
      weights.push(w);
      sumWeights += w;
    }

    let unallocated = totalAmount - targetInvoiceCount * thresholdMin;
    const invoiceBudgets: number[] = [];

    for (let i = 0; i < targetInvoiceCount; i++) {
      const share = (unallocated * weights[i]) / sumWeights;
      const rawBudget = Math.min(
        thresholdMax,
        Math.max(thresholdMin, thresholdMin + share),
      );
      const roundedBudget = Math.round(rawBudget * 100) / 100;
      invoiceBudgets.push(roundedBudget);
    }

    // 2. Adjust drift to ensure exact totalAmount sum matching
    let currentSum =
      Math.round(invoiceBudgets.reduce((s, b) => s + b, 0) * 100) / 100;
    let drift = Math.round((totalAmount - currentSum) * 100) / 100;

    if (Math.abs(drift) > 0.001) {
      const indices = Array.from(
        { length: invoiceBudgets.length },
        (_, k) => k,
      ).sort(() => Math.random() - 0.5);

      for (const idx of indices) {
        if (Math.abs(drift) <= 0.001) break;
        if (drift > 0) {
          const headroom = thresholdMax - invoiceBudgets[idx];
          if (headroom > 0) {
            const add = Math.min(drift, headroom);
            invoiceBudgets[idx] =
              Math.round((invoiceBudgets[idx] + add) * 100) / 100;
            drift = Math.round((drift - add) * 100) / 100;
          }
        } else {
          const headroom = invoiceBudgets[idx] - thresholdMin;
          if (headroom > 0) {
            const sub = Math.min(-drift, headroom);
            invoiceBudgets[idx] =
              Math.round((invoiceBudgets[idx] - sub) * 100) / 100;
            drift = Math.round((drift + sub) * 100) / 100;
          }
        }
      }
    }

    // Fisher-Yates shuffle so invoice amounts are naturally random across order
    for (let i = invoiceBudgets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = invoiceBudgets[i];
      invoiceBudgets[i] = invoiceBudgets[j];
      invoiceBudgets[j] = temp;
    }

    return invoiceBudgets;
  }

  public static validateOccurrenceDistribution(products: ProductConfig[]): {
    isValid: boolean;
    totalOccurrence: number;
    categorySplit: { Meat: number; Fruits: number };
    error?: string;
  } {
    if (!products || products.length === 0) {
      return {
        isValid: false,
        totalOccurrence: 0,
        categorySplit: { Meat: 0, Fruits: 0 },
        error:
          "Purchase generation cannot continue because occurrence distribution is incomplete.",
      };
    }

    let totalOccurrence = 0;
    let meatTotal = 0;
    let fruitsTotal = 0;

    for (const p of products) {
      const occStr = p.occurrencePercentage;
      const occ =
        typeof occStr === "number" ? occStr : parseFloat(String(occStr ?? ""));
      if (isNaN(occ) || occ < 0 || occ > 100) {
        return {
          isValid: false,
          totalOccurrence: 0,
          categorySplit: { Meat: 0, Fruits: 0 },
          error: `Product "${p.product_name}": Please enter a valid Occurrence Percentage between 0% and 100%.`,
        };
      }

      totalOccurrence += occ;
      const cat = (p as any).category_name || (p as any).category || "Meat";
      if (String(cat).toUpperCase().includes("FRUIT")) {
        fruitsTotal += occ;
      } else {
        meatTotal += occ;
      }
    }

    totalOccurrence = Math.round(totalOccurrence * 100) / 100;
    meatTotal = Math.round(meatTotal * 100) / 100;
    fruitsTotal = Math.round(fruitsTotal * 100) / 100;

    if (Math.abs(totalOccurrence - 100) > 0.01) {
      return {
        isValid: false,
        totalOccurrence,
        categorySplit: { Meat: meatTotal, Fruits: fruitsTotal },
        error: `Total Product Occurrence Percentage must equal exactly 100%. Current Total: ${totalOccurrence.toFixed(1)}%.`,
      };
    }

    return {
      isValid: true,
      totalOccurrence,
      categorySplit: { Meat: meatTotal, Fruits: fruitsTotal },
    };
  }

  public static selectProductsByOccurrence(
    products: ProductConfig[],
    count: number,
  ): ProductConfig[] {
    if (!products || products.length === 0) return [];

    // Filter products with occurrencePercentage > 0
    const validProducts = products.filter((p) => {
      if (
        p.occurrencePercentage === undefined ||
        p.occurrencePercentage === null
      ) {
        return true;
      }
      return Number(p.occurrencePercentage) > 0;
    });

    if (validProducts.length === 0) return [];
    if (validProducts.length <= count) return [...validProducts];

    const result: ProductConfig[] = [];
    const pool = [...validProducts];

    while (result.length < count && pool.length > 0) {
      const totalWeight = pool.reduce(
        (sum, p) => sum + (Number(p.occurrencePercentage) || 1),
        0,
      );
      let rand = Math.random() * totalWeight;
      let chosenIdx = 0;
      for (let i = 0; i < pool.length; i++) {
        const weight = Number(pool[i].occurrencePercentage) || 1;
        if (rand < weight) {
          chosenIdx = i;
          break;
        }
        rand -= weight;
      }
      result.push(pool[chosenIdx]);
      pool.splice(chosenIdx, 1);
    }

    return result.sort(
      (a, b) =>
        (Number(b.occurrencePercentage) || 0) -
        (Number(a.occurrencePercentage) || 0),
    );
  }

  private static getSequentialDateForIndex(
    index: number,
    totalInvoices: number,
    dateList: string[],
  ): string {
    if (!dateList || dateList.length === 0) return "";
    const numDays = dateList.length;
    if (numDays === 1) return dateList[0];

    const total = Math.max(1, totalInvoices);
    const basePerDay = Math.floor(total / numDays);
    const extraDays = total % numDays;
    const cutoff = extraDays * (basePerDay + 1);

    let dayIndex = 0;
    if (index < cutoff) {
      dayIndex = basePerDay + 1 > 0 ? Math.floor(index / (basePerDay + 1)) : 0;
    } else {
      const remainingIdx = index - cutoff;
      dayIndex =
        extraDays +
        (basePerDay > 0 ? Math.floor(remainingIdx / basePerDay) : 0);
    }

    const boundedDayIndex = Math.min(numDays - 1, Math.max(0, dayIndex));
    return dateList[boundedDayIndex];
  }

  /**
   * Solves a line item's quantity/rate to hit targetAmt as closely as
   * possible without leaving either bound. Rate-only correction can't close
   * large drifts once it hits the product's configured rate ceiling/floor —
   * this also grows/shrinks quantity within its own configured range to make
   * up the remainder, since quantity_min/quantity_max is just as valid a
   * configured constraint as rate_min/rate_max and just as flexible.
   */
  /**
   * Solves a line's quantity/rate to hit targetAmt, keeping quantity strictly
   * on the commercial quarter-KG grid (.00/.25/.50/.75) and rate a whole
   * rupee. Both being discretized means a single (rate, quantity) pair
   * usually can't be nudged to hit an arbitrary rupee target exactly by
   * varying quantity alone — a quarter-KG step at a high rate can be a
   * ₹100+ jump, so an exact few-rupee gap can be mathematically unreachable
   * at that one rate. Varying rate by ±1 changes the amount by exactly the
   * line's quantity — a much finer, DIFFERENT-sized adjustment — so this
   * searches a small grid of nearby rates x nearby quarter-KG quantities
   * around the ideal point and prefers whichever combination lands exactly
   * on targetAmt. Callers that spread a residual across many lines
   * (drift-closing loops) call this repeatedly, recomputing the remaining
   * gap after each line — so even when one line can't close it exactly,
   * the next one usually can, and the loop converges to a ₹0 residual
   * without ever using a non-commercial quantity.
   *
   * When preferFloor is true, a candidate that would push the amount above
   * targetAmt is rejected — used wherever targetAmt was itself already
   * computed as a hard ceiling (e.g. an invoice's remaining headroom below
   * its configured Maximum Invoice Amount), so rounding can never tip the
   * invoice over that ceiling. The leftover (if any) is left for the next
   * line/invoice in the caller's spreading loop to pick up.
   */
  private static solveLineForTarget(
    productId: string,
    currentQuantity: number,
    targetAmt: number,
    productConfigById: Map<string, ProductConfig>,
    options: { preferFloor?: boolean } = {},
  ): { quantity: number; rate: number } {
    const config = productConfigById.get(productId);
    const minR = config ? parseFloat(config.perDayRateMin as any) : NaN;
    const maxR = config ? parseFloat(config.perDayRateMax as any) : NaN;
    const minQ = config ? parseFloat(config.perDayQtyMin as any) : NaN;
    const maxQ = config ? parseFloat(config.perDayQtyMax as any) : NaN;
    const hasRateBounds =
      Number.isFinite(minR) && Number.isFinite(maxR) && minR <= maxR;
    const hasQtyBounds =
      Number.isFinite(minQ) && Number.isFinite(maxQ) && minQ <= maxQ;

    let qty = currentQuantity > 0 ? currentQuantity : hasQtyBounds ? minQ : 1;
    let rate = roundToWholeInteger(targetAmt / qty);
    if (hasRateBounds) {
      rate = Math.min(maxR, Math.max(minR, rate));
    }
    if (rate <= 0) {
      rate = hasRateBounds ? minR : 1;
    }

    const amountAtCurrentQty = computeLineAmount(qty, rate);

    if (hasQtyBounds && Math.abs(amountAtCurrentQty - targetAmt) > 0.5) {
      const baseRate = rate;

      type Candidate = { qty: number; rate: number; amount: number; diff: number };
      let best: Candidate | undefined;

      // A ±3 window around the ideal rate misses an exact whole-rupee match
      // whenever it happens to sit further away — which is common on a
      // target this specific (an exact multiplier of a major customer's
      // configured amount). Progressively widen the search — cheap because
      // it stops the instant an exact (diff === 0) match is found — instead
      // of settling for a ₹1-2 residual that a later strict guard rejects.
      const windows = hasRateBounds
        ? [3, 10, 30, Math.ceil(maxR - minR)]
        : [0];

      outer: for (const window of windows) {
        const rateCandidates = new Set<number>([baseRate]);
        if (hasRateBounds) {
          for (let d = -window; d <= window; d++) {
            const r = baseRate + d;
            if (r >= minR && r <= maxR) rateCandidates.add(r);
          }
        }

        for (const candidateRate of rateCandidates) {
          if (candidateRate <= 0) continue;
          const idealQty = targetAmt / candidateRate;
          const idealK = idealQty * 4;
          const candidateKs = new Set<number>([
            Math.floor(idealK),
            Math.ceil(idealK),
            Math.round(idealK),
          ]);

          for (const k of candidateKs) {
            if (k <= 0) continue;
            const candidateQty = Math.min(maxQ, Math.max(minQ, k / 4));
            const candidateAmount = computeLineAmount(
              candidateQty,
              candidateRate,
            );
            if (options.preferFloor && candidateAmount > targetAmt) continue;
            const diff = Math.abs(candidateAmount - targetAmt);
            if (!best || diff < best.diff) {
              best = {
                qty: candidateQty,
                rate: candidateRate,
                amount: candidateAmount,
                diff,
              };
            }
            if (diff === 0) break outer;
          }
        }

        if (!hasRateBounds || window >= maxR - minR) break;
      }

      if (best) {
        qty = best.qty;
        rate = best.rate;
      } else if (options.preferFloor) {
        // Every candidate overshot targetAmt (a hard ceiling) — fall back
        // to the largest one at the base rate that still fits under it.
        const idealK = (targetAmt / baseRate) * 4;
        qty = Math.max(minQ, Math.min(maxQ, Math.floor(idealK) / 4));
      } else {
        const idealQty = targetAmt / baseRate;
        qty = Math.max(minQ, Math.min(maxQ, roundToQuarterIncrement(idealQty)));
      }
    }

    return { quantity: qty, rate };
  }

  private static lineCapacity(p: any): number {
    const maxQty = parseFloat(p.perDayQtyMax) || 0;
    const maxRate = parseFloat(p.perDayRateMax) || 0;
    return maxQty * maxRate;
  }

  // Upper bound on what a single invoice can realistically total, given the
  // rate/quantity ceilings configured for every product in its category.
  private static maxAchievableInvoiceAmount(categoryProducts: any[]): number {
    return categoryProducts.reduce(
      (sum, p) => sum + this.lineCapacity(p),
      0,
    );
  }

  // Picks enough of a category's highest-capacity products so their combined
  // max quantity x max rate ceiling can reach targetBudget (falling back to
  // the whole category if it's still not enough), with a small random
  // top-up for line-item variety on smaller invoices.
  private static selectProductsForBudgetCapacity(
    categoryProducts: any[],
    targetBudget: number,
  ): any[] {
    const capacityDesc = [...categoryProducts].sort(
      (a, b) => this.lineCapacity(b) - this.lineCapacity(a),
    );
    let neededCount = 0;
    let cumulativeCap = 0;
    for (const p of capacityDesc) {
      if (cumulativeCap >= targetBudget) break;
      cumulativeCap += this.lineCapacity(p);
      neededCount++;
    }
    const randomVariety = Math.floor(Math.random() * 6) + 3;
    const count = Math.min(
      capacityDesc.length,
      Math.max(neededCount, randomVariety),
    );
    return capacityDesc.slice(0, count);
  }

  private static lineFloor(p: any): number {
    const minQty = parseFloat(p.perDayQtyMin) || 10;
    const minRate = parseFloat(p.perDayRateMin) || 10;
    return minQty * minRate;
  }

  /**
   * Finds the product whose cheapest possible line (quantity_min x
   * rate_min) still fits within targetBudget, preferring the most
   * expensive one that fits (best occurrence variety) over always picking
   * the absolute cheapest. Falls back to the category's overall cheapest
   * line if nothing fits (shouldn't happen given the upfront
   * Minimum-Invoice-Amount feasibility guard, but stays safe either way).
   *
   * Occurrence-weighted selection picks products irrespective of price, so
   * on a tight budget the first product it hands back can easily have a
   * floor above the target — and since the very first line of an invoice
   * is exempt from the "don't exceed budget" guard (an invoice can't start
   * with zero lines), that line gets added anyway and the invoice
   * overshoots before any drift-correction even runs. Guaranteeing the
   * first product always fits removes that overshoot at the source.
   */
  private static cheapestFittingProduct(
    categoryProducts: any[],
    targetBudget: number,
  ): any {
    let bestFit: any = null;
    let bestFitFloor = -Infinity;
    let cheapestOverall: any = null;
    let cheapestOverallFloor = Infinity;
    for (const p of categoryProducts) {
      const floor = this.lineFloor(p);
      if (floor < cheapestOverallFloor) {
        cheapestOverallFloor = floor;
        cheapestOverall = p;
      }
      if (floor <= targetBudget && floor > bestFitFloor) {
        bestFitFloor = floor;
        bestFit = p;
      }
    }
    return bestFit || cheapestOverall;
  }

  // Every invoice needs a "guaranteed affordable" first line so it never
  // ends up empty — but cheapestFittingProduct() picks that deterministically
  // by price fit alone (highest floor still <= budget), which is the same
  // 1-2 products for any given budget range, invoice after invoice,
  // regardless of their configured Occurrence Percentage. Across an entire
  // batch that systematically overrepresents whichever product happens to
  // fit typical invoice budgets best, at the expense of every other
  // configured product — exactly the "not obeying occurrence" symptom.
  // This does the same affordability filtering, but picks among the
  // affordable set with an occurrence-weighted random draw (reusing
  // selectProductsByOccurrence's weighting) instead of a fixed price-fit
  // ranking, falling back to the deterministic pick only when nothing is
  // affordable (need SOME product, and occurrence doesn't matter if the
  // pool is one item anyway).
  private static occurrenceWeightedFittingProduct(
    categoryProducts: any[],
    targetBudget: number,
  ): any {
    const affordable = categoryProducts.filter(
      (p) => this.lineFloor(p) <= targetBudget,
    );
    if (affordable.length === 0) {
      return this.cheapestFittingProduct(categoryProducts, targetBudget);
    }
    const [picked] = this.selectProductsByOccurrence(affordable, 1);
    return picked || this.cheapestFittingProduct(categoryProducts, targetBudget);
  }

  private static generatePurchaseInvoiceSplitupsInternal(
    batch: InvoiceBatch,
    numberOfDays: number,
    startDate: Date,
    startingCounter: number,
    monthlyQuantities?: Map<string, number>,
    supplierCategoryMap?: Map<string, "Fruits" | "Meat">,
  ) {
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    const totalAmount = batch.total_amount;

    let invoiceCounter = startingCounter;
    const invoices: any[] = [];

    let selectedCustomers = batch.selected_customers || [];
    const majorCustomers = batch.major_customers || [];

    if (
      selectedCustomers.length === 0 &&
      majorCustomers.length === 0 &&
      batch.receiving_company_id
    ) {
      selectedCustomers = [batch.receiving_company_id];
    }

    // Classify selected suppliers into Fruits vs Meat
    const fruitSuppliers: string[] = [];
    const meatSuppliers: string[] = [];
    for (const custId of selectedCustomers) {
      const cat = supplierCategoryMap?.get(custId) || "Meat";
      if (cat === "Fruits") {
        fruitSuppliers.push(custId);
      } else {
        meatSuppliers.push(custId);
      }
    }

    // 1. Group products strictly by category using getProductCategory(p) (excluding 0% occurrence products)
    const productsByCategory = new Map<string, ProductConfig[]>();
    for (const p of batch.products) {
      const occ =
        p.occurrencePercentage !== undefined && p.occurrencePercentage !== null
          ? Number(p.occurrencePercentage)
          : 100;
      if (occ <= 0) continue; // Exclude 0% occurrence products completely!

      const catKey = this.getProductCategory(p);
      if (!productsByCategory.has(catKey)) {
        productsByCategory.set(catKey, []);
      }
      productsByCategory.get(catKey)!.push(p);
    }

    // Used by the drift/exact-balance-correction passes below, which
    // recompute a line's rate from a target amount (rate = amount /
    // quantity) to hit an invoice/major-customer budget exactly. Without
    // clamping to the product's own configured rate range, that recomputed
    // rate can land anywhere — this is what let generated rates fall
    // outside product_rules.rate_min/rate_max, most visibly on major
    // customer invoices, which get an extra balance-correction pass on top
    // of the per-invoice one.
    const productConfigById = new Map<string, ProductConfig>();
    for (const p of batch.products) {
      productConfigById.set(p.product_id, p);
    }

    let categoryKeys = Array.from(productsByCategory.keys());

    // If suppliers are specified, filter product categories to match supplier categories
    if (
      selectedCustomers.length > 0 &&
      supplierCategoryMap &&
      supplierCategoryMap.size > 0
    ) {
      const hasFruitSuppliers = fruitSuppliers.length > 0;
      const hasMeatSuppliers = meatSuppliers.length > 0;

      if (hasFruitSuppliers && !hasMeatSuppliers) {
        // ONLY Fruit Suppliers selected: ONLY bill Fruit products!
        categoryKeys = categoryKeys.filter((c) => c === "Fruits");
      } else if (hasMeatSuppliers && !hasFruitSuppliers) {
        // ONLY Meat Suppliers selected: ONLY bill Meat products!
        categoryKeys = categoryKeys.filter((c) => c === "Meat");
      }
    }

    if (categoryKeys.length === 0) return [];

    // Feasibility guard: an invoice can never total less than its cheapest
    // possible single line (quantity_min x rate_min of the cheapest product
    // in its category). If the configured Minimum Invoice Amount is below
    // that floor, every small invoice is structurally forced above target
    // and no downstream drift-correction can fix it — surface this clearly
    // now instead of failing with a confusing total mismatch after
    // generating thousands of invoices.
    for (const catKey of categoryKeys) {
      const catProducts = productsByCategory.get(catKey) || [];
      if (catProducts.length === 0) continue;
      let cheapestLine = Infinity;
      let cheapestProductName = "";
      for (const p of catProducts) {
        const minQty = parseFloat(p.perDayQtyMin) || 10;
        const minRate = parseFloat(p.perDayRateMin) || 10;
        const floor = minQty * minRate;
        if (floor < cheapestLine) {
          cheapestLine = floor;
          cheapestProductName = p.product_name;
        }
      }
      if (Number.isFinite(cheapestLine) && thresholdMin < cheapestLine) {
        throw new Error(
          `Configured Minimum Invoice Amount (₹${thresholdMin.toFixed(2)}) is below the lowest amount achievable with a single product line in the "${catKey}" category — even the cheapest product, ${cheapestProductName}, needs at least ₹${cheapestLine.toFixed(2)} per line (its configured minimum quantity x minimum rate). Raise the Minimum Invoice Amount to at least ₹${cheapestLine.toFixed(2)}, or lower the Quantity/Rate minimums in Product Rules for this category.`,
        );
      }
    }

    // Prepare date list
    const dateList: string[] = [];
    for (let d = 0; d < numberOfDays; d++) {
      const curDate = new Date(startDate);
      curDate.setDate(startDate.getDate() + d);
      dateList.push(formatDateForStorage(curDate));
    }

    // ── Rule 8 Validation: Ensure Major Customer Total does NOT exceed Batch Total & Max Limits ──
    let totalMajorAmount = 0;
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount > 0) {
        totalMajorAmount += mAmount;
      }

      if (mAmount > 0 && mInvCount > 0 && mMaxLimit > 0) {
        const maxPossible = mInvCount * mMaxLimit;
        if (maxPossible < mAmount) {
          throw new Error(
            `Major Customer configuration cannot satisfy requested amount. Major Customer requires ₹${mAmount.toFixed(2)} across ${mInvCount} invoice(s), but maximum possible total is ₹${maxPossible.toFixed(2)} (max limit ₹${mMaxLimit.toFixed(2)} per invoice). Major Customer configuration cannot satisfy requested amount.`,
          );
        }
      }
    }

    if (totalMajorAmount > totalAmount) {
      throw new Error(
        `Major Customer Total (₹${totalMajorAmount.toFixed(2)}) exceeds Purchase Batch Total (₹${totalAmount.toFixed(2)}). Remaining Batch Amount cannot be negative.`,
      );
    }

    // ── STEP 1: Process Configured Major Customers ──────────────────────────────
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const supplierId = m.customer_id;
      const catKey = supplierCategoryMap?.get(supplierId) || "Meat";
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount <= 0 || mInvCount <= 0) continue;

      // Determine invoice budgets for this Major Customer
      const majorBudgets: number[] = [];
      if (mInvCount === 1) {
        majorBudgets.push(mAmount);
      } else {
        const avgBudget = Math.round((mAmount / mInvCount) * 100) / 100;
        let unallocatedM = mAmount;

        for (let b = 0; b < mInvCount; b++) {
          const alloc = Math.min(unallocatedM, avgBudget);
          majorBudgets.push(alloc);
          unallocatedM = Math.round((unallocatedM - alloc) * 100) / 100;
        }

        for (let b = 0; b < mInvCount; b++) {
          if (unallocatedM <= 0) break;
          const headroom = Math.max(0, mMaxLimit - majorBudgets[b]);
          if (headroom > 0) {
            const maxAdd = Math.min(unallocatedM, headroom);
            const add =
              b === mInvCount - 1
                ? maxAdd
                : Math.round(Math.random() * maxAdd * 100) / 100;
            majorBudgets[b] = Math.round((majorBudgets[b] + add) * 100) / 100;
            unallocatedM = Math.round((unallocatedM - add) * 100) / 100;
          }
        }
      }

      // Generate exact Major Customer Invoices. actualCatKey must stay
      // locked to the supplier's real, configured category (catKey, from
      // suppliers.category) — silently falling back to whichever category
      // happens to have products available used to create invoices whose
      // products didn't actually match their supplier's category. That
      // mismatch was invisible at generation time (nothing there re-checks
      // it) and only surfaced later as a confusing "Supplier category is
      // incompatible" error the first time the invoice was edited.
      const actualCatKey: "Fruits" | "Meat" = catKey as "Fruits" | "Meat";
      const categoryProducts = productsByCategory.get(actualCatKey) || [];
      if (categoryProducts.length === 0) {
        throw new Error(
          `Major Customer's supplier is configured as "${actualCatKey}" category, but no ${actualCatKey} products with a positive Occurrence Percentage are selected for this batch. Add ${actualCatKey} products to the batch (or configure this Major Customer with a supplier of a matching category) before generating.`,
        );
      }

      const maxAchievable = this.maxAchievableInvoiceAmount(categoryProducts);
      const largestBudget = Math.max(...majorBudgets);
      if (maxAchievable > 0 && largestBudget > maxAchievable) {
        throw new Error(
          `Major Customer configuration cannot be satisfied within the configured rate/quantity limits. One of the invoices needs ₹${largestBudget.toFixed(2)}, but the maximum realistic invoice total for the "${actualCatKey}" category (given current Product Rules) is ₹${maxAchievable.toFixed(2)}. Please lower the Major Customer amount or invoice limits, increase the invoice count, or widen the Rate/Quantity ranges in Product Rules for this category.`,
        );
      }

      for (let b = 0; b < majorBudgets.length; b++) {
        const targetBudget = majorBudgets[b];
        const dateStr = this.getSequentialDateForIndex(
          invoices.length,
          majorBudgets.length,
          dateList,
        );

        const capacitySelection = this.selectProductsForBudgetCapacity(
          categoryProducts,
          targetBudget,
        );
        const firstFit = this.occurrenceWeightedFittingProduct(
          categoryProducts,
          targetBudget,
        );
        const chosenProducts = firstFit
          ? [
              firstFit,
              ...capacitySelection.filter(
                (p) => p.product_id !== firstFit.product_id,
              ),
            ]
          : capacitySelection;

        let currentInvoiceProducts: any[] = [];
        let currentInvoiceAmount = 0;
        const usedQuantities = new Set<number>();

        for (let j = 0; j < chosenProducts.length; j++) {
          const p = chosenProducts[j];
          const minR = parseFloat(p.perDayRateMin) || 10;
          const maxR = parseFloat(p.perDayRateMax) || 500;
          let rate = roundToWholeInteger(minR + Math.random() * (maxR - minR));

          const minQ = parseFloat(p.perDayQtyMin) || 10;
          const maxQ = Math.max(minQ, parseFloat(p.perDayQtyMax) || 100);

          const remBudget = targetBudget - currentInvoiceAmount;
          if (remBudget <= 0) break;

          // The invoice's first line is exempt from the "don't exceed
          // budget" check below (an invoice can't end up with zero lines) —
          // so its rate must itself be capped to whatever the target budget
          // can actually afford at the minimum commercial quantity, instead
          // of using an uncapped random rate that can blow straight past a
          // tight budget (and from there, past thresholdMax) before any
          // line has even been added.
          if (currentInvoiceProducts.length === 0) {
            const maxAffordableRate = remBudget / minQ;
            if (rate > maxAffordableRate) {
              // A cap must always round DOWN — rounding to the nearest
              // whole number (e.g. 999.9 -> 1000) can land back above the
              // budget it was supposed to enforce.
              rate = Math.max(minR, Math.floor(maxAffordableRate));
            }
          }

          const maxQtyFitting = remBudget / (rate || 1);
          if (maxQtyFitting < minQ && currentInvoiceProducts.length > 0) {
            break;
          }

          const upperLimit = Math.min(maxQ, Math.max(minQ, maxQtyFitting));

          let qtyToPut = generateCommercialQuantity(minQ, upperLimit, {
            productName: p.product_name,
            existingQuantities: usedQuantities,
          });

          if (qtyToPut <= 0) qtyToPut = minQ;

          let amt = computeLineAmount(qtyToPut, rate);

          if (
            currentInvoiceAmount + amt > targetBudget &&
            currentInvoiceProducts.length > 0
          ) {
            break;
          }

          usedQuantities.add(qtyToPut);
          currentInvoiceProducts.push({
            product_id: p.product_id,
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            unit_of_measure: p.unit_of_measure,
            category: actualCatKey,
            quantity: qtyToPut,
            rate,
            amount: amt,
          });
          currentInvoiceAmount =
            Math.round((currentInvoiceAmount + amt) * 100) / 100;
        }

        if (currentInvoiceProducts.length === 0) {
          // categoryProducts is already occurrence-filtered (0%-occurrence
          // products excluded at the productsByCategory grouping stage,
          // above) and guaranteed non-empty here — never fall through to
          // an unfiltered batch.products[0], which could reintroduce a
          // 0%-occurrence product as this invoice's only line.
          const p =
            this.cheapestFittingProduct(categoryProducts, targetBudget) ||
            categoryProducts[0];
          const minQ = parseFloat(p.perDayQtyMin) || 10;
          const solved = this.solveLineForTarget(
            p.product_id,
            minQ,
            targetBudget,
            productConfigById,
            { preferFloor: true },
          );
          const amt = computeLineAmount(solved.quantity, solved.rate);
          currentInvoiceProducts.push({
            product_id: p.product_id,
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            unit_of_measure: p.unit_of_measure,
            category: actualCatKey,
            quantity: solved.quantity,
            rate: solved.rate,
            amount: amt,
          });
          currentInvoiceAmount = amt;
        }

        // Absorb drift to hit targetBudget cleanly
        let lineDrift =
          Math.round((targetBudget - currentInvoiceAmount) * 100) / 100;

        if (Math.abs(lineDrift) > 0.001 && currentInvoiceProducts.length > 0) {
          for (const item of currentInvoiceProducts) {
            if (Math.abs(lineDrift) <= 0.01) break;
            const targetLineAmt =
              Math.round((item.amount + lineDrift) * 100) / 100;
            if (targetLineAmt > 0) {
              const solved = this.solveLineForTarget(
                item.product_id,
                item.quantity,
                targetLineAmt,
                productConfigById,
                { preferFloor: true },
              );
              item.quantity = solved.quantity;
              item.rate = solved.rate;
              item.amount = computeLineAmount(item.quantity, item.rate);
              lineDrift =
                Math.round(
                  (targetBudget -
                    currentInvoiceProducts.reduce(
                      (s: number, p: any) => s + p.amount,
                      0,
                    )) *
                    100,
                ) / 100;
            }
          }
        }

        let finalInvoiceTotal =
          Math.round(
            currentInvoiceProducts.reduce((sum, p) => sum + p.amount, 0) * 100,
          ) / 100;

        const invDrift =
          Math.round(targetBudget) - Math.round(finalInvoiceTotal);
        if (Math.abs(invDrift) > 0 && currentInvoiceProducts.length > 0) {
          const lastItem =
            currentInvoiceProducts[currentInvoiceProducts.length - 1];
          const targetLineAmt = Math.round(lastItem.amount + invDrift);
          if (targetLineAmt > 0) {
            const solved = this.solveLineForTarget(
              lastItem.product_id,
              lastItem.quantity,
              targetLineAmt,
              productConfigById,
              { preferFloor: true },
            );
            lastItem.quantity = solved.quantity;
            lastItem.rate = solved.rate;
            lastItem.amount = computeLineAmount(
              lastItem.quantity,
              lastItem.rate,
            );
            finalInvoiceTotal =
              Math.round(
                currentInvoiceProducts.reduce(
                  (s: number, p: any) => s + p.amount,
                  0,
                ) * 100,
              ) / 100;
          }
        }

        const abbr = (batch as any).issuing_company_abbreviation || "IC";
        const fy = (batch.financial_year || "2026-27").replace(/^FY/i, "");
        const draftInvNumber = InvoiceNumberingService.formatInvoiceNumber(
          abbr,
          fy,
          batch.batch_type === "PURCHASE" ? "P" : "S",
          invoiceCounter++,
        );

        const productsWithSupplierId = currentInvoiceProducts.map((p: any) => ({
          ...p,
          customer_id: supplierId,
          supplier_id: supplierId,
        }));

        invoices.push({
          invoice_number: draftInvNumber,
          invoice_date: dateStr,
          customer_id: supplierId,
          supplier_id: supplierId,
          category_key: actualCatKey,
          products: productsWithSupplierId,
          total_amount: finalInvoiceTotal,
          status: "generated",
          batch_type: "PURCHASE",
        });
      }

      // Major Customer Exact Balance Correction Guard
      const mCustInvoices = invoices.filter(
        (inv) =>
          inv.customer_id === supplierId ||
          inv.supplier_id === supplierId ||
          inv.products?.[0]?.customer_id === supplierId,
      );
      if (mCustInvoices.length > 0) {
        const generatedSum = Math.round(
          mCustInvoices.reduce(
            (s, i) => s + Math.round(i.total_amount || 0),
            0,
          ),
        );
        const mTarget = Math.round(mAmount);
        const majorDrift = mTarget - generatedSum;

        if (Math.abs(majorDrift) > 0) {
          // A single line can only absorb so much drift before hitting its
          // own rate/quantity ceiling. Spread the remaining drift across
          // every line of every invoice belonging to this major customer
          // until it's closed or every line is exhausted.
          let remainingDrift = majorDrift;
          for (const inv of mCustInvoices) {
            if (Math.abs(remainingDrift) <= 0.5) break;
            if (!inv.products || inv.products.length === 0) continue;
            for (const item of inv.products) {
              if (Math.abs(remainingDrift) <= 0.5) break;
              const targetLineAmt = Math.round(
                (item.amount || 0) + remainingDrift,
              );
              if (targetLineAmt <= 0) continue;
              const previousAmount = item.amount || 0;
              const solved = this.solveLineForTarget(
                item.product_id,
                item.quantity,
                targetLineAmt,
                productConfigById,
              );
              item.quantity = solved.quantity;
              item.rate = solved.rate;
              item.amount = computeLineAmount(item.quantity, item.rate);
              remainingDrift =
                Math.round((remainingDrift - (item.amount - previousAmount)) * 100) /
                100;
            }
            inv.total_amount = Math.round(
              inv.products.reduce(
                (sum: number, item: any) => sum + Math.round(item.amount || 0),
                0,
              ),
            );
          }
        }
      }
    }

    // The correction guard above targets each major customer's configured
    // amount, but bounded by their products' rate/quantity ranges it may
    // leave a small residual over/undershoot. From here on, use what was
    // ACTUALLY generated for major customers (not the configured target) so
    // the normal-invoice budget below compensates for that residual and the
    // grand total still lands exactly on the batch's requested total.
    const majorCustomerIdSet = new Set(
      majorCustomers.map((m) => m.customer_id).filter(Boolean),
    );
    const actualMajorTotal = Math.round(
      invoices
        .filter((inv) => majorCustomerIdSet.has(inv.customer_id))
        .reduce((sum, inv) => sum + Math.round(inv.total_amount || 0), 0),
    );

    // ── STEP 2: Process Remaining Batch Amount (if any) ──────────────────────
    const remainingBatchAmount = Math.max(0, totalAmount - actualMajorTotal);

    if (remainingBatchAmount > 0) {
      // Use uniform random budget partitioning to prevent invoice amount clustering at thresholdMax
      const invoiceBudgets = this.partitionAmountRandomly(
        remainingBatchAmount,
        thresholdMin,
        thresholdMax,
      );

      // Dedicated round-robin counters for each supplier category to distribute invoices across ALL selected suppliers
      let fruitSupplierCounter = 0;
      let meatSupplierCounter = 0;

      for (let i = 0; i < invoiceBudgets.length; i++) {
        const targetBudget = invoiceBudgets[i];
        const catKey = categoryKeys[i % categoryKeys.length];
        const categoryProducts = productsByCategory.get(catKey) || [];
        if (categoryProducts.length === 0) continue;

        const totalPlannedCount = Math.max(
          1,
          invoices.length + (invoiceBudgets.length - i),
        );
        const dateStr = this.getSequentialDateForIndex(
          invoices.length,
          totalPlannedCount,
          dateList,
        );

        const targetSubsetCount = Math.min(
          categoryProducts.length,
          Math.floor(Math.random() * 6) + 3,
        );
        const occurrenceSelection = this.selectProductsByOccurrence(
          categoryProducts,
          targetSubsetCount,
        );
        const firstFit = this.occurrenceWeightedFittingProduct(
          categoryProducts,
          targetBudget,
        );
        const chosenProducts = firstFit
          ? [
              firstFit,
              ...occurrenceSelection.filter(
                (p) => p.product_id !== firstFit.product_id,
              ),
            ]
          : occurrenceSelection;

        let currentInvoiceProducts: any[] = [];
        let currentInvoiceAmount = 0;
        const usedQuantities = new Set<number>();

        for (let j = 0; j < chosenProducts.length; j++) {
          const p = chosenProducts[j];
          const minR = parseFloat(p.perDayRateMin) || 10;
          const maxR = parseFloat(p.perDayRateMax) || 500;
          let rate = roundToWholeInteger(minR + Math.random() * (maxR - minR));

          const minQ = parseFloat(p.perDayQtyMin) || 10;
          const maxQ = Math.max(minQ, parseFloat(p.perDayQtyMax) || 100);

          const remBudget = targetBudget - currentInvoiceAmount;
          if (remBudget <= 0) break;

          // The invoice's first line is exempt from the "don't exceed
          // budget" check below (an invoice can't end up with zero lines) —
          // so its rate must itself be capped to whatever the target budget
          // can actually afford at the minimum commercial quantity, instead
          // of using an uncapped random rate that can blow straight past a
          // tight budget (and from there, past thresholdMax) before any
          // line has even been added.
          if (currentInvoiceProducts.length === 0) {
            const maxAffordableRate = remBudget / minQ;
            if (rate > maxAffordableRate) {
              // A cap must always round DOWN — rounding to the nearest
              // whole number (e.g. 999.9 -> 1000) can land back above the
              // budget it was supposed to enforce.
              rate = Math.max(minR, Math.floor(maxAffordableRate));
            }
          }

          const maxQtyFitting = remBudget / (rate || 1);
          if (maxQtyFitting < minQ && currentInvoiceProducts.length > 0) {
            continue;
          }

          const upperLimit = Math.min(maxQ, Math.max(minQ, maxQtyFitting));

          let qtyToPut = generateCommercialQuantity(minQ, upperLimit, {
            productName: p.product_name,
            existingQuantities: usedQuantities,
          });

          if (qtyToPut <= 0) qtyToPut = minQ;

          let amt = computeLineAmount(qtyToPut, rate);

          if (
            currentInvoiceAmount + amt > targetBudget &&
            currentInvoiceProducts.length > 0
          ) {
            continue;
          }

          usedQuantities.add(qtyToPut);
          currentInvoiceProducts.push({
            product_id: p.product_id,
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            unit_of_measure: p.unit_of_measure,
            category: catKey,
            quantity: qtyToPut,
            rate,
            amount: amt,
          });
          currentInvoiceAmount =
            Math.round((currentInvoiceAmount + amt) * 100) / 100;
        }

        if (currentInvoiceProducts.length === 0) {
          const p =
            this.cheapestFittingProduct(categoryProducts, targetBudget) ||
            categoryProducts[0];
          const minQ = parseFloat(p.perDayQtyMin) || 10;
          const solved = this.solveLineForTarget(
            p.product_id,
            minQ,
            targetBudget,
            productConfigById,
            { preferFloor: true },
          );
          const amt = computeLineAmount(solved.quantity, solved.rate);
          currentInvoiceProducts.push({
            product_id: p.product_id,
            product_name: p.product_name,
            hsn_code: p.hsn_code,
            unit_of_measure: p.unit_of_measure,
            category: catKey,
            quantity: solved.quantity,
            rate: solved.rate,
            amount: amt,
          });
          currentInvoiceAmount = amt;
        }

        let lineDrift =
          Math.round((targetBudget - currentInvoiceAmount) * 100) / 100;

        if (Math.abs(lineDrift) > 0.001 && currentInvoiceProducts.length > 0) {
          for (const item of currentInvoiceProducts) {
            if (Math.abs(lineDrift) <= 0.01) break;
            const targetLineAmt =
              Math.round((item.amount + lineDrift) * 100) / 100;
            if (targetLineAmt > 0) {
              const solved = this.solveLineForTarget(
                item.product_id,
                item.quantity,
                targetLineAmt,
                productConfigById,
                { preferFloor: true },
              );
              item.quantity = solved.quantity;
              item.rate = solved.rate;
              item.amount = computeLineAmount(item.quantity, item.rate);
              lineDrift =
                Math.round(
                  (targetBudget -
                    currentInvoiceProducts.reduce(
                      (s: number, p: any) => s + p.amount,
                      0,
                    )) *
                    100,
                ) / 100;
            }
          }
        }

        const currentSum = Math.round(
          currentInvoiceProducts.reduce(
            (sum, p) => sum + Math.round(p.amount || 0),
            0,
          ),
        );
        const invDrift = Math.round(targetBudget) - currentSum;
        if (Math.abs(invDrift) > 0 && currentInvoiceProducts.length > 0) {
          const lastItem =
            currentInvoiceProducts[currentInvoiceProducts.length - 1];
          const targetAmt = Math.round(lastItem.amount + invDrift);
          const solved = this.solveLineForTarget(
            lastItem.product_id,
            lastItem.quantity,
            targetAmt,
            productConfigById,
            { preferFloor: true },
          );
          lastItem.quantity = solved.quantity;
          lastItem.rate = solved.rate;
          lastItem.amount = computeLineAmount(lastItem.quantity, lastItem.rate);
        }

        const finalInvoiceTotal = Math.round(
          currentInvoiceProducts.reduce(
            (sum, p) => sum + Math.round(p.amount || 0),
            0,
          ),
        );

        let supplierId: string | null = null;
        if (catKey === "Fruits") {
          if (fruitSuppliers.length > 0) {
            supplierId =
              fruitSuppliers[fruitSupplierCounter % fruitSuppliers.length];
            fruitSupplierCounter++;
          } else {
            continue;
          }
        } else if (catKey === "Meat") {
          if (meatSuppliers.length > 0) {
            supplierId =
              meatSuppliers[meatSupplierCounter % meatSuppliers.length];
            meatSupplierCounter++;
          } else {
            continue;
          }
        } else {
          supplierId = batch.receiving_company_id || batch.supplier_id || null;
        }

        if (!supplierId && selectedCustomers.length > 0) {
          const matchSup = selectedCustomers.find(
            (id) => (supplierCategoryMap?.get(id) || "Meat") === catKey,
          );
          supplierId = matchSup || selectedCustomers[0];
        }

        const abbr = (batch as any).issuing_company_abbreviation || "IC";
        const fy = (batch.financial_year || "2026-27").replace(/^FY/i, "");
        const beforeCounter = invoiceCounter;
        const draftInvNumber = InvoiceNumberingService.formatInvoiceNumber(
          abbr,
          fy,
          batch.batch_type === "PURCHASE" ? "P" : "S",
          invoiceCounter++,
        );
        console.log("[COUNTER TRACE - Regular Purchase Invoice]", {
          beforeCounter,
          generatedInvoiceNumber: draftInvNumber,
          afterCounter: invoiceCounter,
        });

        const productsWithSupplierId = currentInvoiceProducts.map((p: any) => ({
          ...p,
          customer_id: supplierId,
          supplier_id: supplierId,
        }));

        invoices.push({
          invoice_number: draftInvNumber,
          invoice_date: dateStr,
          customer_id: supplierId,
          supplier_id: supplierId,
          category_key: catKey,
          products: productsWithSupplierId,
          total_amount: finalInvoiceTotal,
          status: "generated",
          batch_type: "PURCHASE",
        });
      }
    }

    // ── STEP 3: Global Drift Redistribution & Normal Purchase Invoice Limit Enforcement ──
    const normalInvoices = invoices.filter(
      (inv) => !majorCustomerIdSet.has(inv.customer_id),
    );
    const majorInvoices = invoices.filter((inv) =>
      majorCustomerIdSet.has(inv.customer_id),
    );

    const normalSum = Math.round(
      normalInvoices.reduce(
        (sum, inv) => sum + Math.round(inv.total_amount || 0),
        0,
      ),
    );
    const targetNormalTotal = Math.round(totalAmount - actualMajorTotal);
    let globalDrift = targetNormalTotal - normalSum;

    if (globalDrift > 0 && normalInvoices.length > 0) {
      // Redistribute drift onto normal invoices that have headroom below thresholdMax
      for (let i = normalInvoices.length - 1; i >= 0; i--) {
        if (globalDrift <= 0) break;
        const inv = normalInvoices[i];
        const currentAmt = Math.round(inv.total_amount || 0);
        const headroom = Math.max(0, thresholdMax - currentAmt);
        if (headroom > 0 && inv.products.length > 0) {
          const addAmt = Math.min(globalDrift, headroom);
          const lastItem = inv.products[inv.products.length - 1];
          const previousAmount = lastItem.amount;
          const targetAmt = Math.round(lastItem.amount + addAmt);
          const solved = this.solveLineForTarget(
            lastItem.product_id,
            lastItem.quantity,
            targetAmt,
            productConfigById,
            { preferFloor: true },
          );
          lastItem.quantity = solved.quantity;
          lastItem.rate = solved.rate;
          lastItem.amount = computeLineAmount(
            lastItem.quantity,
            lastItem.rate,
          );
          inv.total_amount = Math.round(
            inv.products.reduce(
              (s: number, p: any) => s + Math.round(p.amount || 0),
              0,
            ),
          );
          globalDrift -= lastItem.amount - previousAmount;
        }
      }

      // If globalDrift > 0 still remains after filling all existing normal invoices up to thresholdMax,
      // create additional normal purchase invoice(s) as per Rule 4 & 5
      while (globalDrift > 0) {
        const newBudget = Math.min(globalDrift, thresholdMax);
        const catKey = categoryKeys[invoices.length % categoryKeys.length];
        const categoryProducts = productsByCategory.get(catKey) || [];
        if (categoryProducts.length === 0) break;

        const dateStr = this.getSequentialDateForIndex(
          invoices.length,
          invoices.length + 1,
          dateList,
        );

        const p =
          this.cheapestFittingProduct(categoryProducts, newBudget) ||
          categoryProducts[0];
        const prodCat = this.getProductCategory(p);
        const minQ = parseFloat(p.perDayQtyMin) || 10;
        const solvedNew = this.solveLineForTarget(
          p.product_id,
          minQ,
          newBudget,
          productConfigById,
          { preferFloor: true },
        );
        const newQty = solvedNew.quantity;
        const rate = solvedNew.rate;
        const amt = computeLineAmount(newQty, rate);

        let supplierId: string | null = null;
        if (prodCat === "Fruits") {
          if (fruitSuppliers.length > 0) {
            supplierId =
              fruitSuppliers[invoices.length % fruitSuppliers.length];
          } else {
            break;
          }
        } else if (prodCat === "Meat") {
          if (meatSuppliers.length > 0) {
            supplierId = meatSuppliers[invoices.length % meatSuppliers.length];
          } else {
            break;
          }
        } else {
          supplierId = batch.receiving_company_id || batch.supplier_id || null;
        }

        if (!supplierId) break;

        const abbr = (batch as any).issuing_company_abbreviation || "IC";
        const fy = (batch.financial_year || "2026-27").replace(/^FY/i, "");
        const draftInvNumber = InvoiceNumberingService.formatInvoiceNumber(
          abbr,
          fy,
          batch.batch_type === "PURCHASE" ? "P" : "S",
          invoiceCounter++,
        );

        const newInv = {
          invoice_number: draftInvNumber,
          invoice_date: dateStr,
          customer_id: supplierId,
          supplier_id: supplierId,
          category_key: catKey,
          products: [
            {
              product_id: p.product_id,
              product_name: p.product_name,
              hsn_code: p.hsn_code,
              unit_of_measure: p.unit_of_measure,
              category: catKey,
              quantity: newQty,
              rate,
              amount: amt,
              customer_id: supplierId,
              supplier_id: supplierId,
            },
          ],
          total_amount: amt,
          status: "generated",
          batch_type: "PURCHASE",
        };

        invoices.push(newInv);
        normalInvoices.push(newInv);
        globalDrift -= amt;
        if (amt <= 0.5) break;
      }
    } else if (globalDrift < 0 && normalInvoices.length > 0) {
      // Reduce drift from normal invoices that are above thresholdMin.
      // Spread the reduction across every line of the invoice (not just the
      // last one) so a single line's own rate/quantity floor can't leave
      // residual overshoot unresolved.
      for (let i = normalInvoices.length - 1; i >= 0; i--) {
        if (globalDrift >= 0) break;
        const inv = normalInvoices[i];
        if (!inv.products || inv.products.length === 0) continue;
        for (const item of inv.products) {
          if (globalDrift >= 0) break;
          const currentAmt = Math.round(inv.total_amount || 0);
          const surplus = Math.max(0, currentAmt - thresholdMin);
          if (surplus <= 0) break;
          const subAmt = Math.min(-globalDrift, surplus);
          const targetLineAmt = Math.round((item.amount || 0) - subAmt);
          if (targetLineAmt <= 0) continue;
          const previousAmount = item.amount || 0;
          const solved = this.solveLineForTarget(
            item.product_id,
            item.quantity,
            targetLineAmt,
            productConfigById,
          );
          item.quantity = solved.quantity;
          item.rate = solved.rate;
          item.amount = computeLineAmount(item.quantity, item.rate);
          inv.total_amount = Math.round(
            inv.products.reduce(
              (s: number, p: any) => s + Math.round(p.amount || 0),
              0,
            ),
          );
          globalDrift += previousAmount - item.amount;
        }
      }
    }

    if (normalInvoices.length === 0 && majorInvoices.length > 0) {
      const majorSum = Math.round(
        majorInvoices.reduce(
          (sum, inv) => sum + Math.round(inv.total_amount || 0),
          0,
        ),
      );
      const majorDrift = Math.round(totalMajorAmount) - majorSum;
      if (Math.abs(majorDrift) > 0) {
        const lastInv = majorInvoices[majorInvoices.length - 1];
        if (lastInv && lastInv.products.length > 0) {
          const lastItem = lastInv.products[lastInv.products.length - 1];
          const targetAmt = Math.round(lastItem.amount + majorDrift);
          const solved = this.solveLineForTarget(
            lastItem.product_id,
            lastItem.quantity,
            targetAmt,
            productConfigById,
          );
          lastItem.quantity = solved.quantity;
          lastItem.rate = solved.rate;
          lastItem.amount = computeLineAmount(
            lastItem.quantity,
            lastItem.rate,
          );
          lastInv.total_amount = Math.round(
            lastInv.products.reduce(
              (s: number, p: any) => s + Math.round(p.amount || 0),
              0,
            ),
          );
        }
      }
    }

    // ── STEP 3.5: Rate Bounds Guard ────────────────────────────────────────────
    // Defense in depth: every drift/exact-balance-correction pass above now
    // clamps recomputed rates to the product's configured range, but this
    // catches anything that slips through (e.g. a product whose range is too
    // narrow to hit a target amount at all) with a clear error instead of
    // silently persisting an out-of-range rate.
    for (const inv of invoices) {
      for (const item of inv.products || []) {
        const config = productConfigById.get(item.product_id);
        if (!config) continue;
        const minR = parseFloat(config.perDayRateMin as any);
        const maxR = parseFloat(config.perDayRateMax as any);
        if (!Number.isFinite(minR) || !Number.isFinite(maxR) || minR > maxR) {
          continue;
        }
        if (item.rate < minR || item.rate > maxR) {
          throw new Error(
            `Generated rate (₹${item.rate}) for ${item.product_name || item.product_id} on invoice ${inv.invoice_number} is outside the configured range [₹${minR}, ₹${maxR}].`,
          );
        }
      }
    }

    // ── STEP 4: Strict Pre-Persistence Validation Guard ───────────────────────
    for (const inv of normalInvoices) {
      const amt = Math.round(inv.total_amount || 0);
      if (amt > thresholdMax) {
        throw new Error(
          `Invoice Amount (₹${amt}) exceeds configured maximum (₹${thresholdMax}). Invoice Amount exceeds configured maximum.`,
        );
      }
      if (
        amt < thresholdMin &&
        normalInvoices.length === 1 &&
        remainingBatchAmount >= thresholdMin
      ) {
        throw new Error(
          `Invoice Amount (₹${amt}) below configured minimum (₹${thresholdMin}). Invoice Amount below configured minimum.`,
        );
      }
    }

    // ── STEP 5: Strict Pre-Persistence Validation Guard for Major Customers ────
    for (const m of majorCustomers) {
      if (!m.customer_id) continue;
      const mAmount =
        typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0;
      const mInvCount =
        typeof m.invoice_count === "string"
          ? parseInt(m.invoice_count, 10)
          : m.invoice_count || 1;
      const mMaxLimit = m.max_invoice_amount
        ? typeof m.max_invoice_amount === "string"
          ? parseFloat(m.max_invoice_amount)
          : m.max_invoice_amount
        : mAmount;

      if (mAmount <= 0) continue;

      const custInvoices = invoices.filter(
        (inv) => inv.customer_id === m.customer_id,
      );

      if (custInvoices.length !== mInvCount) {
        throw new Error(
          `Major Customer invoice count mismatch: expected ${mInvCount} invoices for customer ${m.customer_id}, got ${custInvoices.length}. Major Customer invoice count mismatch.`,
        );
      }

      for (const inv of custInvoices) {
        const amt = Math.round(inv.total_amount || 0);
        if (amt > mMaxLimit) {
          throw new Error(
            `Major Customer invoice exceeds configured maximum: invoice total ₹${amt} exceeds max limit ₹${mMaxLimit}. Major Customer invoice exceeds configured maximum.`,
          );
        }
      }

      const custSum = Math.round(
        custInvoices.reduce((s, i) => s + Math.round(i.total_amount || 0), 0),
      );
      if (custSum !== Math.round(mAmount)) {
        throw new Error(
          `Major Customer balancing failed: expected ₹${Math.round(mAmount)}, got ₹${custSum}. Major Customer balancing failed.`,
        );
      }
    }

    const totalGenerated = Math.round(
      invoices.reduce((sum, inv) => sum + Math.round(inv.total_amount || 0), 0),
    );
    if (totalGenerated !== Math.round(totalAmount)) {
      throw new Error(
        `Purchase Batch Total mismatch: expected ₹${Math.round(totalAmount)}, got ₹${totalGenerated}. Unable to satisfy configured invoice limits.`,
      );
    }

    // ── STEP 6: Strict Pre-Persistence Validation Guard for Supplier Category Allocation ──
    for (const inv of invoices) {
      const invCat = inv.category_key || "Meat";
      const supplierId = inv.supplier_id || inv.customer_id;
      const supplierCat = supplierCategoryMap?.get(supplierId) || invCat;

      if (supplierCat !== invCat) {
        throw new Error(
          `Supplier Category Allocation Guard Violation: Invoice ${inv.invoice_number} is category '${invCat}', but assigned supplier ${supplierId} has category '${supplierCat}'. Supplier Category Mismatch.`,
        );
      }

      for (const p of inv.products || []) {
        const prodCat = this.getProductCategory(p);
        if (prodCat !== invCat) {
          throw new Error(
            `Supplier Category Allocation Guard Violation: Invoice ${inv.invoice_number} (Category: '${invCat}', Supplier Category: '${supplierCat}') contains product '${p.product_name}' belonging to category '${prodCat}'. Mixed Product Categories strictly forbidden.`,
          );
        }
        if (prodCat !== supplierCat) {
          throw new Error(
            `Supplier Category Allocation Guard Violation: Product '${p.product_name}' (Category: '${prodCat}') assigned to supplier ${supplierId} (Category: '${supplierCat}'). Category Mismatch.`,
          );
        }
      }
    }

    // ── Chronological & Ascending Invoice Number Sort ──
    invoices.sort((a, b) => {
      const dateCmp = (a.invoice_date || "").localeCompare(
        b.invoice_date || "",
      );
      if (dateCmp !== 0) return dateCmp;
      return (a.invoice_number || "").localeCompare(
        b.invoice_number || "",
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      );
    });

    return invoices;
  }

  private static distributeSalesAmountToProducts(
    productConfigs: any[],
    targetAmount: number,
  ) {
    const products: Array<{
      product_id: string;
      product_name: string;
      hsn_code: string;
      unit_of_measure: string;
      quantity: number;
      rate: number;
      amount: number;
    }> = [];

    if (!productConfigs || productConfigs.length === 0) {
      return products;
    }

    const availableConfigs = productConfigs.filter(
      (p) => (p.currentAvailable || 0) > 0,
    );

    if (availableConfigs.length === 0) {
      return products;
    }

    const productData = availableConfigs.map((config) => {
      const minQty = parseFloat(config.perDayQtyMin) || 0;
      const maxQty = Math.min(
        parseFloat(config.perDayQtyMax) || 0,
        config.currentAvailable,
      );
      const minRate = parseFloat(config.perDayRateMin) || 0;
      const maxRate = parseFloat(config.perDayRateMax) || 0;

      const adjustedMinQty = Math.max(0, Math.min(minQty, maxQty));

      return {
        config,
        minQty: adjustedMinQty,
        maxQty,
        minRate,
        maxRate,
        avgAmount: ((adjustedMinQty + maxQty) / 2) * ((minRate + maxRate) / 2),
      };
    });

    const totalAvg = productData.reduce((sum, p) => sum + p.avgAmount, 0);
    const allocations = productData.map((p) => {
      if (totalAvg <= 0) return targetAmount / productData.length;
      return (targetAmount * p.avgAmount) / totalAvg;
    });

    productData.forEach((item, index) => {
      const targetProdAmount = allocations[index];
      const { minQty, maxQty, minRate, maxRate } = item;

      let qty = generateCommercialQuantity(
        minQty,
        Math.min(maxQty, item.config.currentAvailable),
      );
      qty = Math.max(
        0,
        Math.min(roundToQuarterIncrement(item.config.currentAvailable), qty),
      );

      if (qty > 0) {
        let rate = targetProdAmount / qty;
        rate = Math.max(minRate, Math.min(maxRate, rate));
        rate = Math.round(rate * 100) / 100;

        const amount = Math.round(qty * rate * 100) / 100;

        products.push({
          product_id: item.config.product_id,
          product_name: item.config.product_name,
          hsn_code: item.config.hsn_code,
          unit_of_measure: item.config.unit_of_measure,
          quantity: qty,
          rate,
          amount,
        });
      }
    });

    const totalGenerated = products.reduce((sum, p) => sum + p.amount, 0);
    let drift = Math.round((targetAmount - totalGenerated) * 100) / 100;

    if (Math.abs(drift) > 0.01 && products.length > 0) {
      const indices = Array.from(
        { length: products.length },
        (_, idx) => idx,
      ).sort(() => Math.random() - 0.5);

      for (const idx of indices) {
        if (Math.abs(drift) <= 0.01) break;

        const p = products[idx];
        const config = productData[idx];
        const { maxQty, minRate, maxRate } = config;
        const maxStock = Math.floor(config.config.currentAvailable);

        if (drift > 0) {
          const maxPossibleQty = Math.min(maxQty, maxStock);
          const maxPossibleAmt =
            Math.round(maxPossibleQty * maxRate * 100) / 100;
          const room = Math.max(
            0,
            Math.round((maxPossibleAmt - p.amount) * 100) / 100,
          );

          if (room > 0.01) {
            const toAdd = Math.round(Math.min(drift, room) * 100) / 100;
            const newAmount = Math.round((p.amount + toAdd) * 100) / 100;
            let adjusted = false;
            for (let q = maxPossibleQty; q >= p.quantity; q--) {
              const r = Math.round((newAmount / q) * 100) / 100;
              if (
                r >= minRate &&
                r <= maxRate &&
                Math.abs(q * r - newAmount) < 0.01
              ) {
                p.quantity = q;
                p.rate = r;
                p.amount = newAmount;
                drift = Math.round((drift - toAdd) * 100) / 100;
                adjusted = true;
                break;
              }
            }
            if (!adjusted) {
              const newRate = Math.min(
                maxRate,
                Math.round((newAmount / p.quantity) * 100) / 100,
              );
              p.rate = newRate;
              p.amount = Math.round(p.quantity * newRate * 100) / 100;
              drift =
                Math.round(
                  (targetAmount -
                    products.reduce((sum, pr) => sum + pr.amount, 0)) *
                    100,
                ) / 100;
            }
          }
        } else {
          const minPossibleAmt =
            Math.round(config.minQty * minRate * 100) / 100;
          const room = Math.max(
            0,
            Math.round((p.amount - minPossibleAmt) * 100) / 100,
          );

          if (room > 0.01) {
            const toSub =
              Math.round(Math.min(Math.abs(drift), room) * 100) / 100;
            const newAmount = Math.round((p.amount - toSub) * 100) / 100;
            let adjusted = false;
            for (
              let q = Math.max(1, Math.floor(config.minQty));
              q <= p.quantity;
              q++
            ) {
              const r = Math.round((newAmount / q) * 100) / 100;
              if (
                r >= minRate &&
                r <= maxRate &&
                Math.abs(q * r - newAmount) < 0.01
              ) {
                p.quantity = q;
                p.rate = r;
                p.amount = newAmount;
                drift = Math.round((drift + toSub) * 100) / 100;
                adjusted = true;
                break;
              }
            }
            if (!adjusted && p.quantity > 0) {
              const newRate = Math.max(
                minRate,
                Math.round((newAmount / p.quantity) * 100) / 100,
              );
              p.rate = newRate;
              p.amount = Math.round(p.quantity * newRate * 100) / 100;
              drift =
                Math.round(
                  (targetAmount -
                    products.reduce((sum, pr) => sum + pr.amount, 0)) *
                    100,
                ) / 100;
            }
          }
        }
      }
    }

    return products;
  }
}
