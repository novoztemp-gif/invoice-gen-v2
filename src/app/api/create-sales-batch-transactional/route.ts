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
      userId,
    } = body;

    // Validate stockSourceBatchId
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

    const availableStockMap = new Map<string, any>();
    const productGroups = new Map<string, any[]>();
    for (const row of ledgerData || []) {
      if (!productGroups.has(row.product_id)) {
        productGroups.set(row.product_id, []);
      }
      productGroups.get(row.product_id)!.push(row);
    }

    for (const [productId, rows] of productGroups.entries()) {
      // Sort rows chronologically
      rows.sort((a: any, b: any) => a.ledger_date.localeCompare(b.ledger_date));

      let carryForward = Number(rows[0].opening_stock) || 0;
      for (const row of rows) {
        const opening = carryForward;
        const purchased = Number(row.purchased_quantity) || 0;
        const prevSold = Number(row.sold_quantity) || 0;

        const available = opening + purchased - prevSold;
        const key = `${row.ledger_date}_${row.product_id}`;
        availableStockMap.set(key, {
          opening: opening,
          purchased: Math.max(0, purchased - prevSold),
        });

        carryForward = Math.max(0, available);
      }
    }

    // 2. Prepare the Batch Configuration object to pass to the engine
    // Convert date parameters
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

    // 3. Generate proposed invoices in-memory or use override
    let invoices = body.invoicesOverride;
    if (!invoices) {
      invoices = (InvoiceEngine as any).generateInvoiceSplitupsInternal(
        mockBatch,
        numberOfDays,
        fromDate,
        startingCounter,
        availableStockMap,
      );
    }

    // Validate invoices data structure in memory
    for (const inv of invoices) {
      const validation = (InvoiceEngine as any).validateInvoiceData(inv);
      if (!validation.isValid) {
        return NextResponse.json(
          { message: `Invoices validation failed: ${validation.message}` },
          { status: 400 },
        );
      }
      // Remove placeholders that are generated server-side or handled by the RPC
      delete inv.invoice_batch_id;
    }

    // 4. Construct payload for RPC
    const batchPayload = {
      issuing_company_id: issuingCompanyId,
      receiving_company_id: receivingCompanyId,
      selected_customers: selectedCustomers,
      major_customers: majorCustomers,
      batch_type: "SALES",
      transport_mode: transportMode,
      vehicle_number: vehicleNumber || "",
      date_of_supply: invoiceDateTo,
      invoice_date_from: invoiceDateFrom,
      invoice_date_to: invoiceDateTo,
      minimum_invoice_amount: Number(minimumInvoiceAmount),
      maximum_invoice_amount: Number(maximumInvoiceAmount),
      total_amount: invoices.reduce(
        (sum: number, inv: any) => sum + Number(inv.total_amount || 0),
        0,
      ),
      financial_year: `FY${financialYearStart}-${String(financialYearEnd).slice(2)}`,
      products: products,
      recurring_products: recurringProducts,
      status: "generated",
      created_by: userId,
    };

    // 5. Invoke the atomic transactional PL/pgSQL function in Supabase
    const { data: newBatchId, error: rpcError } = await supabase.rpc(
      "create_sales_batch_transactional",
      {
        batch_payload: batchPayload,
        invoices_payload: invoices,
        stock_source_id: stockSourceBatchId,
      },
    );

    if (rpcError) {
      console.error("RPC transaction error:", rpcError);
      return NextResponse.json(
        {
          message: rpcError.message || "Atomic transaction failed to complete",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      batchId: newBatchId,
      message: "Sales batch, invoices, and stock ledger updated atomically!",
    });
  } catch (error: any) {
    console.error("Error creating transactional Sales batch:", error);
    return NextResponse.json(
      {
        message:
          error?.message || "An unexpected error occurred during creation",
      },
      { status: 500 },
    );
  }
}
