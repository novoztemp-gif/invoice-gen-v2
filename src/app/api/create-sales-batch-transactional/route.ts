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

    // Support single or comma-separated batch IDs
    const batchIds = stockSourceBatchId
      .split(",")
      .map((id: string) => id.trim())
      .filter((id: string) => Boolean(id) && !id.startsWith("CARRY_FORWARD_"));

    const primaryBatchId = batchIds[0] || stockSourceBatchId.split(",")[0];

    // 1. Fetch daily stock ledger for the selected stock source purchase batch(es)
    let ledgerQuery = supabase
      .from("daily_stock_ledger")
      .select(
        "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
      )
      .order("ledger_date", { ascending: true });

    if (batchIds.length > 0) {
      ledgerQuery = ledgerQuery.in("purchase_batch_id", batchIds);
    } else {
      ledgerQuery = ledgerQuery.eq("purchase_batch_id", primaryBatchId);
    }

    const { data: ledgerData, error: ledgerError } = await ledgerQuery;

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
    const fromDate = new Date(invoiceDateFrom);
    const toDate = new Date(invoiceDateTo);
    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;

    // Resolve starting invoice counter
    const { data: allInvoices } = await supabase
      .from("invoice")
      .select("invoice_number")
      .order("invoice_number", { ascending: false })
      .limit(1);

    let startingCounter = 1;
    if (allInvoices && allInvoices.length > 0) {
      for (const inv of allInvoices) {
        const match = inv.invoice_number.match(/(\d+)$/);
        if (match) {
          startingCounter = parseInt(match[1], 10) + 1;
          break;
        }
      }
    }

    const batchConfig = {
      issuingCompanyId,
      receivingCompanyId,
      selectedCustomers,
      majorCustomers,
      transportMode,
      vehicleNumber,
      dateOfSupply,
      invoiceDateFrom,
      invoiceDateTo,
      minimumInvoiceAmount: parseFloat(minimumInvoiceAmount),
      maximumInvoiceAmount: parseFloat(maximumInvoiceAmount),
      totalAmount: parseFloat(totalAmount),
      financialYearStart: parseInt(financialYearStart),
      financialYearEnd: parseInt(financialYearEnd),
      products,
      recurringProducts: recurringProducts || [],
      stockSourceBatchId: primaryBatchId,
      availableStockMap,
      numberOfDays,
      startingCounter,
    };

    // 3. Generate Proposed Sales Invoices using InvoiceEngine
    const proposedInvoices = await InvoiceEngine.generateAndSaveInvoices(
      supabase,
      batchConfig as any,
    );

    return NextResponse.json({
      success: true,
      proposedInvoices,
    });
  } catch (error: any) {
    console.error("Error generating proposed sales batch:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
