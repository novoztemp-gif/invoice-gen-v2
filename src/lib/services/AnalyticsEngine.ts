import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";

export interface AnalyticsFilter {
  financialYear?: string;
  startDate?: string;
  endDate?: string;
  purchaseBatchId?: string;
  salesBatchId?: string;
  productId?: string;
  customerId?: string;
}

export interface ExecutiveMetrics {
  totalRevenue: number;
  totalPurchaseValue: number;
  totalExpenseValue: number;
  grossProfit: number;
  netProfit: number;
  inventoryValue: number;
  activePurchaseBatchesCount: number;
  activeSalesBatchesCount: number;
  monthlyRevenue: { month: string; amount: number }[];
  purchaseVsSalesTrend: { month: string; purchase: number; sales: number }[];
  profitTrend: { month: string; grossProfit: number; netProfit: number }[];
  expenseTrend: { month: string; amount: number }[];
  recentPurchaseBatches: any[];
  recentSalesBatches: any[];
  recentExpenses: any[];
  lowStockProducts: any[];
  outOfStockProducts: any[];
  purchaseBatchesAwaitingSales: any[];
  salesBatchesAwaitingCompletion: any[];
}

export interface PurchaseBatchInventoryRow {
  id: string;
  batch_number: string;
  purchase_date: string;
  products_count: number;
  qty_purchased: number;
  qty_sold: number;
  qty_remaining: number;
  status: "New" | "Active" | "Completed";
}

export interface CarryForwardInventoryRow {
  monthKey: string;
  month: string;
  remaining_qty: number;
  status: string;
}

export interface ProductLedgerRow {
  product_id: string;
  product_name: string;
  unit: string;
  opening_stock: number;
  purchased_qty: number;
  sold_qty: number;
  closing_stock: number;
}

export interface InventoryMovementRow {
  id: string;
  date: string;
  reference: string;
  product_name: string;
  purchased_qty: number;
  sold_qty: number;
  remaining_qty: number;
}

export interface InventoryMetrics {
  totalCurrentStock: number;
  totalStockValue: number;
  activePurchaseBatchesCount: number;
  carryForwardStock: number;
  totalProductsCount: number;
  outOfStockProductsCount: number;
  purchaseBatchRows: PurchaseBatchInventoryRow[];
  carryForwardRows: CarryForwardInventoryRow[];
  productLedgerRows: ProductLedgerRow[];
  movementLogs: InventoryMovementRow[];
}

export interface PurchaseMetrics {
  totalPurchaseValue: number;
  purchaseBatchCount: number;
  totalProductsPurchasedQty: number;
  avgBatchValue: number;
  avgInvoiceValue: number;
  monthlyPurchases: { month: string; amount: number }[];
  purchaseTrend: { month: string; amount: number }[];
  supplierPurchases: { supplier_name: string; amount: number }[];
  productPurchases: { product_name: string; amount: number; qty: number }[];
  recentBatches: any[];
  largestBatches: any[];
}

export interface SalesMetrics {
  totalSalesValue: number;
  salesBatchCount: number;
  totalInvoicesCount: number;
  avgInvoiceValue: number;
  customersServedCount: number;
  monthlySales: { month: string; amount: number }[];
  customerSales: { customer_name: string; amount: number }[];
  productSales: { product_name: string; amount: number; qty: number }[];
  salesTrend: { month: string; amount: number }[];
  recentSalesBatches: any[];
  highestValueCustomers: {
    customer_name: string;
    amount: number;
    invoices_count: number;
  }[];
}

export interface ExpenseMetrics {
  totalExpenses: number;
  expenseCategoriesCount: number;
  monthlyExpenses: { month: string; amount: number }[];
  avgExpensePerBatch: number;
  expenseTrend: { month: string; amount: number }[];
  categoryDistribution: { category: string; amount: number }[];
  recentExpenses: any[];
  largestExpenses: any[];
}

export interface ProfitLossMetrics {
  revenue: number;
  purchaseCost: number;
  expenses: number;
  grossProfit: number;
  netProfit: number;
  profitMarginPct: number;
  revenueVsExpenses: { month: string; revenue: number; expenses: number }[];
  profitTrend: { month: string; grossProfit: number; netProfit: number }[];
  monthlyProfit: { month: string; netProfit: number }[];
  monthlyPnLSummary: {
    month: string;
    revenue: number;
    purchaseCost: number;
    expenses: number;
    grossProfit: number;
    netProfit: number;
    marginPct: number;
  }[];
}

const MONTH_NAMES = [
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

export class AnalyticsEngine {
  /**
   * Helper to format YYYY-MM into Month YYYY label
   */
  private static formatMonthLabel(yearMonth: string): string {
    if (!yearMonth) return "N/A";
    const parts = yearMonth.split("-");
    if (parts.length < 2) return yearMonth;
    const year = parts[0];
    const month = parts[1];
    const monthIdx = parseInt(month, 10) - 1;
    return `${MONTH_NAMES[monthIdx] || month} ${year}`;
  }

  /**
   * Fetch master filter options (Years, Batches, Products, Customers)
   */
  static async getFilterOptions(supabase: SupabaseClient) {
    const [
      { data: batches },
      { data: products },
      { data: receivingCompanies },
    ] = await Promise.all([
      supabase
        .from("invoice_batch")
        .select("id, batch_type, financial_year, created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("products")
        .select("id, product_name")
        .order("product_name", { ascending: true }),
      supabase
        .from("receiving_companies")
        .select("id, company_name")
        .order("company_name", { ascending: true }),
    ]);

    const financialYears = Array.from(
      new Set((batches || []).map((b) => b.financial_year).filter(Boolean)),
    ).sort();

    const purchaseBatches = (batches || []).filter(
      (b) => b.batch_type === "PURCHASE",
    );
    const salesBatches = (batches || []).filter(
      (b) => b.batch_type === "SALES" || !b.batch_type,
    );

    return {
      financialYears,
      purchaseBatches,
      salesBatches,
      products: products || [],
      customers: receivingCompanies || [],
    };
  }

  /**
   * 1. Executive Dashboard Data
   */
  static async getExecutiveMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<ExecutiveMetrics> {
    const [
      { data: batches },
      invoices,
      ledgerRows,
      { data: expenseBatches },
      { data: expenseLedger },
      { data: products },
    ] = await Promise.all([
      supabase.from("invoice_batch").select("*"),
      fetchAllQueryRows((from, to) =>
        supabase.from("invoice").select("*").range(from, to),
      ),
      fetchAllQueryRows((from, to) =>
        supabase.from("daily_stock_ledger").select("*").range(from, to),
      ),
      supabase.from("expense_batch").select("*"),
      supabase.from("expense_daily_ledger").select("*"),
      supabase.from("products").select("*"),
    ]);

    // Apply basic filtering to batches
    let salesBatches = (batches || []).filter(
      (b) => b.batch_type === "SALES" || !b.batch_type,
    );
    let purchaseBatches = (batches || []).filter(
      (b) => b.batch_type === "PURCHASE",
    );
    let expBatches = expenseBatches || [];

    if (filter.financialYear && filter.financialYear !== "All") {
      salesBatches = salesBatches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
      purchaseBatches = purchaseBatches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
      expBatches = expBatches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
    }

    if (filter.purchaseBatchId && filter.purchaseBatchId !== "All") {
      purchaseBatches = purchaseBatches.filter(
        (b) => b.id === filter.purchaseBatchId,
      );
    }
    if (filter.salesBatchId && filter.salesBatchId !== "All") {
      salesBatches = salesBatches.filter((b) => b.id === filter.salesBatchId);
    }

    const salesBatchIds = new Set(salesBatches.map((b) => b.id));
    const purchaseBatchIds = new Set(purchaseBatches.map((b) => b.id));

    let filteredInvoices = (invoices || []).filter(
      (inv) =>
        salesBatchIds.has(inv.invoice_batch_id) ||
        purchaseBatchIds.has(inv.invoice_batch_id),
    );

    if (filter.startDate) {
      filteredInvoices = filteredInvoices.filter(
        (inv) => inv.invoice_date >= filter.startDate!,
      );
    }
    if (filter.endDate) {
      filteredInvoices = filteredInvoices.filter(
        (inv) => inv.invoice_date <= filter.endDate!,
      );
    }

    const totalRevenue = filteredInvoices
      .filter((inv) => salesBatchIds.has(inv.invoice_batch_id))
      .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);

    const totalPurchaseValue = purchaseBatches.reduce(
      (sum, b) => sum + Number(b.total_amount || 0),
      0,
    );

    let filteredExpLedger = expenseLedger || [];
    if (filter.startDate) {
      filteredExpLedger = filteredExpLedger.filter(
        (e) => e.expense_date >= filter.startDate!,
      );
    }
    if (filter.endDate) {
      filteredExpLedger = filteredExpLedger.filter(
        (e) => e.expense_date <= filter.endDate!,
      );
    }
    const totalExpenseValue = filteredExpLedger.reduce(
      (sum, e) => sum + Number(e.amount || 0),
      0,
    );

    const grossProfit = totalRevenue - totalPurchaseValue;
    const netProfit = grossProfit - totalExpenseValue;

    // Inventory Value (Latest remaining stock * average product unit price)
    const productPriceMap = new Map<string, number>(
      (products || []).map((p) => [p.id, Number(p.unit_price || 100)]),
    );

    const latestStockMap = new Map<string, number>();
    for (const row of ledgerRows || []) {
      const currentPurchased = Number(row.purchased_quantity || 0);
      const currentSold = Number(row.sold_quantity || 0);
      const opening = Number(row.opening_stock || 0);
      const remaining = Math.max(0, opening + currentPurchased - currentSold);
      latestStockMap.set(row.product_id, remaining);
    }

    let inventoryValue = 0;
    for (const [prodId, remQty] of latestStockMap.entries()) {
      const price = productPriceMap.get(prodId) || 100;
      inventoryValue += remQty * price;
    }

    const activePurchaseBatchesCount = purchaseBatches.filter(
      (b) => b.batch_status !== "FINALIZED",
    ).length;
    const activeSalesBatchesCount = salesBatches.filter(
      (b) => b.batch_status !== "FINALIZED",
    ).length;

    // Monthly trends
    const monthGroupMap = new Map<
      string,
      { revenue: number; purchase: number; expense: number }
    >();

    for (const inv of filteredInvoices) {
      if (!inv.invoice_date) continue;
      const monthKey = inv.invoice_date.slice(0, 7);
      if (!monthGroupMap.has(monthKey)) {
        monthGroupMap.set(monthKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      const g = monthGroupMap.get(monthKey)!;
      if (salesBatchIds.has(inv.invoice_batch_id)) {
        g.revenue += Number(inv.total_amount || 0);
      }
    }

    for (const b of purchaseBatches) {
      if (!b.invoice_date_from) continue;
      const monthKey = b.invoice_date_from.slice(0, 7);
      if (!monthGroupMap.has(monthKey)) {
        monthGroupMap.set(monthKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      const g = monthGroupMap.get(monthKey)!;
      g.purchase += Number(b.total_amount || 0);
    }

    for (const e of filteredExpLedger) {
      if (!e.expense_date) continue;
      const monthKey = e.expense_date.slice(0, 7);
      if (!monthGroupMap.has(monthKey)) {
        monthGroupMap.set(monthKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      const g = monthGroupMap.get(monthKey)!;
      g.expense += Number(e.amount || 0);
    }

    const sortedMonths = Array.from(monthGroupMap.keys()).sort();

    const monthlyRevenue = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      amount: Math.round(monthGroupMap.get(m)!.revenue),
    }));

    const purchaseVsSalesTrend = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      purchase: Math.round(monthGroupMap.get(m)!.purchase),
      sales: Math.round(monthGroupMap.get(m)!.revenue),
    }));

    const profitTrend = sortedMonths.map((m) => {
      const rev = monthGroupMap.get(m)!.revenue;
      const pur = monthGroupMap.get(m)!.purchase;
      const exp = monthGroupMap.get(m)!.expense;
      const gProf = rev - pur;
      return {
        month: this.formatMonthLabel(m),
        grossProfit: Math.round(gProf),
        netProfit: Math.round(gProf - exp),
      };
    });

    const expenseTrend = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      amount: Math.round(monthGroupMap.get(m)!.expense),
    }));

    // Stock Alerts
    const productNameMap = new Map<string, string>(
      (products || []).map((p) => [p.id, p.product_name]),
    );
    const productUnitMap = new Map<string, string>(
      (products || []).map((p) => [p.id, p.unit_of_measure || "kg"]),
    );

    const lowStockProducts: any[] = [];
    const outOfStockProducts: any[] = [];

    for (const [prodId, remQty] of latestStockMap.entries()) {
      const prodName = productNameMap.get(prodId) || "Unknown";
      const unit = productUnitMap.get(prodId) || "kg";

      if (remQty <= 0.001) {
        outOfStockProducts.push({
          prodId,
          product_name: prodName,
          remaining_stock: 0,
          unit,
        });
      } else if (remQty <= 15) {
        lowStockProducts.push({
          prodId,
          product_name: prodName,
          remaining_stock: remQty,
          unit,
        });
      }
    }

    // Purchase Batches awaiting sales
    const purchaseBatchesAwaitingSales = purchaseBatches.filter((p) => {
      const hasLinkedSales = salesBatches.some(
        (s) => s.stock_source_batch_id === p.id,
      );
      return !hasLinkedSales;
    });

    // Sales Batches awaiting completion
    const salesBatchesAwaitingCompletion = salesBatches.filter(
      (s) => s.batch_status !== "FINALIZED",
    );

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalPurchaseValue: Math.round(totalPurchaseValue * 100) / 100,
      totalExpenseValue: Math.round(totalExpenseValue * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      inventoryValue: Math.round(inventoryValue * 100) / 100,
      activePurchaseBatchesCount,
      activeSalesBatchesCount,
      monthlyRevenue,
      purchaseVsSalesTrend,
      profitTrend,
      expenseTrend,
      recentPurchaseBatches: purchaseBatches.slice(0, 5),
      recentSalesBatches: salesBatches.slice(0, 5),
      recentExpenses: (expenseBatches || []).slice(0, 5),
      lowStockProducts,
      outOfStockProducts,
      purchaseBatchesAwaitingSales: purchaseBatchesAwaitingSales.slice(0, 5),
      salesBatchesAwaitingCompletion: salesBatchesAwaitingCompletion.slice(
        0,
        5,
      ),
    };
  }

  /**
   * 2. Operational Inventory Dashboard Data (No Graphs/Utilization Pct)
   */
  static async getInventoryMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<InventoryMetrics> {
    const [{ data: products }, ledgerRows, { data: batches }] =
      await Promise.all([
        supabase.from("products").select("*"),
        fetchAllQueryRows((from, to) =>
          supabase.from("daily_stock_ledger").select("*").range(from, to),
        ),
        supabase.from("invoice_batch").select("*").eq("batch_type", "PURCHASE"),
      ]);

    const allProducts = products || [];
    const allLedger = ledgerRows || [];
    const purchaseBatches = batches || [];

    const productNameMap = new Map<string, string>(
      allProducts.map((p) => [p.id, p.product_name]),
    );
    const productPriceMap = new Map<string, number>(
      allProducts.map((p) => [p.id, Number(p.unit_price || 100)]),
    );
    const productUnitMap = new Map<string, string>(
      allProducts.map((p) => [p.id, p.unit_of_measure || "kg"]),
    );

    // Group ledger by product
    const productLedgerMap = new Map<
      string,
      { opening: number; purchased: number; sold: number }
    >();

    for (const p of allProducts) {
      productLedgerMap.set(p.id, { opening: 0, purchased: 0, sold: 0 });
    }

    for (const r of allLedger) {
      const item = productLedgerMap.get(r.product_id) || {
        opening: 0,
        purchased: 0,
        sold: 0,
      };
      if (item.opening === 0 && Number(r.opening_stock) > 0) {
        item.opening = Number(r.opening_stock || 0);
      }
      item.purchased += Number(r.purchased_quantity || 0);
      item.sold += Number(r.sold_quantity || 0);
      productLedgerMap.set(r.product_id, item);
    }

    let totalCurrentStock = 0;
    let totalStockValue = 0;
    let carryForwardStock = 0;
    let outOfStockProductsCount = 0;

    const productLedgerRows: ProductLedgerRow[] = Array.from(
      productLedgerMap.entries(),
    ).map(([prodId, item]) => {
      const closing = Math.max(0, item.opening + item.purchased - item.sold);
      const price = productPriceMap.get(prodId) || 100;

      totalCurrentStock += closing;
      totalStockValue += closing * price;
      carryForwardStock += item.opening;

      if (closing <= 0.001) {
        outOfStockProductsCount++;
      }

      return {
        product_id: prodId,
        product_name: productNameMap.get(prodId) || "Unknown Product",
        unit: productUnitMap.get(prodId) || "kg",
        opening_stock: Math.round(item.opening * 100) / 100,
        purchased_qty: Math.round(item.purchased * 100) / 100,
        sold_qty: Math.round(item.sold * 100) / 100,
        closing_stock: Math.round(closing * 100) / 100,
      };
    });

    // Purchase Batch Inventory Rows
    const batchLedgerMap = new Map<
      string,
      { purchased: number; sold: number }
    >();
    for (const r of allLedger) {
      if (!r.purchase_batch_id) continue;
      const item = batchLedgerMap.get(r.purchase_batch_id) || {
        purchased: 0,
        sold: 0,
      };
      item.purchased += Number(r.purchased_quantity || 0);
      item.sold += Number(r.sold_quantity || 0);
      batchLedgerMap.set(r.purchase_batch_id, item);
    }

    let activePurchaseBatchesCount = 0;

    const purchaseBatchRows: PurchaseBatchInventoryRow[] = purchaseBatches.map(
      (b) => {
        const item = batchLedgerMap.get(b.id) || { purchased: 0, sold: 0 };
        const qtyRemaining = Math.max(0, item.purchased - item.sold);

        let status: "New" | "Active" | "Completed" = "Active";
        if (qtyRemaining <= 0.001) {
          status = "Completed";
        } else if (item.sold <= 0.001) {
          status = "New";
          activePurchaseBatchesCount++;
        } else {
          status = "Active";
          activePurchaseBatchesCount++;
        }

        const dateFrom = b.invoice_date_from
          ? this.formatMonthLabel(b.invoice_date_from.slice(0, 7))
          : "N/A";

        return {
          id: b.id,
          batch_number: `PB-${b.id.slice(0, 8).toUpperCase()}`,
          purchase_date: dateFrom,
          products_count: (b.products || []).length,
          qty_purchased: Math.round(item.purchased * 100) / 100,
          qty_sold: Math.round(item.sold * 100) / 100,
          qty_remaining: Math.round(qtyRemaining * 100) / 100,
          status,
        };
      },
    );

    // Carry Forward Inventory by Month
    const monthlyCarryMap = new Map<string, number>();
    for (const r of allLedger) {
      if (!r.ledger_date) continue;
      const mKey = r.ledger_date.slice(0, 7);
      const cf = Number(r.opening_stock || 0);
      monthlyCarryMap.set(mKey, (monthlyCarryMap.get(mKey) || 0) + cf);
    }

    const carryForwardRows: CarryForwardInventoryRow[] = Array.from(
      monthlyCarryMap.keys(),
    )
      .sort()
      .map((mKey) => {
        const qty = monthlyCarryMap.get(mKey) || 0;
        return {
          monthKey: mKey,
          month: this.formatMonthLabel(mKey),
          remaining_qty: Math.round(qty * 100) / 100,
          status:
            qty <= 0.001
              ? "Depleted / Consumed"
              : `Available Stock for ${this.formatMonthLabel(mKey)}`,
        };
      });

    // Inventory Movement Logs (Chronological History)
    const sortedLedger = [...allLedger].sort((a, b) =>
      (a.ledger_date || "").localeCompare(b.ledger_date || ""),
    );

    const movementLogs: InventoryMovementRow[] = sortedLedger
      .slice(-30)
      .map((r) => {
        const pQty = Number(r.purchased_quantity || 0);
        const sQty = Number(r.sold_quantity || 0);
        const open = Number(r.opening_stock || 0);
        const rem = Math.max(0, open + pQty - sQty);

        const ref = r.purchase_batch_id
          ? `PB-${r.purchase_batch_id.slice(0, 8).toUpperCase()}`
          : "System Ledger";

        return {
          id: r.id || `${r.ledger_date}_${r.product_id}`,
          date: r.ledger_date || "N/A",
          reference: ref,
          product_name: productNameMap.get(r.product_id) || "Unknown Product",
          purchased_qty: Math.round(pQty * 100) / 100,
          sold_qty: Math.round(sQty * 100) / 100,
          remaining_qty: Math.round(rem * 100) / 100,
        };
      });

    return {
      totalCurrentStock: Math.round(totalCurrentStock * 100) / 100,
      totalStockValue: Math.round(totalStockValue * 100) / 100,
      activePurchaseBatchesCount,
      carryForwardStock: Math.round(carryForwardStock * 100) / 100,
      totalProductsCount: allProducts.length,
      outOfStockProductsCount,
      purchaseBatchRows,
      carryForwardRows,
      productLedgerRows,
      movementLogs,
    };
  }

  /**
   * 3. Purchase Dashboard Data
   */
  static async getPurchaseMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<PurchaseMetrics> {
    const [{ data: batches }, invoices, { data: products }] = await Promise.all(
      [
        supabase.from("invoice_batch").select("*").eq("batch_type", "PURCHASE"),
        fetchAllQueryRows((from, to) =>
          supabase.from("invoice").select("*").range(from, to),
        ),
        supabase.from("products").select("*"),
      ],
    );

    let pBatches = batches || [];
    if (filter.financialYear && filter.financialYear !== "All") {
      pBatches = pBatches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
    }
    if (filter.purchaseBatchId && filter.purchaseBatchId !== "All") {
      pBatches = pBatches.filter((b) => b.id === filter.purchaseBatchId);
    }

    const pBatchIds = new Set(pBatches.map((b) => b.id));
    const pInvoices = (invoices || []).filter((inv) =>
      pBatchIds.has(inv.invoice_batch_id),
    );

    const totalPurchaseValue = pBatches.reduce(
      (sum, b) => sum + Number(b.total_amount || 0),
      0,
    );
    const purchaseBatchCount = pBatches.length;
    const avgBatchValue =
      purchaseBatchCount > 0 ? totalPurchaseValue / purchaseBatchCount : 0;
    const avgInvoiceValue =
      pInvoices.length > 0 ? totalPurchaseValue / pInvoices.length : 0;

    let totalProductsPurchasedQty = 0;
    const prodMap = new Map<string, { amount: number; qty: number }>();

    for (const inv of pInvoices) {
      for (const p of inv.products || []) {
        const name = p.product_name || "Unknown Product";
        const qty = Number(p.quantity || 0);
        const amt = Number(p.amount || 0);
        totalProductsPurchasedQty += qty;

        if (!prodMap.has(name)) {
          prodMap.set(name, { amount: 0, qty: 0 });
        }
        const item = prodMap.get(name)!;
        item.amount += amt;
        item.qty += qty;
      }
    }

    const monthlyMap = new Map<string, number>();
    for (const b of pBatches) {
      if (!b.invoice_date_from) continue;
      const mKey = b.invoice_date_from.slice(0, 7);
      monthlyMap.set(
        mKey,
        (monthlyMap.get(mKey) || 0) + Number(b.total_amount || 0),
      );
    }

    const sortedMonths = Array.from(monthlyMap.keys()).sort();
    const monthlyPurchases = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      amount: Math.round(monthlyMap.get(m)!),
    }));

    const productPurchases = Array.from(prodMap.entries()).map(
      ([name, val]) => ({
        product_name: name,
        amount: Math.round(val.amount * 100) / 100,
        qty: Math.round(val.qty * 100) / 100,
      }),
    );

    return {
      totalPurchaseValue: Math.round(totalPurchaseValue * 100) / 100,
      purchaseBatchCount,
      totalProductsPurchasedQty:
        Math.round(totalProductsPurchasedQty * 100) / 100,
      avgBatchValue: Math.round(avgBatchValue * 100) / 100,
      avgInvoiceValue: Math.round(avgInvoiceValue * 100) / 100,
      monthlyPurchases,
      purchaseTrend: monthlyPurchases,
      supplierPurchases: [],
      productPurchases,
      recentBatches: pBatches.slice(0, 5),
      largestBatches: [...pBatches]
        .sort((a, b) => b.total_amount - a.total_amount)
        .slice(0, 5),
    };
  }

  /**
   * 4. Sales Dashboard Data
   */
  static async getSalesMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<SalesMetrics> {
    const [{ data: batches }, invoices, { data: receivingCompanies }] =
      await Promise.all([
        supabase.from("invoice_batch").select("*"),
        fetchAllQueryRows((from, to) =>
          supabase.from("invoice").select("*").range(from, to),
        ),
        supabase.from("receiving_companies").select("id, company_name"),
      ]);

    let sBatches = (batches || []).filter(
      (b) => b.batch_type === "SALES" || !b.batch_type,
    );
    if (filter.financialYear && filter.financialYear !== "All") {
      sBatches = sBatches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
    }
    if (filter.salesBatchId && filter.salesBatchId !== "All") {
      sBatches = sBatches.filter((b) => b.id === filter.salesBatchId);
    }

    const sBatchIds = new Set(sBatches.map((b) => b.id));
    const sInvoices = (invoices || []).filter((inv) =>
      sBatchIds.has(inv.invoice_batch_id),
    );

    const totalSalesValue = sInvoices.reduce(
      (sum, inv) => sum + Number(inv.total_amount || 0),
      0,
    );
    const salesBatchCount = sBatches.length;
    const totalInvoicesCount = sInvoices.length;
    const avgInvoiceValue =
      totalInvoicesCount > 0 ? totalSalesValue / totalInvoicesCount : 0;

    const companyMap = new Map<string, string>(
      (receivingCompanies || []).map((c) => [c.id, c.company_name]),
    );
    const customerMap = new Map<string, { amount: number; count: number }>();
    const prodMap = new Map<string, { amount: number; qty: number }>();
    const monthlyMap = new Map<string, number>();

    for (const inv of sInvoices) {
      if (inv.invoice_date) {
        const mKey = inv.invoice_date.slice(0, 7);
        monthlyMap.set(
          mKey,
          (monthlyMap.get(mKey) || 0) + Number(inv.total_amount || 0),
        );
      }

      for (const p of inv.products || []) {
        const custId = p.customer_id || "Unknown";
        const custName =
          companyMap.get(custId) || `Customer (${custId.slice(0, 8)})`;
        const amt = Number(p.amount || 0);
        const qty = Number(p.quantity || 0);
        const prodName = p.product_name || "Unknown Product";

        if (!customerMap.has(custName)) {
          customerMap.set(custName, { amount: 0, count: 0 });
        }
        const cItem = customerMap.get(custName)!;
        cItem.amount += amt;
        cItem.count += 1;

        if (!prodMap.has(prodName)) {
          prodMap.set(prodName, { amount: 0, qty: 0 });
        }
        const pItem = prodMap.get(prodName)!;
        pItem.amount += amt;
        pItem.qty += qty;
      }
    }

    const sortedMonths = Array.from(monthlyMap.keys()).sort();
    const monthlySales = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      amount: Math.round(monthlyMap.get(m)!),
    }));

    const customerSales = Array.from(customerMap.entries()).map(
      ([name, val]) => ({
        customer_name: name,
        amount: Math.round(val.amount * 100) / 100,
      }),
    );

    const productSales = Array.from(prodMap.entries()).map(([name, val]) => ({
      product_name: name,
      amount: Math.round(val.amount * 100) / 100,
      qty: Math.round(val.qty * 100) / 100,
    }));

    const highestValueCustomers = Array.from(customerMap.entries())
      .map(([name, val]) => ({
        customer_name: name,
        amount: Math.round(val.amount * 100) / 100,
        invoices_count: val.count,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    return {
      totalSalesValue: Math.round(totalSalesValue * 100) / 100,
      salesBatchCount,
      totalInvoicesCount,
      avgInvoiceValue: Math.round(avgInvoiceValue * 100) / 100,
      customersServedCount: customerMap.size,
      monthlySales,
      customerSales,
      productSales,
      salesTrend: monthlySales,
      recentSalesBatches: sBatches.slice(0, 5),
      highestValueCustomers,
    };
  }

  /**
   * 5. Expense Dashboard Data
   */
  static async getExpenseMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<ExpenseMetrics> {
    const [{ data: expBatches }, { data: expLedger }] = await Promise.all([
      supabase.from("expense_batch").select("*"),
      supabase.from("expense_daily_ledger").select("*"),
    ]);

    let batches = expBatches || [];
    let ledger = expLedger || [];

    if (filter.financialYear && filter.financialYear !== "All") {
      batches = batches.filter(
        (b) => b.financial_year === filter.financialYear,
      );
    }

    const totalExpenses = ledger.reduce(
      (sum, e) => sum + Number(e.amount || 0),
      0,
    );
    const avgExpensePerBatch =
      batches.length > 0 ? totalExpenses / batches.length : 0;

    const categoryMap = new Map<string, number>();
    const monthlyMap = new Map<string, number>();

    for (const e of ledger) {
      const cat = e.category || "General Expense";
      categoryMap.set(cat, (categoryMap.get(cat) || 0) + Number(e.amount || 0));

      if (e.expense_date) {
        const mKey = e.expense_date.slice(0, 7);
        monthlyMap.set(
          mKey,
          (monthlyMap.get(mKey) || 0) + Number(e.amount || 0),
        );
      }
    }

    const sortedMonths = Array.from(monthlyMap.keys()).sort();
    const monthlyExpenses = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      amount: Math.round(monthlyMap.get(m)!),
    }));

    const categoryDistribution = Array.from(categoryMap.entries()).map(
      ([cat, val]) => ({
        category: cat,
        amount: Math.round(val * 100) / 100,
      }),
    );

    return {
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      expenseCategoriesCount: categoryMap.size,
      monthlyExpenses,
      avgExpensePerBatch: Math.round(avgExpensePerBatch * 100) / 100,
      expenseTrend: monthlyExpenses,
      categoryDistribution,
      recentExpenses: batches.slice(0, 5),
      largestExpenses: [...batches]
        .sort((a, b) => b.total_amount - a.total_amount)
        .slice(0, 5),
    };
  }

  /**
   * 6. Profit & Loss Statement Data
   */
  static async getProfitLossMetrics(
    supabase: SupabaseClient,
    filter: AnalyticsFilter = {},
  ): Promise<ProfitLossMetrics> {
    const [{ data: batches }, invoices, { data: expLedger }] =
      await Promise.all([
        supabase.from("invoice_batch").select("*"),
        fetchAllQueryRows((from, to) =>
          supabase.from("invoice").select("*").range(from, to),
        ),
        supabase.from("expense_daily_ledger").select("*"),
      ]);

    const salesBatches = (batches || []).filter(
      (b) => b.batch_type === "SALES" || !b.batch_type,
    );
    const purchaseBatches = (batches || []).filter(
      (b) => b.batch_type === "PURCHASE",
    );

    const sBatchIds = new Set(salesBatches.map((b) => b.id));

    const revenue = (invoices || [])
      .filter((inv) => sBatchIds.has(inv.invoice_batch_id))
      .reduce((sum, inv) => sum + Number(inv.total_amount || 0), 0);

    const purchaseCost = purchaseBatches.reduce(
      (sum, b) => sum + Number(b.total_amount || 0),
      0,
    );
    const expenses = (expLedger || []).reduce(
      (sum, e) => sum + Number(e.amount || 0),
      0,
    );

    const grossProfit = revenue - purchaseCost;
    const netProfit = grossProfit - expenses;
    const profitMarginPct =
      revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : 0;

    const monthMap = new Map<
      string,
      { revenue: number; purchase: number; expense: number }
    >();

    for (const inv of invoices || []) {
      if (!inv.invoice_date || !sBatchIds.has(inv.invoice_batch_id)) continue;
      const mKey = inv.invoice_date.slice(0, 7);
      if (!monthMap.has(mKey)) {
        monthMap.set(mKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      monthMap.get(mKey)!.revenue += Number(inv.total_amount || 0);
    }

    for (const b of purchaseBatches) {
      if (!b.invoice_date_from) continue;
      const mKey = b.invoice_date_from.slice(0, 7);
      if (!monthMap.has(mKey)) {
        monthMap.set(mKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      monthMap.get(mKey)!.purchase += Number(b.total_amount || 0);
    }

    for (const e of expLedger || []) {
      if (!e.expense_date) continue;
      const mKey = e.expense_date.slice(0, 7);
      if (!monthMap.has(mKey)) {
        monthMap.set(mKey, { revenue: 0, purchase: 0, expense: 0 });
      }
      monthMap.get(mKey)!.expense += Number(e.amount || 0);
    }

    const sortedMonths = Array.from(monthMap.keys()).sort();

    const revenueVsExpenses = sortedMonths.map((m) => ({
      month: this.formatMonthLabel(m),
      revenue: Math.round(monthMap.get(m)!.revenue),
      expenses: Math.round(
        monthMap.get(m)!.purchase + monthMap.get(m)!.expense,
      ),
    }));

    const profitTrend = sortedMonths.map((m) => {
      const rev = monthMap.get(m)!.revenue;
      const pur = monthMap.get(m)!.purchase;
      const exp = monthMap.get(m)!.expense;
      const gProf = rev - pur;
      return {
        month: this.formatMonthLabel(m),
        grossProfit: Math.round(gProf),
        netProfit: Math.round(gProf - exp),
      };
    });

    const monthlyProfit = sortedMonths.map((m) => {
      const rev = monthMap.get(m)!.revenue;
      const pur = monthMap.get(m)!.purchase;
      const exp = monthMap.get(m)!.expense;
      return {
        month: this.formatMonthLabel(m),
        netProfit: Math.round(rev - pur - exp),
      };
    });

    const monthlyPnLSummary = sortedMonths.map((m) => {
      const rev = monthMap.get(m)!.revenue;
      const pur = monthMap.get(m)!.purchase;
      const exp = monthMap.get(m)!.expense;
      const gProf = rev - pur;
      const nProf = gProf - exp;
      const margin = rev > 0 ? (nProf / rev) * 100 : 0;

      return {
        month: this.formatMonthLabel(m),
        revenue: Math.round(rev * 100) / 100,
        purchaseCost: Math.round(pur * 100) / 100,
        expenses: Math.round(exp * 100) / 100,
        grossProfit: Math.round(gProf * 100) / 100,
        netProfit: Math.round(nProf * 100) / 100,
        marginPct: Math.round(margin * 100) / 100,
      };
    });

    return {
      revenue: Math.round(revenue * 100) / 100,
      purchaseCost: Math.round(purchaseCost * 100) / 100,
      expenses: Math.round(expenses * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
      profitMarginPct,
      revenueVsExpenses,
      profitTrend,
      monthlyProfit,
      monthlyPnLSummary,
    };
  }
}
