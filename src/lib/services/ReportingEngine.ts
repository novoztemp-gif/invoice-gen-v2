import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { AnalyticsEngine } from "./AnalyticsEngine";

export interface ReportFilter {
  financialYear?: string;
  startDate?: string;
  endDate?: string;
  purchaseBatchId?: string;
  salesBatchId?: string;
  productId?: string;
  customerId?: string;
  issuingCompanyId?: string;
  category?: string;
}

export interface ReportHeaderMeta {
  reportTitle: string;
  reportDescription: string;
  financialYear: string;
  generatedAt: string;
  appliedFiltersText: string;
}

export interface DocumentItem {
  id: string;
  documentNumber: string;
  documentType:
    | "Sales Invoice"
    | "Delivery Challan"
    | "Purchase Invoice"
    | "Purchase Batch"
    | "Sales Batch"
    | "Expense Entry"
    | "Report";
  title: string;
  category: "Invoices" | "Challans" | "Purchase" | "Expenses" | "Reports";
  date: string;
  financialYear: string;
  partyName: string;
  amount: number;
  downloadUrl: string;
  printUrl?: string;
  rawInvoice?: any;
  rawBatch?: any;
}

export class ReportingEngine {
  /**
   * Helper to filter date strings inside ISO date range
   */
  private static isWithinDateRange(
    dateStr: string | null | undefined,
    startDate?: string,
    endDate?: string,
  ): boolean {
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (startDate && d < new Date(startDate)) return false;
    if (endDate && d > new Date(endDate)) return false;
    return true;
  }

  /**
   * 1. PURCHASE REPORTS
   */
  public static async getPurchaseReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const metrics = await AnalyticsEngine.getPurchaseMetrics(supabase, filters);

    // Fetch individual purchase invoices without 1000-row PostgREST truncation
    const rawInvoices = await fetchAllQueryRows((from, to) => {
      let invQuery = supabase
        .from("invoice")
        .select(`
          *,
          invoice_batch!inner (
            id,
            batch_number,
            batch_type,
            financial_year,
            issuing_company_id,
            receiving_company_id
          )
        `)
        .eq("invoice_batch.batch_type", "PURCHASE")
        .order("invoice_date", { ascending: false });

      if (filters.financialYear && filters.financialYear !== "ALL") {
        invQuery = invQuery.eq(
          "invoice_batch.financial_year",
          filters.financialYear,
        );
      }

      return invQuery.range(from, to);
    });

    // Filter date range in memory for stability
    const invoices = (rawInvoices || []).filter((inv) =>
      this.isWithinDateRange(
        inv.invoice_date,
        filters.startDate,
        filters.endDate,
      ),
    );

    // Format Purchase Register
    const registerRows = invoices.map((inv) => {
      const prods = inv.products || [];
      const totalQty = prods.reduce(
        (acc: number, p: any) => acc + (Number(p.quantity) || 0),
        0,
      );
      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date,
        batch_number: inv.invoice_batch?.batch_number || "—",
        supplier_name: inv.products?.[0]?.customer_name || "—",
        product_count: prods.length,
        total_quantity: totalQty,
        total_amount: Number(inv.total_amount) || 0,
        raw: inv,
      };
    });

    return {
      metrics,
      registerRows,
      summary: {
        totalPurchasesCount: registerRows.length,
        totalPurchaseValue: metrics.totalPurchaseValue,
        avgInvoiceValue: metrics.avgInvoiceValue,
        monthlyPurchases: metrics.monthlyPurchases,
      },
    };
  }

  /**
   * 2. SALES REPORTS
   */
  public static async getSalesReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const metrics = await AnalyticsEngine.getSalesMetrics(supabase, filters);

    const rawInvoices = await fetchAllQueryRows((from, to) => {
      let invQuery = supabase
        .from("invoice")
        .select(`
          *,
          invoice_batch!inner (
            id,
            batch_number,
            batch_type,
            financial_year
          )
        `)
        .neq("invoice_batch.batch_type", "PURCHASE")
        .order("invoice_date", { ascending: false });

      if (filters.financialYear && filters.financialYear !== "ALL") {
        invQuery = invQuery.eq(
          "invoice_batch.financial_year",
          filters.financialYear,
        );
      }

      return invQuery.range(from, to);
    });
    const invoices = (rawInvoices || []).filter((inv) =>
      this.isWithinDateRange(
        inv.invoice_date,
        filters.startDate,
        filters.endDate,
      ),
    );

    const registerRows = invoices.map((inv) => ({
      id: inv.id,
      invoice_number: inv.invoice_number,
      sales_batch_number: inv.invoice_batch?.batch_number || "—",
      customer_name: inv.products?.[0]?.customer_name || "—",
      invoice_date: inv.invoice_date,
      total_amount: Number(inv.total_amount) || 0,
      product_count: (inv.products || []).length,
      raw: inv,
    }));

    return {
      metrics,
      registerRows,
      summary: {
        totalSalesCount: registerRows.length,
        totalSalesValue: metrics.totalSalesValue,
        avgInvoiceValue: metrics.avgInvoiceValue,
        monthlySales: metrics.monthlySales,
      },
    };
  }

  /**
   * 3. INVENTORY REPORTS
   */
  public static async getInventoryReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const metrics = await AnalyticsEngine.getInventoryMetrics(
      supabase,
      filters,
    );

    return {
      metrics,
      currentInventory: metrics.productLedgerRows,
      purchaseBatches: metrics.purchaseBatchRows,
      carryForward: metrics.carryForwardRows,
      movementLogs: metrics.movementLogs,
    };
  }

  /**
   * 4. EXPENDITURE REPORTS
   */
  public static async getExpenditureReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const metrics = await AnalyticsEngine.getExpenseMetrics(supabase, filters);

    let expQuery = supabase
      .from("expense_daily_ledger")
      .select("*")
      .order("expense_date", { ascending: false });

    if (filters.financialYear && filters.financialYear !== "ALL") {
      expQuery = expQuery.eq("financial_year", filters.financialYear);
    }

    const { data: rawExpenses } = await expQuery;
    const expenses = (rawExpenses || []).filter((exp) =>
      this.isWithinDateRange(
        exp.expense_date,
        filters.startDate,
        filters.endDate,
      ),
    );

    return {
      metrics,
      registerRows: expenses,
      categorySummary: metrics.categoryDistribution,
      monthlySummary: metrics.monthlyExpenses,
    };
  }

  /**
   * 5. PROFIT & LOSS REPORTS
   */
  public static async getProfitLossReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const execMetrics = await AnalyticsEngine.getExecutiveMetrics(
      supabase,
      filters,
    );

    return {
      financialYear: filters.financialYear || "FY 2025-26",
      revenue: execMetrics.totalRevenue,
      purchaseCost: execMetrics.totalPurchaseValue,
      expenses: execMetrics.totalExpenseValue,
      grossProfit: execMetrics.grossProfit,
      netProfit: execMetrics.netProfit,
      profitPercentage:
        execMetrics.totalRevenue > 0
          ? Number(
              (
                (execMetrics.netProfit / execMetrics.totalRevenue) *
                100
              ).toFixed(2),
            )
          : 0,
      profitTrend: execMetrics.profitTrend,
      monthlyRevenue: execMetrics.monthlyRevenue,
    };
  }

  /**
   * 6. CUSTOMER REPORTS
   */
  public static async getCustomerReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const { data: customers } = await supabase
      .from("receiving_companies")
      .select("*")
      .order("company_name", { ascending: true });

    const invoices = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice")
        .select(`
          *,
          invoice_batch (batch_number, batch_type, financial_year)
        `)
        .order("invoice_date", { ascending: false })
        .range(from, to),
    );

    const filteredInvoices = (invoices || []).filter(
      (inv) =>
        inv.invoice_batch?.batch_type !== "PURCHASE" &&
        this.isWithinDateRange(
          inv.invoice_date,
          filters.startDate,
          filters.endDate,
        ),
    );

    const customerSummary = (customers || []).map((cust) => {
      const custInvoices = filteredInvoices.filter(
        (inv) => inv.products?.[0]?.customer_id === cust.id,
      );
      const totalSpent = custInvoices.reduce(
        (sum, inv) => sum + (Number(inv.total_amount) || 0),
        0,
      );
      return {
        id: cust.id,
        company_name: cust.company_name,
        gstin: cust.gstin || "Unregistered",
        city: cust.city || cust.state || "—",
        invoiceCount: custInvoices.length,
        totalSalesValue: totalSpent,
        lastTransactionDate: custInvoices[0]?.invoice_date || "—",
      };
    });

    return {
      customers: customerSummary,
      totalCustomers: customerSummary.length,
      activeCustomers: customerSummary.filter((c) => c.invoiceCount > 0).length,
      invoices: filteredInvoices,
    };
  }

  /**
   * 7. PRODUCT REPORTS
   */
  public static async getProductReports(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ) {
    const inventoryMetrics = await AnalyticsEngine.getInventoryMetrics(
      supabase,
      filters,
    );

    const { data: products } = await supabase
      .from("products")
      .select("*")
      .order("name", { ascending: true });

    return {
      products: products || [],
      ledgerRows: inventoryMetrics.productLedgerRows,
      movementLogs: inventoryMetrics.movementLogs,
      purchaseBatches: inventoryMetrics.purchaseBatchRows,
    };
  }

  /**
   * 8. DOCUMENT CENTER
   */
  public static async getDocumentCenterItems(
    supabase: SupabaseClient,
    filters: ReportFilter = {},
  ): Promise<DocumentItem[]> {
    const items: DocumentItem[] = [];

    // Fetch Sales & Purchase Invoices without 1000-row PostgREST truncation
    const invoices = await fetchAllQueryRows((from, to) =>
      supabase
        .from("invoice")
        .select(`
          *,
          invoice_batch (
            id,
            batch_number,
            batch_type,
            financial_year
          )
        `)
        .order("created_at", { ascending: false })
        .range(from, to),
    );

    if (invoices) {
      for (const inv of invoices) {
        const isPurchase = inv.invoice_batch?.batch_type === "PURCHASE";
        const dateStr = inv.invoice_date || inv.created_at || "";
        if (
          !this.isWithinDateRange(dateStr, filters.startDate, filters.endDate)
        ) {
          continue;
        }

        const party = inv.products?.[0]?.customer_name || "—";

        if (isPurchase) {
          items.push({
            id: `PUR-${inv.id}`,
            documentNumber: inv.invoice_number,
            documentType: "Purchase Invoice",
            title: `Purchase Voucher ${inv.invoice_number}`,
            category: "Purchase",
            date: dateStr,
            financialYear: inv.invoice_batch?.financial_year || "FY 2025-26",
            partyName: party,
            amount: Number(inv.total_amount) || 0,
            downloadUrl: `/api/download-invoice?invoiceId=${inv.id}`,
            printUrl: `/invoice/print/${inv.id}`,
            rawInvoice: inv,
          });
        } else {
          // Sales Invoice
          items.push({
            id: `INV-${inv.id}`,
            documentNumber: inv.invoice_number,
            documentType: "Sales Invoice",
            title: `Sales Invoice ${inv.invoice_number}`,
            category: "Invoices",
            date: dateStr,
            financialYear: inv.invoice_batch?.financial_year || "FY 2025-26",
            partyName: party,
            amount: Number(inv.total_amount) || 0,
            downloadUrl: `/api/download-invoice?invoiceId=${inv.id}`,
            printUrl: `/invoice/print/${inv.id}`,
            rawInvoice: inv,
          });

          // Delivery Challan (Miniature format)
          items.push({
            id: `DC-${inv.id}`,
            documentNumber: `DC-${inv.invoice_number}`,
            documentType: "Delivery Challan",
            title: `Delivery Challan DC-${inv.invoice_number}`,
            category: "Challans",
            date: dateStr,
            financialYear: inv.invoice_batch?.financial_year || "FY 2025-26",
            partyName: party,
            amount: Number(inv.total_amount) || 0,
            downloadUrl: `/api/download-invoice?invoiceId=${inv.id}&isChallan=true`,
            printUrl: `/invoice/print/${inv.id}?isChallan=true`,
            rawInvoice: inv,
          });
        }
      }
    }

    // Fetch Expense Batches
    const { data: expBatches } = await supabase
      .from("expense_batch")
      .select("*")
      .order("created_at", { ascending: false });

    if (expBatches) {
      for (const eb of expBatches) {
        items.push({
          id: `EXP-${eb.id}`,
          documentNumber: eb.batch_number,
          documentType: "Expense Entry",
          title: `Expense Batch ${eb.batch_number}`,
          category: "Expenses",
          date: eb.entry_date || eb.created_at,
          financialYear: eb.financial_year || "FY 2025-26",
          partyName: "Expense Operations",
          amount: Number(eb.total_amount) || 0,
          downloadUrl: `/dashboard/expense`,
        });
      }
    }

    return items;
  }
}
