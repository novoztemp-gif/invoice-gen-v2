import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      issuingCompanyId,
      receivingCompanyId,
      selectedCustomers,
      majorCustomers,
      transportMode,
      vehicleNumber,
      dateOfSupply,
      invoiceDateFrom,
      invoiceDateTo,
      minimumInvoiceAmount,
      maximumInvoiceAmount,
      totalAmount,
      financialYearStart,
      financialYearEnd,
      products,
      recurringProducts,
      stockSourceBatchId,
    } = body;

    if (!stockSourceBatchId) {
      return NextResponse.json(
        { message: "Stock Source Batch ID is required for Sales batches" },
        { status: 400 },
      );
    }

    const supabase = await createClient();

    // 1. Fetch daily stock ledger for the selected stock source purchase batch
    const { data: ledgerData, error: ledgerError } = await supabase
      .from("daily_stock_ledger")
      .select(
        "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
      )
      .eq("purchase_batch_id", stockSourceBatchId)
      .order("ledger_date", { ascending: true });

    if (ledgerError) {
      return NextResponse.json(
        { message: `Failed to load stock ledger: ${ledgerError.message}` },
        { status: 500 },
      );
    }

    // 1.5. Compute dynamic ledger carry-forward for building the initial review rows & availableStockMap
    const productGroups = new Map<string, any[]>();
    for (const row of ledgerData || []) {
      if (!productGroups.has(row.product_id)) {
        productGroups.set(row.product_id, []);
      }
      productGroups.get(row.product_id)!.push(row);
    }

    const availableStockMap = new Map<string, number>();
    const computedLedgerMap = new Map<
      string,
      {
        opening: number;
        purchased: number;
        prevSold: number;
        available: number;
      }
    >();

    for (const [productId, rows] of productGroups.entries()) {
      let carryForward = Number(rows[0].opening_stock) || 0;
      for (const row of rows) {
        const opening = carryForward;
        const purchased = Number(row.purchased_quantity) || 0;
        const prevSold = Number(row.sold_quantity) || 0;

        const available = opening + purchased - prevSold;

        const key = `${row.ledger_date}_${row.product_id}`;
        availableStockMap.set(key, Math.max(0, available));
        computedLedgerMap.set(key, { opening, purchased, prevSold, available });

        carryForward = Math.max(0, available);
      }
    }

    // 2. Prepare the Batch Configuration object to pass to the engine
    const fromDate = new Date(invoiceDateFrom);
    const toDate = new Date(invoiceDateTo);
    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    // Resolve starting invoice counter
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

    // Mock batch config for engine processing
    const mockBatch: any = {
      id: "placeholder",
      batch_type: "SALES",
      invoice_date_from: invoiceDateFrom,
      invoice_date_to: invoiceDateTo,
      minimum_invoice_amount: Number(minimumInvoiceAmount),
      maximum_invoice_amount: Number(maximumInvoiceAmount),
      total_amount: Number(totalAmount),
      products: products,
      recurring_products: recurringProducts,
      selected_customers: selectedCustomers,
      major_customers: majorCustomers,
      receiving_company_id: receivingCompanyId,
    };

    // 3. Generate proposed invoices in-memory
    const invoices = (InvoiceEngine as any).generateInvoiceSplitupsInternal(
      mockBatch,
      numberOfDays,
      fromDate,
      startingCounter,
      availableStockMap,
    );

    // Sum up the proposed quantities per date and product
    const proposedQtyMap = new Map<string, number>();
    for (const inv of invoices) {
      for (const p of inv.products) {
        const key = `${inv.invoice_date}_${p.product_id}`;
        proposedQtyMap.set(key, (proposedQtyMap.get(key) || 0) + p.quantity);
      }
    }

    // 4. Construct the initial review rows
    const reviewRows = (ledgerData || []).map((row: any) => {
      const key = `${row.ledger_date}_${row.product_id}`;
      const proposed = proposedQtyMap.get(key) || 0;

      const computed = computedLedgerMap.get(key) || {
        opening: 0,
        purchased: 0,
        prevSold: 0,
        available: 0,
      };
      const remaining = Math.max(0, computed.available - proposed);

      const productObj = products.find(
        (p: any) => p.product_id === row.product_id,
      );
      const productName = productObj?.product_name || "Unknown Product";
      const unit = productObj?.unit_of_measure || "kg";

      return {
        date: row.ledger_date,
        product_id: row.product_id,
        product_name: productName,
        opening_stock: computed.opening,
        purchased_quantity: computed.purchased,
        proposed_sold: proposed,
        remaining_stock: remaining,
        unit: unit,
      };
    });

    return NextResponse.json({
      success: true,
      invoices: invoices,
      reviewRows: reviewRows,
    });
  } catch (error: any) {
    console.error("Error running Sales dry-run:", error);
    return NextResponse.json(
      {
        message:
          error?.message || "An unexpected error occurred during dry-run",
      },
      { status: 500 },
    );
  }
}
