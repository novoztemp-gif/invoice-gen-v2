import { SupabaseClient } from "@supabase/supabase-js";
import { AutoBalanceEngine } from "./AutoBalanceEngine";

export interface ProductConfig {
  product_id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  perDayQtyMin: string;
  perDayQtyMax: string;
  perDayRateMin: string;
  perDayRateMax: string;
}

export interface MajorCustomerConfig {
  customer_id: string;
  amount: number;
  invoice_count: number;
}

export interface RecurringProductConfig {
  product_id: string;
  percentage: number;
}

export interface InvoiceBatch {
  id: string;
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
}

export interface CreateBatchParams {
  issuingCompanyId: string;
  receivingCompanyId?: string | null;
  selectedCustomers: string[];
  majorCustomers: Array<{
    customer_id: string;
    amount: string | number;
    invoice_count: string | number;
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

    // Validation 1.5: Validate recurring products
    if (recurringProducts.length > 0) {
      let totalPercentage = 0;
      for (const rp of recurringProducts) {
        const pct =
          typeof rp.percentage === "string"
            ? parseFloat(rp.percentage)
            : rp.percentage;
        if (pct < 1 || pct > 100) {
          return {
            isValid: false,
            message: "Recurring product percentages must be between 1 and 100.",
          };
        }

        const existsInProducts = products.some(
          (p) => p.product.id === rp.product_id,
        );
        if (!existsInProducts) {
          return {
            isValid: false,
            message:
              "A recurring product is not present in the selected products list.",
          };
        }

        totalPercentage += pct;
      }

      if (totalPercentage > 100) {
        return {
          isValid: false,
          message: `Total recurring product percentage cannot exceed 100%. Current is ${totalPercentage}%.`,
        };
      }
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

    // Estimate number of invoices needed per day
    const estimatedInvoicesPerDay = Math.ceil(avgAmountPerDay / maxThreshold);
    const totalInvoicesEstimated = estimatedInvoicesPerDay * numberOfDays;

    return {
      isValid: true,
      message: `✓ Validation successful! Estimated ${estimatedInvoicesPerDay}+ invoice(s) per day over ${numberOfDays} day(s).`,
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

    const receivingCompanyIdResolved =
      receivingCompanyId ||
      selectedCustomers[0] ||
      (majorCustomers[0] ? majorCustomers[0].customer_id : null);

    const { data, error } = await supabase
      .from("invoice_batch")
      .insert({
        issuing_company_id: issuingCompanyId,
        receiving_company_id: receivingCompanyIdResolved,
        selected_customers: selectedCustomers,
        major_customers: majorCustomers.map((m) => ({
          customer_id: m.customer_id,
          amount:
            typeof m.amount === "string" ? parseFloat(m.amount) : m.amount || 0,
          invoice_count:
            typeof m.invoice_count === "string"
              ? parseInt(m.invoice_count, 10)
              : m.invoice_count || 1,
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
      .select("total_amount")
      .eq("id", invoiceId)
      .single();

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

    // Get ALL invoice numbers to find the highest counter
    const { data: allInvoices } = await supabase
      .from("invoice")
      .select("invoice_number")
      .order("invoice_number", { ascending: false });

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

    const invoices = this.generateInvoiceSplitupsInternal(
      typedBatch,
      numberOfDays,
      fromDate,
      startingCounter,
    );

    // Validate all generated invoices before saving
    for (const inv of invoices) {
      const validation = this.validateInvoiceData(inv);
      if (!validation.isValid) {
        throw new Error(`Generation validation failed: ${validation.message}`);
      }
    }

    // Insert all invoices atomically in a single bulk insert call
    const { error: insertError } = await supabase
      .from("invoice")
      .insert(invoices);
    if (insertError) {
      throw new Error(`Failed to save invoices: ${insertError.message}`);
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
   * Internal generator logic
   */
  private static generateInvoiceSplitupsInternal(
    batch: InvoiceBatch,
    numberOfDays: number,
    startDate: Date,
    startingCounter: number = 1,
  ) {
    const invoices = [];
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    const totalAmount = batch.total_amount;
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

    // Phase 1: Generate Major Customer Invoices First
    for (const major of majorCustomers) {
      if (!major.customer_id || major.invoice_count < 1 || major.amount <= 0) {
        continue;
      }

      const n = major.invoice_count;
      const amounts: number[] = [];

      if (n === 1) {
        amounts.push(major.amount);
      } else {
        const weights: number[] = [];
        let totalWeight = 0;
        for (let i = 0; i < n; i++) {
          const w = 0.2 + Math.random() * 0.8;
          weights.push(w);
          totalWeight += w;
        }
        let allocatedAmount = 0;
        for (let i = 0; i < n - 1; i++) {
          const amt =
            Math.round(major.amount * (weights[i] / totalWeight) * 100) / 100;
          amounts.push(amt);
          allocatedAmount += amt;
        }
        const lastAmt =
          Math.round((major.amount - allocatedAmount) * 100) / 100;
        amounts.push(lastAmt);
      }

      for (const invoiceAmount of amounts) {
        const dayOffset = Math.floor(Math.random() * numberOfDays);
        const currentDate = new Date(startDate);
        currentDate.setDate(startDate.getDate() + dayOffset);
        const invoiceDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

        const subset = this.pickRandomProductsSubset(
          batch.products,
          batch.recurring_products || [],
          invoiceAmount,
        );
        const products = this.distributeAmountToProducts(subset, invoiceAmount);

        const exactTotal =
          Math.round(products.reduce((sum, p) => sum + p.amount, 0) * 100) /
          100;

        const prefix = batch.batch_type === "PURCHASE" ? "PI" : "INV";
        const invoiceNumber = `${prefix}-${currentDate.getFullYear()}-${String(
          currentDate.getMonth() + 1,
        ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(
          2,
          "0",
        )}-${String(invoiceCounter).padStart(4, "0")}`;

        const productsWithCustomerId = products.map((p) => ({
          ...p,
          customer_id: major.customer_id,
        }));

        invoices.push({
          invoice_batch_id: batch.id,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          products: productsWithCustomerId,
          total_amount: exactTotal,
          status: "generated",
          batch_type: batch.batch_type,
        });

        invoiceCounter++;
      }
    }

    // Phase 2: Generate Regular Invoices for Normal Customers
    const majorTotal = majorCustomers.reduce(
      (sum, m) => sum + (m.amount || 0),
      0,
    );
    let remainingBatchAmount =
      Math.round((totalAmount - majorTotal) * 100) / 100;

    if (remainingBatchAmount > 0.01 && selectedCustomers.length > 0) {
      while (remainingBatchAmount > 0.01) {
        let randomAmount =
          thresholdMin + Math.random() * (thresholdMax - thresholdMin);
        let invoiceAmount =
          Math.round(Math.min(remainingBatchAmount, randomAmount) * 100) / 100;

        const dayOffset = Math.floor(Math.random() * numberOfDays);
        const currentDate = new Date(startDate);
        currentDate.setDate(startDate.getDate() + dayOffset);
        const invoiceDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

        const maxProductsForThisInvoice = Math.floor(Math.random() * 4) + 1;
        const subset = this.pickRandomProductsSubset(
          batch.products,
          batch.recurring_products || [],
          invoiceAmount,
        );
        const limitedSubset = subset.slice(0, maxProductsForThisInvoice);

        const products = this.distributeAmountToProducts(
          limitedSubset.length > 0 ? limitedSubset : batch.products.slice(0, 1),
          invoiceAmount,
        );

        const exactTotal =
          Math.round(products.reduce((sum, p) => sum + p.amount, 0) * 100) /
          100;

        const prefix = batch.batch_type === "PURCHASE" ? "PI" : "INV";
        const invoiceNumber = `${prefix}-${currentDate.getFullYear()}-${String(
          currentDate.getMonth() + 1,
        ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(
          2,
          "0",
        )}-${String(invoiceCounter).padStart(4, "0")}`;

        const randomCustomerIndex = Math.floor(
          Math.random() * selectedCustomers.length,
        );
        const assignedCustomerId = selectedCustomers[randomCustomerIndex];

        const productsWithCustomerId = products.map((p) => ({
          ...p,
          customer_id: assignedCustomerId,
        }));

        invoices.push({
          invoice_batch_id: batch.id,
          invoice_number: invoiceNumber,
          invoice_date: invoiceDate,
          products: productsWithCustomerId,
          total_amount: exactTotal,
          status: "generated",
          batch_type: batch.batch_type,
        });

        remainingBatchAmount = Math.max(
          0,
          Math.round((remainingBatchAmount - exactTotal) * 100) / 100,
        );
        invoiceCounter++;
      }
    }

    // Phase 3: Final Grand Total Validation and Drift Correction
    const finalGrandTotal =
      Math.round(
        invoices.reduce((sum, inv) => sum + inv.total_amount, 0) * 100,
      ) / 100;
    let grandDiff = Math.round((totalAmount - finalGrandTotal) * 100) / 100;

    if (Math.abs(grandDiff) > 0.001 && invoices.length > 0) {
      // Find an invoice that can absorb grandDiff without violating positive constraints
      for (let i = invoices.length - 1; i >= 0; i--) {
        const inv = invoices[i];
        if (inv.products && inv.products.length > 0) {
          const lastProd = inv.products[inv.products.length - 1];
          const newAmount =
            Math.round((lastProd.amount + grandDiff) * 100) / 100;
          const newTotal =
            Math.round((inv.total_amount + grandDiff) * 100) / 100;
          const newRate =
            Math.round((newAmount / lastProd.quantity) * 100) / 100;

          if (newAmount > 0.01 && newTotal > 0.01 && newRate > 0.01) {
            inv.total_amount = newTotal;
            lastProd.amount = newAmount;
            lastProd.rate = newRate;
            grandDiff = 0;
            break;
          }
        }
      }

      // If we still have diff, try to distribute it in tiny parts across multiple invoices
      if (Math.abs(grandDiff) > 0.001) {
        for (let i = invoices.length - 1; i >= 0; i--) {
          const inv = invoices[i];
          if (inv.products && inv.products.length > 0) {
            const lastProd = inv.products[inv.products.length - 1];
            const maxAbsorbable = lastProd.amount - 0.01;
            if (maxAbsorbable > 0) {
              const amountToAbsorb =
                grandDiff > 0
                  ? grandDiff
                  : -Math.min(Math.abs(grandDiff), maxAbsorbable);
              const newAmount =
                Math.round((lastProd.amount + amountToAbsorb) * 100) / 100;
              const newTotal =
                Math.round((inv.total_amount + amountToAbsorb) * 100) / 100;
              const newRate =
                Math.round((newAmount / lastProd.quantity) * 100) / 100;

              if (newAmount > 0.01 && newTotal > 0.01 && newRate > 0.01) {
                inv.total_amount = newTotal;
                lastProd.amount = newAmount;
                lastProd.rate = newRate;
                grandDiff =
                  Math.round((grandDiff - amountToAbsorb) * 100) / 100;
              }
            }
          }
          if (Math.abs(grandDiff) < 0.001) break;
        }
      }

      if (Math.abs(grandDiff) > 0.001) {
        throw new Error(
          `Critical Drift Correction Error: Cannot balance drift of ₹${grandDiff} while respecting positive accounting rules.`,
        );
      }
    }

    return invoices;
  }

  private static pickRandomProductsSubset(
    allProducts: ProductConfig[],
    recurringProducts: RecurringProductConfig[],
    targetAmount: number,
  ): ProductConfig[] {
    const picked: ProductConfig[] = [];
    const unpicked: ProductConfig[] = [];

    const shuffled = [...allProducts].sort(() => Math.random() - 0.5);
    let totalMaxCapacity = 0;

    for (const product of shuffled) {
      const recurring = recurringProducts.find(
        (r) => r.product_id === product.product_id,
      );
      const prob = recurring ? recurring.percentage / 100 : 0.15;

      const maxQty = parseFloat(product.perDayQtyMax);
      const maxRate = parseFloat(product.perDayRateMax);
      const maxCap = maxQty * maxRate;

      if (Math.random() <= prob) {
        picked.push(product);
        totalMaxCapacity += maxCap;
      } else {
        unpicked.push(product);
      }
    }

    if (picked.length === 0 || totalMaxCapacity < targetAmount) {
      for (const product of unpicked) {
        const maxQty = parseFloat(product.perDayQtyMax);
        const maxRate = parseFloat(product.perDayRateMax);
        const maxCap = maxQty * maxRate;

        picked.push(product);
        totalMaxCapacity += maxCap;

        if (totalMaxCapacity >= targetAmount) {
          break;
        }
      }
    }

    return picked;
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

    productData.sort(() => Math.random() - 0.5);

    const selectedProducts: typeof productData = [];
    let totalMin = 0;
    let totalMax = 0;

    for (const product of productData) {
      if (totalMin + product.minAmount <= targetAmount) {
        selectedProducts.push(product);
        totalMin += product.minAmount;
        totalMax += product.maxAmount;
      }
    }

    if (selectedProducts.length === 0) {
      productData.sort((a, b) => a.minAmount - b.minAmount);
      selectedProducts.push(productData[0]);
      totalMin = productData[0].minAmount;
      totalMax = productData[0].maxAmount;
    }

    let totalAllocated = 0;

    selectedProducts.forEach((item, index) => {
      const isLast = index === selectedProducts.length - 1;
      let productTargetAmount: number;

      if (isLast) {
        productTargetAmount = targetAmount - totalAllocated;
      } else {
        const productRange = item.maxAmount - item.minAmount;
        const totalRange = totalMax - totalMin;
        if (totalRange > 0) {
          const proportion = productRange / totalRange;
          const randomAdjustment = 0.8 + Math.random() * 0.4;
          productTargetAmount =
            (item.minAmount + (targetAmount - totalMin) * proportion) *
            randomAdjustment;
        } else {
          productTargetAmount = targetAmount / selectedProducts.length;
        }
      }

      productTargetAmount = Math.max(
        item.minAmount,
        Math.min(item.maxAmount, productTargetAmount),
      );

      const qtyRange = item.maxQty - item.minQty;
      const qtyRandomFactor = Math.random();
      const randomQty = item.minQty + qtyRange * qtyRandomFactor;
      const quantity = Math.round(randomQty);

      const rateRange = item.maxRate - item.minRate;
      const rateRandomFactor = Math.random();
      let rate = item.minRate + rateRange * rateRandomFactor;

      let finalAmount = quantity * rate;

      if (!isLast) {
        if (finalAmount < item.minAmount || finalAmount > item.maxAmount) {
          const targetRate = productTargetAmount / quantity;
          rate = Math.max(item.minRate, Math.min(item.maxRate, targetRate));
          finalAmount = quantity * rate;
        }
      } else {
        rate = productTargetAmount / quantity;
        rate = Math.max(item.minRate, Math.min(item.maxRate, rate));
        finalAmount = quantity * rate;
      }

      products.push({
        product_id: item.config.product_id,
        product_name: item.config.product_name,
        hsn_code: item.config.hsn_code,
        unit_of_measure: item.config.unit_of_measure,
        quantity,
        rate: Math.round(rate * 100) / 100,
        amount: Math.round(finalAmount * 100) / 100,
      });

      totalAllocated += finalAmount;
    });

    const totalAfter = products.reduce((s, p) => s + p.amount, 0);
    const diff = Math.round((targetAmount - totalAfter) * 100) / 100;
    if (Math.abs(diff) > 0.01 && products.length > 0) {
      const last = products[products.length - 1];
      const newAmount = Math.round((last.amount + diff) * 100) / 100;
      const newRate = Math.round((newAmount / last.quantity) * 100) / 100;
      if (newAmount > 0.01 && newRate > 0.01) {
        last.amount = newAmount;
        last.rate = newRate;
      } else {
        // Find another product in this invoice to absorb the difference
        let absorbed = false;
        for (let i = products.length - 2; i >= 0; i--) {
          const p = products[i];
          const pAmount = Math.round((p.amount + diff) * 100) / 100;
          const pRate = Math.round((pAmount / p.quantity) * 100) / 100;
          if (pAmount > 0.01 && pRate > 0.01) {
            p.amount = pAmount;
            p.rate = pRate;
            absorbed = true;
            break;
          }
        }
        if (!absorbed) {
          throw new Error(
            `Cannot distribute target amount ₹${targetAmount} to products without generating negative rates/amounts.`,
          );
        }
      }
    }

    return products;
  }
}
