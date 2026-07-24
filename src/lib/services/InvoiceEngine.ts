import { SupabaseClient } from "@supabase/supabase-js";
import { MAX_INVOICES_PER_BATCH } from "@/lib/constants/invoice";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";
import { AutoBalanceEngine } from "./AutoBalanceEngine";
import { InvoiceNumberingService } from "./InvoiceNumberingService";
import {
  roundToQuarterIncrement,
  isValidQuarterIncrement,
  roundToWholeInteger,
  isValidWholeNumber,
  computeLineAmount,
  generateCommercialQuantity,
} from "@/lib/utils/quantity-rate-utils";

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

    return data;
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
    // 1. Check if batch is finalized
    const { data: batchCheck } = await supabase
      .from("invoice_batch")
      .select("batch_status")
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

    // 2. Fetch original invoice to get its original total before saving
    const { data: originalInvoice } = await supabase
      .from("invoice")
      .select("total_amount, invoice_number")
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

    // 3. Save and Rebalance atomically if total changed, otherwise perform a single update
    if (originalTotal !== newTotal) {
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

    // Load all ledger rows before currentBatchFromDate
    const { data: ledgerRows } = await supabase
      .from("daily_stock_ledger")
      .select("product_id, purchased_quantity, sold_quantity, ledger_date")
      .lt("ledger_date", currentBatchFromDate);

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

    const typedBatch = batch as unknown as InvoiceBatch;

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

    // Get highest invoice counter
    const { data: allInvoices } = await supabase
      .from("invoice")
      .select("invoice_number")
      .order("invoice_number", { ascending: false })
      .limit(1);

    let startingCounter = 1;

    if (allInvoices && allInvoices.length > 0) {
      const counters = allInvoices
        .map((inv) => {
          const match = inv.invoice_number.match(/-(\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        })
        .filter((num) => !isNaN(num));

      if (counters.length > 0) {
        startingCounter = Math.max(...counters) + 1;
      }
    }

    let invoices: any[] = [];
    if (typedBatch.batch_type === "PURCHASE") {
      invoices = this.generatePurchaseInvoiceSplitupsInternal(
        typedBatch,
        numberOfDays,
        fromDate,
        startingCounter,
      );
    } else {
      let availableStockMap: Map<string, any> | null = null;
      if (typedBatch.stock_source_batch_id) {
        const batchIds = typedBatch.stock_source_batch_id
          .split(",")
          .map((id: string) => id.trim())
          .filter(
            (id: string) => Boolean(id) && !id.startsWith("CARRY_FORWARD_"),
          );

        const { data: ledgerData, error: ledgerError } = await supabase
          .from("daily_stock_ledger")
          .select(
            "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          .in(
            "purchase_batch_id",
            batchIds.length > 0 ? batchIds : [typedBatch.stock_source_batch_id],
          )
          .order("ledger_date", { ascending: true });

        if (ledgerError) {
          throw new Error(
            `Failed to load daily stock ledger: ${ledgerError.message}`,
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

      invoices = this.generateInvoiceSplitupsInternal(
        typedBatch,
        numberOfDays,
        fromDate,
        startingCounter,
        availableStockMap,
      );
    }

    // Validate all generated invoices before saving
    for (const inv of invoices) {
      const validation = this.validateInvoiceData(inv);
      if (!validation.isValid) {
        throw new Error(`Generation validation failed: ${validation.message}`);
      }
    }

    // Save quantities for PURCHASE batches (Budget-Driven inventory generation)
    if (typedBatch.batch_type === "PURCHASE") {
      const productTotalQty = new Map<string, number>();
      for (const inv of invoices) {
        for (const p of inv.products) {
          productTotalQty.set(
            p.product_id,
            (productTotalQty.get(p.product_id) || 0) + p.quantity,
          );
        }
      }

      const purchaseProductsToUpsert = Array.from(
        productTotalQty.entries(),
      ).map(([prodId, qty]) => ({
        batch_id: batchId,
        product_id: prodId,
        monthly_quantity: qty,
      }));

      // Delete existing and insert new generated quantities
      await supabase
        .from("purchase_batch_products")
        .delete()
        .eq("batch_id", batchId);

      const { error: insertQtyError } = await supabase
        .from("purchase_batch_products")
        .insert(purchaseProductsToUpsert);

      if (insertQtyError) {
        throw new Error(
          `Failed to save purchase batch product inventory: ${insertQtyError.message}`,
        );
      }
    }

    // Commit invoices and update sequence atomically inside ONE single database transaction
    let savedInvoices: any[] = [];
    const invType: "P" | "S" = typedBatch.batch_type === "PURCHASE" ? "P" : "S";

    try {
      const committedSeqs =
        await InvoiceNumberingService.commitInvoiceBatchWithSequences(
          supabase,
          batchId,
          typedBatch.issuing_company_id,
          typedBatch.financial_year || "2026-27",
          invType,
          invoices,
        );

      // Re-fetch created invoices for stock ledger tracking without 1000-row PostgREST truncation
      savedInvoices = await fetchAllInvoicesForBatch(supabase, batchId);
    } catch (rpcErr: any) {
      console.warn(
        "RPC commitInvoiceBatchWithSequences fallback to client insert:",
        rpcErr,
      );

      // Fallback: Generate sequential numbers and insert
      const seqNumbers =
        await InvoiceNumberingService.generateSequentialInvoiceNumbers(
          supabase,
          typedBatch.issuing_company_id,
          typedBatch.financial_year || "2026-27",
          invType,
          invoices.length,
        );

      for (let i = 0; i < invoices.length; i++) {
        invoices[i].invoice_number = seqNumbers[i].invoice_number;
      }

      const { data: selectInvoices, error: insertError } = await supabase
        .from("invoice")
        .insert(invoices)
        .select();

      if (insertError) {
        throw new Error(`Failed to save invoices: ${insertError.message}`);
      }
      savedInvoices = selectInvoices || [];
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

    return invoices.length;
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
    const cat = String(p?.category || p?.category_name || "Meat").toUpperCase();
    return cat.includes("FRUIT") ? "Fruits" : "Meat";
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

    // ── Sequential per-product stock tracker ───────────────────────────────
    // runningRemaining[productId] = remaining stock carried into the NEXT day
    const runningRemaining = new Map<string, number>();

    // Seed with the opening stock from the ledger for each product on the first date
    for (const prodConfig of batch.products) {
      runningRemaining.set(prodConfig.product_id, 0);
    }

    // Compute proportional category totals across batch products
    const categoryTotals = new Map<string, number>();
    for (const p of batch.products) {
      const cat = (p as any).category_name || (p as any).category || "Meat";
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

        let qtyToSell = 0;
        let actualRemaining = 0;

        if (available < 10) {
          // If total available stock is less than 10 KG, consume the entire remaining stock at once
          // to prevent generating micro splits like 0.25 KG, 0.36 KG, 0.44 KG
          qtyToSell = available;
          actualRemaining = 0;
        } else {
          // Available >= 10 KG: target remaining <= 15 KG while ensuring qtyToSell >= 10 KG
          const maxTargetRemaining = Math.min(15, available - 10);
          const targetRemaining =
            Math.round(Math.random() * maxTargetRemaining * 4) / 4;

          qtyToSell = Math.max(
            10,
            Math.round((available - targetRemaining) * 4) / 4,
          );

          actualRemaining = Math.round((available - qtyToSell) * 100) / 100;
          if (actualRemaining > 15) {
            qtyToSell =
              Math.round((qtyToSell + (actualRemaining - 15)) * 4) / 4;
            actualRemaining = 15;
          } else if (actualRemaining < 0) {
            qtyToSell = available;
            actualRemaining = 0;
          }
        }

        runningRemaining.set(prodConfig.product_id, actualRemaining);

        if (qtyToSell <= 0) continue;

        qtyToSell = roundToQuarterIncrement(qtyToSell);
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
          const usedQuantities = new Set<number>();

          for (const p of chosenProducts) {
            const minRate = parseFloat(p.perDayRateMin) || 10;
            const maxRate = parseFloat(p.perDayRateMax) || 500;
            const rate = roundToWholeInteger(
              minRate + Math.random() * (maxRate - minRate),
            );
            p.rate = rate;

            const prodMinQty = Math.max(10, parseFloat(p.perDayQtyMin) || 10);
            const prodMaxQty = Math.max(
              prodMinQty,
              parseFloat(p.perDayQtyMax) || 100,
            );

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

            const qtyToPut = generateCommercialQuantity(
              prodMinQty,
              upperLimit,
              {
                productName: p.product_name,
                existingQuantities: usedQuantities,
              },
            );

            if (qtyToPut <= 0) {
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

            usedQuantities.add(qtyToPut);
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

      // Merge last invoice into previous SAME-CATEGORY invoice ONLY if it's below thresholdMin
      if (dayInvoices.length > 1) {
        const lastInv = dayInvoices[dayInvoices.length - 1];
        if (lastInv.total_amount < thresholdMin) {
          const sameCatPrevInv = dayInvoices
            .slice(0, dayInvoices.length - 1)
            .reverse()
            .find((inv) => inv.category_key === lastInv.category_key);

          if (
            sameCatPrevInv &&
            sameCatPrevInv.total_amount + lastInv.total_amount <= thresholdMax
          ) {
            sameCatPrevInv.products.push(...lastInv.products);
            sameCatPrevInv.total_amount =
              Math.round(
                (sameCatPrevInv.total_amount + lastInv.total_amount) * 100,
              ) / 100;
            dayInvoices.pop();
          }
        }
      }

      const usedPartiesOnDay = new Set<string>();

      for (const inv of dayInvoices) {
        let assignedCustomerId = null;
        const invCategory = inv.category_key || "Meat";

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
            const currentCat = customerBatchCategoryMap.get(cId);
            if (currentCat === invCategory) return true;
            if (!currentCat && assignedCountForCat < catQuota) return true;
            return false;
          });

          const fallbackAnySameCategory = activeSelectedCustomers.filter(
            (cId) =>
              !customerBatchCategoryMap.has(cId) ||
              customerBatchCategoryMap.get(cId) === invCategory,
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
          } else {
            // Fallback if capacity exceeded on this single date
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
          startingCounter + invoiceCounter - 1,
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

        invoiceCounter++;
      }
    }

    // ── Exact Batch Total Balancing Routine (Issue 6) ──
    // Guarantees sum(invoice.total_amount) === batch.total_amount to exact ₹0 (whole integer rupees)
    const targetTotal = Math.round(batch.total_amount);
    let currentTotal = Math.round(
      invoices.reduce((sum, inv) => sum + Math.round(inv.total_amount || 0), 0),
    );
    let batchDiff = targetTotal - currentTotal;

    if (Math.abs(batchDiff) > 0 && invoices.length > 0) {
      const lastInv = invoices[invoices.length - 1];
      if (lastInv && lastInv.products && lastInv.products.length > 0) {
        const lastItem = lastInv.products[lastInv.products.length - 1];
        const targetLineAmt = Math.round(lastItem.amount + batchDiff);
        if (targetLineAmt > 0) {
          lastItem.amount = targetLineAmt;
          lastItem.rate = roundToWholeInteger(
            lastItem.amount / (lastItem.quantity || 1),
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

  private static generatePurchaseInvoiceSplitupsInternal(
    batch: InvoiceBatch,
    numberOfDays: number,
    startDate: Date,
    startingCounter: number,
    monthlyQuantities?: Map<string, number>,
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

    // 1. Group products strictly by category using getProductCategory(p)
    const productsByCategory = new Map<string, ProductConfig[]>();
    for (const p of batch.products) {
      const catKey = this.getProductCategory(p);
      if (!productsByCategory.has(catKey)) {
        productsByCategory.set(catKey, []);
      }
      productsByCategory.get(catKey)!.push(p);
    }

    const categoryKeys = Array.from(productsByCategory.keys());
    if (categoryKeys.length === 0) return [];

    // 2. Determine exact target invoice count N to partition totalAmount EXACTLY
    const avgThreshold = (thresholdMin + thresholdMax) / 2;
    let targetInvoiceCount = Math.round(totalAmount / avgThreshold);
    const minInvoices = Math.ceil(totalAmount / thresholdMax);
    const maxInvoices = Math.floor(totalAmount / thresholdMin);
    targetInvoiceCount = Math.max(
      minInvoices,
      Math.min(maxInvoices, targetInvoiceCount),
    );
    if (targetInvoiceCount < 1) targetInvoiceCount = 1;

    // Partition totalAmount into EXACT targetInvoiceCount invoice budgets that sum to totalAmount
    const invoiceBudgets: number[] = [];
    let unallocated = totalAmount;

    for (let i = 0; i < targetInvoiceCount; i++) {
      invoiceBudgets.push(thresholdMin);
      unallocated -= thresholdMin;
    }

    const roomPerInvoice = thresholdMax - thresholdMin;
    for (let i = 0; i < targetInvoiceCount - 1; i++) {
      const minAdd = Math.max(
        0,
        unallocated - (targetInvoiceCount - 1 - i) * roomPerInvoice,
      );
      const maxAdd = Math.min(unallocated, roomPerInvoice);
      const add = minAdd + Math.random() * (maxAdd - minAdd);
      const roundedAdd = Math.round(add * 100) / 100;
      invoiceBudgets[i] =
        Math.round((invoiceBudgets[i] + roundedAdd) * 100) / 100;
      unallocated = Math.round((unallocated - roundedAdd) * 100) / 100;
    }
    invoiceBudgets[targetInvoiceCount - 1] =
      Math.round((invoiceBudgets[targetInvoiceCount - 1] + unallocated) * 100) /
      100;

    // Prepare date list
    const dateList: string[] = [];
    for (let d = 0; d < numberOfDays; d++) {
      const curDate = new Date(startDate);
      curDate.setDate(startDate.getDate() + d);
      dateList.push(formatDateForStorage(curDate));
    }

    // 3. Build each invoice to match its target budget exactly
    for (let i = 0; i < invoiceBudgets.length; i++) {
      const targetBudget = invoiceBudgets[i];
      const catKey = categoryKeys[i % categoryKeys.length];
      const categoryProducts = productsByCategory.get(catKey) || [];
      if (categoryProducts.length === 0) continue;

      const dateStr = dateList[i % dateList.length];

      // Select 3 to 8 products from this category
      const targetSubsetCount = Math.min(
        categoryProducts.length,
        Math.floor(Math.random() * 6) + 3,
      );
      const shuffled = [...categoryProducts].sort(() => Math.random() - 0.5);
      const chosenProducts = shuffled.slice(0, targetSubsetCount);

      let currentInvoiceProducts: any[] = [];
      let currentInvoiceAmount = 0;
      const usedQuantities = new Set<number>();

      for (let j = 0; j < chosenProducts.length; j++) {
        const p = chosenProducts[j];
        const minR = parseFloat(p.perDayRateMin) || 10;
        const maxR = parseFloat(p.perDayRateMax) || 500;
        const rate = roundToWholeInteger(minR + Math.random() * (maxR - minR));

        const minQ = Math.max(10, parseFloat(p.perDayQtyMin) || 10);
        const maxQ = Math.max(minQ, parseFloat(p.perDayQtyMax) || 100);

        const remBudget = targetBudget - currentInvoiceAmount;
        if (remBudget <= 0) break;

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
          category: catKey,
          quantity: qtyToPut,
          rate,
          amount: amt,
        });
        currentInvoiceAmount =
          Math.round((currentInvoiceAmount + amt) * 100) / 100;
      }

      if (currentInvoiceProducts.length === 0) {
        const p = categoryProducts[0];
        const minQ = Math.max(10, parseFloat(p.perDayQtyMin) || 10);
        const rate = roundToWholeInteger(targetBudget / minQ);
        const amt = computeLineAmount(minQ, rate);
        currentInvoiceProducts.push({
          product_id: p.product_id,
          product_name: p.product_name,
          hsn_code: p.hsn_code,
          unit_of_measure: p.unit_of_measure,
          category: catKey,
          quantity: minQ,
          rate,
          amount: amt,
        });
        currentInvoiceAmount = amt;
      }

      // Absorb line-item drift onto product rates to hit targetBudget cleanly
      let lineDrift =
        Math.round((targetBudget - currentInvoiceAmount) * 100) / 100;

      if (Math.abs(lineDrift) > 0.001 && currentInvoiceProducts.length > 0) {
        for (const item of currentInvoiceProducts) {
          if (Math.abs(lineDrift) <= 0.01) break;
          const targetLineAmt =
            Math.round((item.amount + lineDrift) * 100) / 100;
          if (targetLineAmt > 0) {
            let newRate = roundToWholeInteger(targetLineAmt / item.quantity);
            if (newRate > 0) {
              item.rate = newRate;
              item.amount = computeLineAmount(item.quantity, newRate);
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
      }

      const finalInvoiceTotal =
        Math.round(
          currentInvoiceProducts.reduce((sum, p) => sum + p.amount, 0) * 100,
        ) / 100;

      const supplierId =
        selectedCustomers.length > 0
          ? selectedCustomers[i % selectedCustomers.length]
          : batch.receiving_company_id || null;

      invoices.push({
        invoice_number: `INV-TEMP-${invoiceCounter++}`,
        invoice_date: dateStr,
        customer_id: supplierId,
        category_key: catKey,
        products: currentInvoiceProducts,
        total_amount: finalInvoiceTotal,
        status: "generated",
        batch_type: "PURCHASE",
      });
    }

    // Final global drift alignment across invoices to hit totalAmount EXACTLY in whole integer rupees
    const finalSum = Math.round(
      invoices.reduce((sum, inv) => sum + Math.round(inv.total_amount || 0), 0),
    );
    const globalDrift = Math.round(totalAmount) - finalSum;

    if (Math.abs(globalDrift) > 0 && invoices.length > 0) {
      const lastInv = invoices[invoices.length - 1];
      if (lastInv && lastInv.products.length > 0) {
        const lastItem = lastInv.products[lastInv.products.length - 1];
        const targetLineAmt = Math.round(lastItem.amount + globalDrift);
        if (targetLineAmt > 0) {
          lastItem.amount = targetLineAmt;
          lastItem.rate = roundToWholeInteger(
            lastItem.amount / (lastItem.quantity || 1),
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
