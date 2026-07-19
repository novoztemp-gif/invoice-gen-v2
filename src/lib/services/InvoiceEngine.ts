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
  occurrencePercentage?: number | null;
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
   * Dynamically calculate carry-forward stock from the previous finalized Purchase Batch
   */
  public static async getCarryForwardStock(
    supabase: SupabaseClient,
    currentBatchFromDate: string,
  ): Promise<Map<string, number>> {
    const carryForwardMap = new Map<string, number>();

    // 1. Find the latest finalized purchase batch before currentBatchFromDate
    const { data: prevBatch } = await supabase
      .from("invoice_batch")
      .select("id")
      .eq("batch_type", "PURCHASE")
      .eq("batch_status", "FINALIZED")
      .lt("invoice_date_to", currentBatchFromDate)
      .order("invoice_date_to", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!prevBatch) {
      return carryForwardMap;
    }

    // 2. Load the daily stock ledger rows for this previous batch
    const { data: ledgerRows } = await supabase
      .from("daily_stock_ledger")
      .select(
        "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
      )
      .eq("purchase_batch_id", prevBatch.id)
      .order("ledger_date", { ascending: true });

    if (!ledgerRows || ledgerRows.length === 0) {
      return carryForwardMap;
    }

    // 3. Compute dynamic carry forward for the previous batch
    const productGroups = new Map<string, any[]>();
    for (const row of ledgerRows) {
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
        carryForward = Math.max(0, opening + purchased - sold);
      }

      carryForwardMap.set(productId, carryForward);
    }

    return carryForwardMap;
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
      invoices = this.generatePurchaseInvoiceSplitupsInternal(
        typedBatch,
        numberOfDays,
        fromDate,
        startingCounter,
      );
    } else {
      let availableStockMap: Map<string, any> | null = null;
      if (typedBatch.stock_source_batch_id) {
        const { data: ledgerData, error: ledgerError } = await supabase
          .from("daily_stock_ledger")
          .select(
            "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          .eq("purchase_batch_id", typedBatch.stock_source_batch_id)
          .order("ledger_date", { ascending: true });

        if (ledgerError) {
          throw new Error(
            `Failed to load daily stock ledger: ${ledgerError.message}`,
          );
        }

        availableStockMap = new Map<string, any>();
        const productGroups = new Map<string, any[]>();
        for (const row of ledgerData || []) {
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
    } else if (typedBatch.batch_type === "PURCHASE") {
      const dailyQtyMap = new Map<string, number>();

      for (const inv of invoices) {
        for (const p of inv.products) {
          const key = `${inv.invoice_date}_${p.product_id}`;
          dailyQtyMap.set(key, (dailyQtyMap.get(key) || 0) + p.quantity);
        }
      }

      // 1. Fetch carry-forward stock from previous finalized purchase batch
      const carryForwardStock = await this.getCarryForwardStock(
        supabase,
        typedBatch.invoice_date_from,
      );

      // 2. Identify the chronologically first date for each product to apply carry-forward
      const productFirstDates = new Map<string, string>();
      for (const [key, qty] of dailyQtyMap.entries()) {
        const [date, product_id] = key.split("_");
        const existingFirst = productFirstDates.get(product_id);
        if (!existingFirst || date.localeCompare(existingFirst) < 0) {
          productFirstDates.set(product_id, date);
        }
      }

      const ledgerRecords = [];
      for (const [key, qty] of dailyQtyMap.entries()) {
        const [date, product_id] = key.split("_");
        const isFirstDate = productFirstDates.get(product_id) === date;
        const carryForward = isFirstDate
          ? carryForwardStock.get(product_id) || 0
          : 0;

        ledgerRecords.push({
          purchase_batch_id: batchId,
          ledger_date: date,
          product_id: product_id,
          opening_stock: carryForward,
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

      // Invoke transactional save RPC for PURCHASE batches
      const { data: rpcSuccess, error: rpcError } = await supabase.rpc(
        "save_purchase_batch_transactional",
        {
          batch_id: batchId,
          invoices_payload: invoices,
          ledger_payload: ledgerRecords,
        },
      );

      if (rpcError || !rpcSuccess) {
        throw new Error(
          `Failed to save purchase batch atomically: ${rpcError?.message || "RPC failure"}`,
        );
      }
    } else {
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
      if (availableStockMap) {
        // Find the earliest ledger entry for this product to get day-1 opening
        const firstKey = `${dateList[0]}_${prodConfig.product_id}`;
        // The ledger key stores "available after previous sales" – we treat it
        // as the opening of day 0 here; the loop below will re-derive it properly.
        runningRemaining.set(prodConfig.product_id, 0);
      } else {
        runningRemaining.set(prodConfig.product_id, 0);
      }
    }

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

        // Business rule: Remaining ∈ [0, 15]
        const maxTargetRemaining = Math.min(15, available);
        const targetRemaining =
          Math.round(Math.random() * maxTargetRemaining * 100) / 100;

        let qtyToSell = Math.max(
          0,
          Math.round((available - targetRemaining) * 100) / 100,
        );

        let actualRemaining = Math.round((available - qtyToSell) * 100) / 100;

        const initialProposedSold = qtyToSell;
        const initialRemaining = actualRemaining;

        // Perform final normalization step to strictly enforce Remaining ∈ [0, 15]
        if (actualRemaining > 15) {
          qtyToSell =
            Math.round((qtyToSell + (actualRemaining - 15)) * 100) / 100;
          actualRemaining = 15;
        } else if (actualRemaining < 0) {
          qtyToSell = Math.round((qtyToSell + actualRemaining) * 100) / 100;
          actualRemaining = 0;
        }

        // Recompute to guarantee 0 <= remaining <= 15
        actualRemaining = Math.round((available - qtyToSell) * 100) / 100;

        if (
          prodConfig.product_name.toUpperCase().includes("CHICKEN") &&
          invoiceDate === "2026-07-24"
        ) {
          console.log(`
[CHICKEN LOG]
Product: ${prodConfig.product_name}
Date: ${invoiceDate}
Opening Stock: ${dayOpening}
Purchased: ${dayPurchased}
Available: ${available}
Initial Proposed Sold: ${initialProposedSold}
Initial Remaining: ${initialRemaining}
Normalized Proposed Sold: ${qtyToSell}
Normalized Remaining: ${actualRemaining}
`);
        }

        runningRemaining.set(prodConfig.product_id, actualRemaining);

        if (qtyToSell <= 0) continue;

        const minRate = parseFloat(prodConfig.perDayRateMin) || 0;
        const maxRate = parseFloat(prodConfig.perDayRateMax) || 0;
        let rate = minRate + Math.random() * (maxRate - minRate);
        rate = Math.round(rate * 100) / 100;

        const amount = Math.round(qtyToSell * rate * 100) / 100;

        productsOnDay.push({
          product_id: prodConfig.product_id,
          product_name: prodConfig.product_name,
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

      // ── Bin-pack products into invoices within [thresholdMin, thresholdMax] ──
      const dayInvoices: any[] = [];
      let currentInvoiceProducts: any[] = [];
      let currentInvoiceAmount = 0;

      const shuffledProducts = [...productsOnDay].sort(
        () => Math.random() - 0.5,
      );

      for (const p of shuffledProducts) {
        let remainingQty = p.quantity;
        while (remainingQty > 0) {
          const maxFittingQty = Math.floor(
            (thresholdMax - currentInvoiceAmount) / p.rate,
          );

          if (maxFittingQty <= 0) {
            if (currentInvoiceProducts.length > 0) {
              dayInvoices.push({
                products: currentInvoiceProducts,
                total_amount: currentInvoiceAmount,
              });
              currentInvoiceProducts = [];
              currentInvoiceAmount = 0;
            } else {
              const amt = Math.round(remainingQty * p.rate * 100) / 100;
              currentInvoiceProducts.push({
                ...p,
                quantity: remainingQty,
                amount: amt,
              });
              currentInvoiceAmount = amt;
              remainingQty = 0;
            }
            continue;
          }

          const qtyToPut = Math.min(remainingQty, maxFittingQty);
          const amt = Math.round(qtyToPut * p.rate * 100) / 100;

          currentInvoiceProducts.push({
            ...p,
            quantity: qtyToPut,
            amount: amt,
          });
          currentInvoiceAmount =
            Math.round((currentInvoiceAmount + amt) * 100) / 100;
          remainingQty -= qtyToPut;
        }
      }

      if (currentInvoiceProducts.length > 0) {
        dayInvoices.push({
          products: currentInvoiceProducts,
          total_amount: currentInvoiceAmount,
        });
      }

      // Merge last invoice into previous if it's below threshold
      if (dayInvoices.length > 1) {
        const lastInv = dayInvoices[dayInvoices.length - 1];
        if (lastInv.total_amount < thresholdMin) {
          const prevInv = dayInvoices[dayInvoices.length - 2];
          if (prevInv.total_amount + lastInv.total_amount <= thresholdMax) {
            prevInv.products.push(...lastInv.products);
            prevInv.total_amount =
              Math.round((prevInv.total_amount + lastInv.total_amount) * 100) /
              100;
            dayInvoices.pop();
          }
        }
      }

      for (const inv of dayInvoices) {
        let assignedCustomerId = null;
        const eligibleMajor = majorTracking.find(
          (m) => m.remainingInvoices > 0,
        );
        if (eligibleMajor) {
          assignedCustomerId = eligibleMajor.customer_id;
          eligibleMajor.remainingInvoices--;
          eligibleMajor.remainingAmount =
            Math.round(
              (eligibleMajor.remainingAmount - inv.total_amount) * 100,
            ) / 100;
        } else if (selectedCustomers.length > 0) {
          const randomCustomerIndex = Math.floor(
            Math.random() * selectedCustomers.length,
          );
          assignedCustomerId = selectedCustomers[randomCustomerIndex];
        } else {
          assignedCustomerId = batch.receiving_company_id;
        }

        const prefix = batch.batch_type === "PURCHASE" ? "PI" : "INV";
        const parts = invoiceDate.split("-");
        const invoiceNumber = `${prefix}-${parts[0]}-${parts[1]}-${parts[2]}-${String(
          invoiceCounter,
        ).padStart(4, "0")}`;

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
    monthlyQuantities?: Map<string, number>,
  ) {
    const thresholdMin = batch.minimum_invoice_amount;
    const thresholdMax = batch.maximum_invoice_amount;
    const totalAmount = batch.total_amount;

    let invoiceCounter = startingCounter;
    const invoices = [];

    // 1. Gather Customers and Suppliers configurations
    let selectedCustomers = batch.selected_customers || [];
    const majorCustomers = batch.major_customers || [];

    if (
      selectedCustomers.length === 0 &&
      majorCustomers.length === 0 &&
      batch.receiving_company_id
    ) {
      selectedCustomers = [batch.receiving_company_id];
    }

    // 2. Prepare target invoice budgets and customer assignments
    const targets: Array<{ amount: number; customerId: string }> = [];

    // Handle Major Customers/Suppliers
    for (const major of majorCustomers) {
      if (!major.customer_id || major.invoice_count < 1 || major.amount <= 0)
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

    // Handle Regular Customers/Suppliers
    const majorTotal = majorCustomers.reduce((s, m) => s + (m.amount || 0), 0);
    const remainingBatchAmount =
      Math.round((totalAmount - majorTotal) * 100) / 100;

    if (remainingBatchAmount > 0.01 && selectedCustomers.length > 0) {
      // Estimate realistic regular invoice count
      const avgThreshold = (thresholdMin + thresholdMax) / 2;
      let N_rem = Math.round(remainingBatchAmount / avgThreshold);
      const N_min = Math.ceil(remainingBatchAmount / thresholdMax);
      const N_max = Math.floor(remainingBatchAmount / thresholdMin);
      N_rem = Math.max(N_min, Math.min(N_max, N_rem));
      if (N_rem < 1) N_rem = 1;

      // Split remainingBatchAmount into N_rem budgets
      const budgets: number[] = [];
      let remAmt = remainingBatchAmount;
      for (let i = 0; i < N_rem; i++) {
        budgets.push(thresholdMin);
        remAmt -= thresholdMin;
      }

      const maxAddPerInvoice = thresholdMax - thresholdMin;
      for (let i = 0; i < N_rem - 1; i++) {
        const minAdd = Math.max(0, remAmt - (N_rem - 1 - i) * maxAddPerInvoice);
        const maxAdd = Math.min(remAmt, maxAddPerInvoice);
        const add = minAdd + Math.random() * (maxAdd - minAdd);
        const roundedAdd = Math.round(add * 100) / 100;
        budgets[i] = Math.round((budgets[i] + roundedAdd) * 100) / 100;
        remAmt = Math.round((remAmt - roundedAdd) * 100) / 100;
      }
      budgets[N_rem - 1] =
        Math.round((budgets[N_rem - 1] + remAmt) * 100) / 100;

      // Assign regular budgets to random customers
      for (const amt of budgets) {
        const randomCustomerIndex = Math.floor(
          Math.random() * selectedCustomers.length,
        );
        targets.push({
          amount: amt,
          customerId: selectedCustomers[randomCustomerIndex],
        });
      }
    }

    // 3. Generate Invoices
    for (let i = 0; i < targets.length; i++) {
      const tgt = targets[i];
      const invoiceAmount = tgt.amount;

      const dayOffset = Math.floor(Math.random() * numberOfDays);
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + dayOffset);
      const invoiceDate = `${currentDate.getFullYear()}-${String(
        currentDate.getMonth() + 1,
      ).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

      // Pick subset of products randomly influenced by occurrence percentage
      let subset: ProductConfig[] = [];
      let attempt = 0;
      while (attempt < 100) {
        attempt++;
        const candidate: ProductConfig[] = [];
        for (const prod of batch.products) {
          const prob =
            prod.occurrencePercentage !== undefined &&
            prod.occurrencePercentage !== null
              ? Number(prod.occurrencePercentage)
              : 50; // Default random selection probability
          if (Math.random() * 100 <= prob) {
            candidate.push(prod);
          }
        }
        if (candidate.length === 0) {
          candidate.push(
            batch.products[Math.floor(Math.random() * batch.products.length)],
          );
        }

        const minSum = candidate.reduce(
          (sum, p) =>
            sum + parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin),
          0,
        );
        const maxSum = candidate.reduce(
          (sum, p) =>
            sum + parseFloat(p.perDayQtyMax) * parseFloat(p.perDayRateMax),
          0,
        );

        if (minSum <= invoiceAmount && invoiceAmount <= maxSum) {
          subset = candidate;
          break;
        }
      }

      // Fallback if random search failed
      if (subset.length === 0) {
        const sorted = [...batch.products].sort((a, b) => {
          const minA = parseFloat(a.perDayQtyMin) * parseFloat(a.perDayRateMin);
          const minB = parseFloat(b.perDayQtyMin) * parseFloat(b.perDayRateMin);
          return minA - minB;
        });

        const candidate = [];
        let currentMin = 0;
        for (const p of sorted) {
          const pMin = parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin);
          if (currentMin + pMin <= invoiceAmount || candidate.length === 0) {
            candidate.push(p);
            currentMin += pMin;
          } else {
            break;
          }
        }
        subset = candidate;
      }

      // Generate rates and quantities for the selected products
      const minSum = subset.reduce(
        (sum, p) =>
          sum + parseFloat(p.perDayQtyMin) * parseFloat(p.perDayRateMin),
        0,
      );
      const maxSum = subset.reduce(
        (sum, p) =>
          sum + parseFloat(p.perDayQtyMax) * parseFloat(p.perDayRateMax),
        0,
      );

      const f =
        maxSum > minSum
          ? Math.max(
              0,
              Math.min(1, (invoiceAmount - minSum) / (maxSum - minSum)),
            )
          : 0;
      const invoiceProducts: any[] = [];

      for (const p of subset) {
        const minQ = parseFloat(p.perDayQtyMin);
        const maxQ = parseFloat(p.perDayQtyMax);
        const minR = parseFloat(p.perDayRateMin);
        const maxR = parseFloat(p.perDayRateMax);

        // Target value for this product
        const pMinVal = minQ * minR;
        const pMaxVal = maxQ * maxR;
        const targetVal = pMinVal + f * (pMaxVal - pMinVal);

        // Generate random rate within bounds
        const randomRate = minR + Math.random() * (maxR - minR);
        const rate = Math.round(randomRate * 100) / 100;

        // Calculate quantity to match targetVal
        let qty = Math.round((targetVal / rate) * 100) / 100;
        qty = Math.max(minQ, Math.min(maxQ, qty));
        qty = Math.round(qty * 100) / 100;

        invoiceProducts.push({
          product_id: p.product_id,
          product_name: p.product_name,
          hsn_code: p.hsn_code,
          unit_of_measure: p.unit_of_measure,
          quantity: qty,
          rate,
          amount: Math.round(qty * rate * 100) / 100,
        });
      }

      // Align drift naturally across products in random order
      let drift =
        Math.round(
          (invoiceAmount -
            invoiceProducts.reduce((sum, p) => sum + p.amount, 0)) *
            100,
        ) / 100;
      if (Math.abs(drift) > 0.01 && invoiceProducts.length > 0) {
        // Shuffle indices to ensure natural selection order
        const indices = Array.from(
          { length: invoiceProducts.length },
          (_, i) => i,
        );
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        for (const idx of indices) {
          if (Math.abs(drift) <= 0.01) break;

          const p = invoiceProducts[idx];
          const config = subset.find((pd) => pd.product_id === p.product_id)!;
          const minRate = parseFloat(config.perDayRateMin);
          const maxRate = parseFloat(config.perDayRateMax);
          const qty = p.quantity;
          if (qty <= 0) continue;

          if (drift > 0) {
            // Need to increase the amount
            const maxPossibleAmt = Math.round(qty * maxRate * 100) / 100;
            const room = Math.max(
              0,
              Math.round((maxPossibleAmt - p.amount) * 100) / 100,
            );
            if (room > 0.01) {
              const toAdd = Math.round(Math.min(drift, room) * 100) / 100;
              p.amount = Math.round((p.amount + toAdd) * 100) / 100;
              p.rate = Math.round((p.amount / qty) * 100) / 100;
              drift = Math.round((drift - toAdd) * 100) / 100;
            }
          } else {
            // Need to decrease the amount
            const minPossibleAmt = Math.round(qty * minRate * 100) / 100;
            const room = Math.max(
              0,
              Math.round((p.amount - minPossibleAmt) * 100) / 100,
            );
            if (room > 0.01) {
              const toSub =
                Math.round(Math.min(Math.abs(drift), room) * 100) / 100;
              p.amount = Math.round((p.amount - toSub) * 100) / 100;
              p.rate = Math.round((p.amount / qty) * 100) / 100;
              drift = Math.round((drift + toSub) * 100) / 100;
            }
          }
        }

        // If there's still a tiny rounding drift left, absorb it on the first available product
        if (Math.abs(drift) > 0.01) {
          for (const idx of indices) {
            const p = invoiceProducts[idx];
            const config = subset.find((pd) => pd.product_id === p.product_id)!;
            const minR = parseFloat(config.perDayRateMin);
            const maxR = parseFloat(config.perDayRateMax);

            const targetAmt = Math.round((p.amount + drift) * 100) / 100;
            const targetRate = Math.round((targetAmt / p.quantity) * 100) / 100;

            if (targetRate >= minR && targetRate <= maxR) {
              p.amount = targetAmt;
              p.rate = targetRate;
              drift = 0;
              break;
            }
          }
        }
      }

      const finalExactTotal = invoiceProducts.reduce(
        (sum, p) => sum + p.amount,
        0,
      );
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

      let qty = 0;
      if (minQty <= maxQty) {
        qty = Math.round(minQty + Math.random() * (maxQty - minQty));
      } else {
        qty = Math.round(maxQty);
      }
      qty = Math.max(
        0,
        Math.min(Math.floor(item.config.currentAvailable), qty),
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
