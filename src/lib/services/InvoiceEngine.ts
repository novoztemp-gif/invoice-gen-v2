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

    let invoices: any[] = [];
    if (typedBatch.batch_type === "PURCHASE") {
      const { data: qData, error: qError } = await supabase
        .from("purchase_batch_products")
        .select("product_id, monthly_quantity")
        .eq("batch_id", batchId);

      if (qError) {
        throw new Error(
          `Failed to load monthly purchase quantities: ${qError.message}`,
        );
      }

      const monthlyQuantitiesMap = new Map<string, number>(
        (qData || []).map((item: any) => [
          item.product_id,
          Number(item.monthly_quantity) || 0,
        ]),
      );

      invoices = this.generatePurchaseInvoiceSplitupsInternal(
        typedBatch,
        numberOfDays,
        fromDate,
        startingCounter,
        monthlyQuantitiesMap,
      );
    } else {
      let availableStockMap: Map<string, number> | null = null;
      if (typedBatch.stock_source_batch_id) {
        const { data: ledgerData, error: ledgerError } = await supabase
          .from("daily_stock_ledger")
          .select(
            "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          .eq("purchase_batch_id", typedBatch.stock_source_batch_id);

        if (ledgerError) {
          throw new Error(
            `Failed to load daily stock ledger: ${ledgerError.message}`,
          );
        }

        availableStockMap = new Map<string, number>();
        for (const row of ledgerData || []) {
          const key = `${row.ledger_date}_${row.product_id}`;
          const available =
            (row.opening_stock || 0) +
            (row.purchased_quantity || 0) -
            (row.sold_quantity || 0);
          availableStockMap.set(key, Math.max(0, available));
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

    // Validate quantities for PURCHASE batches
    if (typedBatch.batch_type === "PURCHASE") {
      const { data: qData } = await supabase
        .from("purchase_batch_products")
        .select("product_id, monthly_quantity")
        .eq("batch_id", batchId);

      const monthlyQuantitiesMap = new Map<string, number>(
        (qData || []).map((item: any) => [
          item.product_id,
          Number(item.monthly_quantity) || 0,
        ]),
      );

      const productTotalQty = new Map<string, number>();
      for (const inv of invoices) {
        for (const p of inv.products) {
          productTotalQty.set(
            p.product_id,
            (productTotalQty.get(p.product_id) || 0) + p.quantity,
          );
        }
      }

      for (const prod of typedBatch.products) {
        const targetQty = monthlyQuantitiesMap.get(prod.product_id) || 0;
        const genQty = productTotalQty.get(prod.product_id) || 0;
        if (Math.abs(genQty - targetQty) > 0.01) {
          throw new Error(
            `Quantity mismatch validation failed for product "${prod.product_name}". Target: ${targetQty} ${prod.unit_of_measure}, Generated: ${genQty} ${prod.unit_of_measure}. Difference: ${targetQty - genQty}`,
          );
        }
      }
    }

    // Insert all invoices and handle daily stock ledger for Sales batches atomically
    let savedInvoices: any[] = [];
    if (typedBatch.batch_type === "SALES" && typedBatch.stock_source_batch_id) {
      // 1. Fetch daily stock ledger for the selected stock source purchase batch
      const { data: ledgerRows, error: ledgerError } = await supabase
        .from("daily_stock_ledger")
        .select(
          "id, ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
        )
        .eq("purchase_batch_id", typedBatch.stock_source_batch_id);

      if (ledgerError) {
        throw new Error(
          `Failed to retrieve daily stock ledger: ${ledgerError.message}`,
        );
      }

      const ledgerMap = new Map<string, any>();
      for (const row of ledgerRows || []) {
        const key = `${row.ledger_date}_${row.product_id}`;
        ledgerMap.set(key, row);
      }

      // 2. Validate available stock for each generated invoice product on its specific date
      const generatedDailyQty = new Map<string, number>();
      for (const inv of invoices) {
        for (const p of inv.products) {
          const key = `${inv.invoice_date}_${p.product_id}`;
          generatedDailyQty.set(
            key,
            (generatedDailyQty.get(key) || 0) + p.quantity,
          );
        }
      }

      for (const [key, requestedQty] of generatedDailyQty.entries()) {
        const [date, product_id] = key.split("_");
        const row = ledgerMap.get(key);

        const available = row
          ? (row.opening_stock || 0) +
            (row.purchased_quantity || 0) -
            (row.sold_quantity || 0)
          : 0;

        if (requestedQty > available) {
          const productName =
            typedBatch.products.find((p) => p.product_id === product_id)
              ?.product_name || "Unknown Product";
          const formattedDate = this.formatDateString(date);
          const unit =
            typedBatch.products.find((p) => p.product_id === product_id)
              ?.unit_of_measure || "kg";

          throw new Error(
            `Insufficient stock for ${productName} on ${formattedDate}.\nAvailable: ${available}${unit}\nRequested: ${requestedQty}${unit}`,
          );
        }
      }

      // 3. Insert the invoices
      const { data: selectInvoices, error: insertError } = await supabase
        .from("invoice")
        .insert(invoices)
        .select();

      if (insertError) {
        throw new Error(`Failed to save invoices: ${insertError.message}`);
      }
      savedInvoices = selectInvoices || [];
      const insertedIds = savedInvoices.map((inv) => inv.id);

      // 4. Update the daily stock ledger sold_quantity for each row
      try {
        for (const [key, qty] of generatedDailyQty.entries()) {
          const row = ledgerMap.get(key);
          if (row) {
            const newSold = (row.sold_quantity || 0) + qty;
            const limit =
              (row.opening_stock || 0) + (row.purchased_quantity || 0);

            if (newSold > limit) {
              const productName =
                typedBatch.products.find((p) => p.product_id === row.product_id)
                  ?.product_name || "Product";
              const formattedDate = this.formatDateString(row.ledger_date);
              const unit =
                typedBatch.products.find((p) => p.product_id === row.product_id)
                  ?.unit_of_measure || "kg";
              throw new Error(
                `Insufficient stock for ${productName} on ${formattedDate}.\nAvailable: ${limit - row.sold_quantity}${unit}\nRequested: ${qty}${unit}`,
              );
            }

            const { error: updateError } = await supabase
              .from("daily_stock_ledger")
              .update({
                sold_quantity: newSold,
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id);

            if (updateError) {
              throw new Error(
                `Failed to update daily stock ledger row: ${updateError.message}`,
              );
            }
          }
        }
      } catch (updateErr) {
        // Rollback: delete inserted invoices
        if (insertedIds.length > 0) {
          await supabase.from("invoice").delete().in("id", insertedIds);
        }
        throw updateErr;
      }
    } else {
      const { error: insertError } = await supabase
        .from("invoice")
        .insert(invoices);
      if (insertError) {
        throw new Error(`Failed to save invoices: ${insertError.message}`);
      }
    }

    // If it is a PURCHASE batch, populate the daily_stock_ledger
    if (typedBatch.batch_type === "PURCHASE") {
      const dailyQtyMap = new Map<string, number>(); // key: date_productId, value: quantity

      for (const inv of invoices) {
        for (const p of inv.products) {
          const key = `${inv.invoice_date}_${p.product_id}`;
          dailyQtyMap.set(key, (dailyQtyMap.get(key) || 0) + p.quantity);
        }
      }

      const ledgerRecords = [];
      for (const [key, qty] of dailyQtyMap.entries()) {
        const [date, product_id] = key.split("_");
        ledgerRecords.push({
          purchase_batch_id: batchId,
          ledger_date: date,
          product_id: product_id,
          opening_stock: 0,
          purchased_quantity: qty,
          sold_quantity: 0,
        });
      }

      // Fetch target monthly quantities for final double-check validation
      const { data: qData } = await supabase
        .from("purchase_batch_products")
        .select("product_id, monthly_quantity")
        .eq("batch_id", batchId);

      const monthlyQuantitiesMap = new Map<string, number>(
        (qData || []).map((item: any) => [
          item.product_id,
          Number(item.monthly_quantity) || 0,
        ]),
      );

      // Perform SUM(purchased_quantity) validation on ledger records
      for (const prod of typedBatch.products) {
        const targetQty = monthlyQuantitiesMap.get(prod.product_id) || 0;
        const allocatedQty = ledgerRecords
          .filter((r) => r.product_id === prod.product_id)
          .reduce((sum, r) => sum + r.purchased_quantity, 0);

        if (Math.abs(allocatedQty - targetQty) > 0.01) {
          throw new Error(
            `Ledger Quantity validation failed for product "${prod.product_name}". Target: ${targetQty}, Allocated in Ledger: ${allocatedQty}`,
          );
        }
      }

      const { error: ledgerError } = await supabase
        .from("daily_stock_ledger")
        .insert(ledgerRecords);

      if (ledgerError) {
        throw new Error(
          `Failed to save daily stock ledger records: ${ledgerError.message}`,
        );
      }
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

  /**
   * Internal generator logic
   */
  private static generateInvoiceSplitupsInternal(
    batch: InvoiceBatch,
    numberOfDays: number,
    startDate: Date,
    startingCounter: number = 1,
    availableStockMap?: Map<string, number> | null,
  ) {
    const invoices = [];
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    const totalAmount = batch.total_amount;
    let invoiceCounter = startingCounter;

    const allocatedStock = new Map<string, number>(); // key: date_product_id, value: allocated quantity

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

        let dateProducts = batch.products;
        if (availableStockMap) {
          dateProducts = batch.products
            .map((prod) => {
              const key = `${invoiceDate}_${prod.product_id}`;
              const avail = availableStockMap.get(key) || 0;
              const allocated = allocatedStock.get(key) || 0;
              const currentAvail = Math.max(0, avail - allocated);
              return {
                ...prod,
                perDayQtyMin: Math.min(
                  parseFloat(prod.perDayQtyMin),
                  currentAvail,
                ).toString(),
                perDayQtyMax: Math.min(
                  parseFloat(prod.perDayQtyMax),
                  currentAvail,
                ).toString(),
                currentAvailable: currentAvail,
              };
            })
            .filter((prod) => prod.currentAvailable > 0);
        }

        const subset = this.pickRandomProductsSubset(
          dateProducts,
          batch.recurring_products || [],
          invoiceAmount,
        );
        const products = this.distributeAmountToProducts(
          subset.length > 0 ? subset : dateProducts.slice(0, 1),
          invoiceAmount,
        );

        if (availableStockMap) {
          for (const p of products) {
            const key = `${invoiceDate}_${p.product_id}`;
            allocatedStock.set(
              key,
              (allocatedStock.get(key) || 0) + p.quantity,
            );
          }
        }

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

        let dateProducts = batch.products;
        if (availableStockMap) {
          dateProducts = batch.products
            .map((prod) => {
              const key = `${invoiceDate}_${prod.product_id}`;
              const avail = availableStockMap.get(key) || 0;
              const allocated = allocatedStock.get(key) || 0;
              const currentAvail = Math.max(0, avail - allocated);
              return {
                ...prod,
                perDayQtyMin: Math.min(
                  parseFloat(prod.perDayQtyMin),
                  currentAvail,
                ).toString(),
                perDayQtyMax: Math.min(
                  parseFloat(prod.perDayQtyMax),
                  currentAvail,
                ).toString(),
                currentAvailable: currentAvail,
              };
            })
            .filter((prod) => prod.currentAvailable > 0);
        }

        const subset = this.pickRandomProductsSubset(
          dateProducts,
          batch.recurring_products || [],
          invoiceAmount,
        );

        const products = this.distributeAmountToProducts(
          subset.length > 0 ? subset : dateProducts.slice(0, 1),
          invoiceAmount,
        );

        if (availableStockMap) {
          for (const p of products) {
            const key = `${invoiceDate}_${p.product_id}`;
            allocatedStock.set(
              key,
              (allocatedStock.get(key) || 0) + p.quantity,
            );
          }
        }

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
      // Find an invoice and a product that can absorb grandDiff without violating positive constraints or product rules
      for (let i = invoices.length - 1; i >= 0; i--) {
        const inv = invoices[i];
        if (inv.products && inv.products.length > 0) {
          let absorbed = false;
          // Try to adjust any product in this invoice to absorb the grandDiff
          for (let pIdx = inv.products.length - 1; pIdx >= 0; pIdx--) {
            const p = inv.products[pIdx];
            const prodConfig = batch.products.find(
              (pc) => pc.product_id === p.product_id,
            );
            if (!prodConfig) continue;

            const minRate = parseFloat(prodConfig.perDayRateMin);
            const maxRate = parseFloat(prodConfig.perDayRateMax);
            const minQty = parseFloat(prodConfig.perDayQtyMin);
            const maxQty = parseFloat(prodConfig.perDayQtyMax);

            const newAmount = Math.round((p.amount + grandDiff) * 100) / 100;
            const newTotal =
              Math.round((inv.total_amount + grandDiff) * 100) / 100;

            if (
              newTotal >= thresholdMin &&
              newTotal <= thresholdMax &&
              newAmount > 0.01
            ) {
              // Try to find a valid quantity and rate that yields exactly newAmount
              for (let q = minQty; q <= maxQty; q++) {
                const r = Math.round((newAmount / q) * 100) / 100;
                if (
                  r >= minRate &&
                  r <= maxRate &&
                  Math.abs(q * r - newAmount) < 0.01
                ) {
                  p.quantity = q;
                  p.rate = r;
                  p.amount = newAmount;
                  inv.total_amount = newTotal;
                  absorbed = true;
                  break;
                }
              }
            }
            if (absorbed) break;
          }
          if (absorbed) {
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
            let absorbed = false;
            for (let pIdx = inv.products.length - 1; pIdx >= 0; pIdx--) {
              const p = inv.products[pIdx];
              const prodConfig = batch.products.find(
                (pc) => pc.product_id === p.product_id,
              );
              if (!prodConfig) continue;

              const minRate = parseFloat(prodConfig.perDayRateMin);
              const maxRate = parseFloat(prodConfig.perDayRateMax);
              const minQty = parseFloat(prodConfig.perDayQtyMin);
              const maxQty = parseFloat(prodConfig.perDayQtyMax);

              const maxAbsorbable = p.amount - 0.01;
              if (maxAbsorbable > 0) {
                const amountToAbsorb =
                  grandDiff > 0
                    ? grandDiff
                    : -Math.min(Math.abs(grandDiff), maxAbsorbable);
                const newAmount =
                  Math.round((p.amount + amountToAbsorb) * 100) / 100;
                const newTotal =
                  Math.round((inv.total_amount + amountToAbsorb) * 100) / 100;

                if (
                  newTotal >= thresholdMin &&
                  newTotal <= thresholdMax &&
                  newAmount > 0.01
                ) {
                  for (let q = minQty; q <= maxQty; q++) {
                    const r = Math.round((newAmount / q) * 100) / 100;
                    if (
                      r >= minRate &&
                      r <= maxRate &&
                      Math.abs(q * r - newAmount) < 0.01
                    ) {
                      p.quantity = q;
                      p.rate = r;
                      p.amount = newAmount;
                      inv.total_amount = newTotal;
                      grandDiff =
                        Math.round((grandDiff - amountToAbsorb) * 100) / 100;
                      absorbed = true;
                      break;
                    }
                  }
                }
              }
              if (absorbed) break;
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

    selectedProducts.forEach((item, index) => {
      const targetProdAmount = A[index];

      const qMinPossible = Math.ceil(targetProdAmount / item.maxRate);
      const qMaxPossible = Math.floor(targetProdAmount / item.minRate);
      const qLow = Math.max(item.minQty, qMinPossible);
      const qHigh = Math.min(item.maxQty, qMaxPossible);

      let quantity: number;
      if (qLow <= qHigh) {
        quantity = Math.round(qLow + Math.random() * (qHigh - qLow));
      } else {
        quantity = Math.round(
          item.minQty + Math.random() * (item.maxQty - item.minQty),
        );
      }
      quantity = Math.max(item.minQty, Math.min(item.maxQty, quantity));

      let rate = targetProdAmount / quantity;
      rate = Math.max(item.minRate, Math.min(item.maxRate, rate));
      rate = Math.round(rate * 100) / 100;

      const finalAmount = Math.round(quantity * rate * 100) / 100;

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
    monthlyQuantities: Map<string, number>,
  ) {
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    const totalAmount = batch.total_amount;

    // 1. Solve rates for each product
    const rates = new Map<string, number>();
    let minAmountSum = 0;
    let maxAmountSum = 0;

    for (const prod of batch.products) {
      const qty = monthlyQuantities.get(prod.product_id) || 0;
      const minR = parseFloat(prod.perDayRateMin);
      const maxR = parseFloat(prod.perDayRateMax);
      minAmountSum += qty * minR;
      maxAmountSum += qty * maxR;
    }

    if (totalAmount < minAmountSum || totalAmount > maxAmountSum) {
      throw new Error(
        `Target total amount (₹${totalAmount}) is out of rate limit bounds for the monthly quantities. Minimum possible is ₹${minAmountSum.toFixed(2)}, Maximum possible is ₹${maxAmountSum.toFixed(2)}.`,
      );
    }

    if (maxAmountSum > minAmountSum) {
      const factor =
        (totalAmount - minAmountSum) / (maxAmountSum - minAmountSum);
      for (const prod of batch.products) {
        const minR = parseFloat(prod.perDayRateMin);
        const maxR = parseFloat(prod.perDayRateMax);
        const rate = minR + factor * (maxR - minR);
        rates.set(prod.product_id, Math.round(rate * 100) / 100);
      }
    } else {
      for (const prod of batch.products) {
        rates.set(prod.product_id, parseFloat(prod.perDayRateMin));
      }
    }

    // Absorb rounding drift in the first product
    const firstProdWithQty = batch.products.find(
      (p) => (monthlyQuantities.get(p.product_id) || 0) > 0,
    );
    if (firstProdWithQty) {
      const sumAmounts = batch.products.reduce((sum, prod) => {
        const qty = monthlyQuantities.get(prod.product_id) || 0;
        const rate = rates.get(prod.product_id) || 0;
        return sum + qty * rate;
      }, 0);
      const drift = Math.round((totalAmount - sumAmounts) * 100) / 100;
      const qty = monthlyQuantities.get(firstProdWithQty.product_id) || 0;
      if (Math.abs(drift) > 0.01 && qty > 0) {
        const r = rates.get(firstProdWithQty.product_id) || 0;
        rates.set(
          firstProdWithQty.product_id,
          Math.round((r + drift / qty) * 1000) / 1000,
        );
      }
    }

    // 2. Try until we succeed within constraints
    let attempt = 0;
    const maxAttempts = 100;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const invoices = [];
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

        // Target invoice amounts list
        const targets: Array<{ amount: number; customerId: string }> = [];

        // Major Customers/Suppliers
        for (const major of majorCustomers) {
          if (
            !major.customer_id ||
            major.invoice_count < 1 ||
            major.amount <= 0
          )
            continue;

          const n = major.invoice_count;
          const amounts: number[] = [];
          if (n === 1) {
            amounts.push(major.amount);
          } else {
            const weights = Array.from(
              { length: n },
              () => 0.2 + Math.random() * 0.8,
            );
            const sumW = weights.reduce((a, b) => a + b, 0);
            let allocated = 0;
            for (let i = 0; i < n - 1; i++) {
              const amt =
                Math.round(major.amount * (weights[i] / sumW) * 100) / 100;
              amounts.push(amt);
              allocated += amt;
            }
            amounts.push(Math.round((major.amount - allocated) * 100) / 100);
          }

          for (const amt of amounts) {
            targets.push({ amount: amt, customerId: major.customer_id });
          }
        }

        // Regular Customers/Suppliers
        const majorTotal = majorCustomers.reduce(
          (s, m) => s + (m.amount || 0),
          0,
        );
        let remainingBatchAmount =
          Math.round((totalAmount - majorTotal) * 100) / 100;

        if (remainingBatchAmount > 0.01 && selectedCustomers.length > 0) {
          while (remainingBatchAmount > 0.01) {
            const randomAmount =
              thresholdMin + Math.random() * (thresholdMax - thresholdMin);
            const invoiceAmount =
              Math.round(Math.min(remainingBatchAmount, randomAmount) * 100) /
              100;

            const randomCustomerIndex = Math.floor(
              Math.random() * selectedCustomers.length,
            );
            const assignedCustomerId = selectedCustomers[randomCustomerIndex];

            targets.push({
              amount: invoiceAmount,
              customerId: assignedCustomerId,
            });
            remainingBatchAmount = Math.max(
              0,
              Math.round((remainingBatchAmount - invoiceAmount) * 100) / 100,
            );
          }
        }

        // Sort target invoices descending so we allocate the largest invoices first
        targets.sort((a, b) => b.amount - a.amount);

        // Track remaining quantities
        const remainingQty = new Map<string, number>();
        for (const prod of batch.products) {
          remainingQty.set(
            prod.product_id,
            monthlyQuantities.get(prod.product_id) || 0,
          );
        }

        // Allocate quantities to each target invoice
        for (let i = 0; i < targets.length; i++) {
          const tgt = targets[i];
          const invoiceAmount = tgt.amount;
          const L = targets.length - i; // remaining invoices

          const dayOffset = Math.floor(Math.random() * numberOfDays);
          const currentDate = new Date(startDate);
          currentDate.setDate(startDate.getDate() + dayOffset);
          const invoiceDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

          const invoiceProducts: any[] = [];

          const activeProds = batch.products.filter(
            (p) => (remainingQty.get(p.product_id) || 0) > 0,
          );
          if (activeProds.length === 0) {
            throw new Error("No products left to allocate");
          }

          // Calculate target quantity for each active product in this invoice
          const targetsForProds = activeProds.map((p) => {
            const rem = remainingQty.get(p.product_id) || 0;
            // Gradually consume remaining pool: divide by remaining invoices count L
            let targetQ = rem / L;

            // Apply rules constraints
            const minQ = parseFloat(p.perDayQtyMin);
            const maxQ = parseFloat(p.perDayQtyMax);

            if (L === 1) {
              targetQ = rem;
            } else {
              targetQ = Math.max(minQ, Math.min(maxQ, targetQ));
            }
            targetQ = Math.min(targetQ, rem);
            return {
              product: p,
              targetQ,
              rate: rates.get(p.product_id) || 0,
            };
          });

          const totalTargetVal = targetsForProds.reduce(
            (sum, item) => sum + item.targetQ * item.rate,
            0,
          );

          // Scale allocations to match invoiceAmount
          const allocations = targetsForProds.map((item) => {
            let val = 0;
            if (totalTargetVal > 0) {
              val =
                ((item.targetQ * item.rate) / totalTargetVal) * invoiceAmount;
            } else {
              val = invoiceAmount / targetsForProds.length;
            }
            return Math.round(val * 100) / 100;
          });

          // Convert allocations to quantities while respecting rules limits
          const finalQtys = targetsForProds.map((item, idx) => {
            const val = allocations[idx];
            let qty = Math.round((val / item.rate) * 100) / 100;
            const minQ = parseFloat(item.product.perDayQtyMin);
            const maxQ = parseFloat(item.product.perDayQtyMax);
            const rem = remainingQty.get(item.product.product_id) || 0;

            if (L === 1) {
              qty = rem;
            } else {
              qty = Math.max(minQ, Math.min(maxQ, qty));
            }
            qty = Math.min(qty, rem);
            return Math.round(qty * 100) / 100;
          });

          // Construct product rows
          targetsForProds.forEach((item, idx) => {
            const qty = finalQtys[idx];
            if (qty > 0) {
              invoiceProducts.push({
                product_id: item.product.product_id,
                product_name: item.product.product_name,
                hsn_code: item.product.hsn_code,
                unit_of_measure: item.product.unit_of_measure,
                quantity: qty,
                rate: item.rate,
                amount: Math.round(qty * item.rate * 100) / 100,
              });
              remainingQty.set(
                item.product.product_id,
                Math.max(
                  0,
                  Math.round(
                    (remainingQty.get(item.product.product_id)! - qty) * 100,
                  ) / 100,
                ),
              );
            }
          });

          const prefix = batch.batch_type === "PURCHASE" ? "PI" : "INV";
          const invoiceNumber = `${prefix}-${currentDate.getFullYear()}-${String(
            currentDate.getMonth() + 1,
          ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(
            2,
            "0",
          )}-${String(invoiceCounter).padStart(4, "0")}`;

          const productsWithCustomerId = invoiceProducts.map((p) => ({
            ...p,
            customer_id: tgt.customerId,
          }));

          const exactTotal =
            Math.round(
              productsWithCustomerId.reduce((sum, p) => sum + p.amount, 0) *
                100,
            ) / 100;

          // Adjust last invoice product amount to match target invoice amount exactly
          let diffVal = Math.round((invoiceAmount - exactTotal) * 100) / 100;
          if (Math.abs(diffVal) > 0.01 && productsWithCustomerId.length > 0) {
            const lastP =
              productsWithCustomerId[productsWithCustomerId.length - 1];
            lastP.amount = Math.round((lastP.amount + diffVal) * 100) / 100;
            lastP.rate =
              Math.round((lastP.amount / lastP.quantity) * 1000) / 1000;
          }

          const finalExactTotal =
            Math.round(
              productsWithCustomerId.reduce((sum, p) => sum + p.amount, 0) *
                100,
            ) / 100;

          invoices.push({
            invoice_batch_id: batch.id,
            invoice_number: invoiceNumber,
            invoice_date: invoiceDate,
            products: productsWithCustomerId,
            total_amount: finalExactTotal,
            status: "generated",
            batch_type: batch.batch_type,
          });

          invoiceCounter++;
        }

        // Final absolute total drift correction across all invoices
        const totalGeneratedAmount = invoices.reduce(
          (sum, inv) => sum + inv.total_amount,
          0,
        );
        const finalDrift =
          Math.round((totalAmount - totalGeneratedAmount) * 100) / 100;
        if (Math.abs(finalDrift) > 0.01 && invoices.length > 0) {
          const lastInv = invoices[invoices.length - 1];
          if (lastInv.products.length > 0) {
            const lastProd = lastInv.products[lastInv.products.length - 1];
            lastProd.amount =
              Math.round((lastProd.amount + finalDrift) * 100) / 100;
            lastProd.rate =
              Math.round((lastProd.amount / lastProd.quantity) * 1000) / 1000;
            lastInv.total_amount =
              Math.round(
                lastInv.products.reduce(
                  (sum: number, p: any) => sum + p.amount,
                  0,
                ) * 100,
              ) / 100;
          }
        }

        return invoices;
      } catch (err) {
        // Retry loop
      }
    }

    throw new Error(
      `Failed to generate purchase invoices after ${maxAttempts} attempts due to constraints mismatch. Please check that total amount and rate/quantity rules are compatible.`,
    );
  }
}
