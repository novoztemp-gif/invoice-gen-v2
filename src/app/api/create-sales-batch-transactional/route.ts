import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { InvoiceNumberingService } from "@/lib/services/InvoiceNumberingService";
import { createClient } from "@/lib/supabase/server";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";

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
      invoicesOverride,
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

    const { previousEndingSequenceNumber, previousEndingSequence } = body;
    const rawPrevSeq = previousEndingSequenceNumber ?? previousEndingSequence;

    // 1. Create the new Sales invoice_batch record first
    const { data: newBatch, error: batchError } = await supabase
      .from("invoice_batch")
      .insert({
        issuing_company_id: issuingCompanyId,
        stock_source_batch_id: stockSourceBatchId,
        receiving_company_id: receivingCompanyId || null,
        selected_customers: selectedCustomers || [],
        major_customers: majorCustomers || [],
        transport_mode: transportMode || "In hand Delivery",
        vehicle_number: vehicleNumber || "NA",
        date_of_supply: dateOfSupply || invoiceDateTo,
        invoice_date_from: invoiceDateFrom,
        invoice_date_to: invoiceDateTo,
        minimum_invoice_amount: parseFloat(minimumInvoiceAmount),
        maximum_invoice_amount: parseFloat(maximumInvoiceAmount),
        total_amount: parseFloat(totalAmount),
        financial_year: `FY${financialYearStart}-${String(financialYearEnd).slice(2)}`,
        previous_ending_sequence:
          rawPrevSeq !== undefined && rawPrevSeq !== null && rawPrevSeq !== ""
            ? Number(rawPrevSeq)
            : null,
        batch_type: "SALES",
        status: "generated",
        batch_status: "DRAFT",
        products: products,
        created_by: userId,
      })
      .select()
      .single();

    if (batchError || !newBatch) {
      console.error("Error creating sales batch record:", batchError);
      return NextResponse.json(
        {
          message: `Failed to create sales batch: ${batchError?.message || "Unknown error"}`,
        },
        { status: 500 },
      );
    }

    let savedInvoices: any[] = [];

    // 2. If invoicesOverride is provided from Daily Stock Review modal, save them directly under newBatch.id
    if (Array.isArray(invoicesOverride) && invoicesOverride.length > 0) {
      const canonicalFy = InvoiceNumberingService.normalizeFinancialYear(
        `FY${String(financialYearStart)}-${String(financialYearEnd)}`,
      );

      let companyAbbr = "IC";
      if (issuingCompanyId) {
        const { data: company } = await supabase
          .from("issuing_companies")
          .select("abbreviation, company_name")
          .eq("id", issuingCompanyId)
          .single();
        if (company) {
          companyAbbr =
            company.abbreviation ||
            company.company_name
              .substring(0, 4)
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "");
        }
      }

      // Manual Sequence Override: The ONLY source of truth is rawPrevSeq
      const startingCounter =
        rawPrevSeq !== undefined &&
        rawPrevSeq !== null &&
        rawPrevSeq !== "" &&
        !isNaN(Number(rawPrevSeq))
          ? Number(rawPrevSeq) + 1
          : 1;

      let seqCounter = startingCounter;
      const invoicesToInsert = invoicesOverride.map((inv: any) => {
        const normalizedProducts = (inv.products || []).map((p: any) => {
          const qty = roundToQuarterIncrement(Number(p.quantity || 0));
          const amt = Math.round(qty * Number(p.rate || 1));
          return {
            ...p,
            quantity: qty,
            amount: amt,
            rate: Math.round(Number(p.rate || 1)),
          };
        });

        const totalAmt = Math.round(
          normalizedProducts.reduce(
            (sum: number, p: any) => sum + Math.round(p.amount || 0),
            0,
          ),
        );

        const currentInvNumber = InvoiceNumberingService.formatInvoiceNumber(
          companyAbbr,
          canonicalFy,
          "S",
          seqCounter++,
        );

        return {
          invoice_batch_id: newBatch.id,
          invoice_number: currentInvNumber,
          invoice_date: inv.invoice_date,
          total_amount: totalAmt,
          products: normalizedProducts,
          status: inv.status || "generated",
          batch_type: "SALES",
        };
      });

      const { data: insertedInvoices, error: invoiceInsertError } =
        await supabase.from("invoice").insert(invoicesToInsert).select();

      if (invoiceInsertError) {
        console.error("Error inserting sales invoices:", invoiceInsertError);
        // Rollback batch if invoice insertion fails
        await supabase.from("invoice_batch").delete().eq("id", newBatch.id);
        return NextResponse.json(
          {
            message: `Failed to insert sales invoices: ${invoiceInsertError.message}`,
          },
          { status: 500 },
        );
      }

      savedInvoices = insertedInvoices || [];
    } else {
      // Otherwise use InvoiceEngine to generate and save invoices for newBatch.id
      await InvoiceEngine.generateAndSaveInvoices(supabase, newBatch.id);
      const { data: invs } = await supabase
        .from("invoice")
        .select("*")
        .eq("invoice_batch_id", newBatch.id);
      savedInvoices = invs || [];
    }

    return NextResponse.json({
      success: true,
      batchId: newBatch.id,
      invoicesCount: savedInvoices.length,
      proposedInvoices: savedInvoices,
    });
  } catch (error: any) {
    console.error("Error generating proposed sales batch:", error);
    return NextResponse.json(
      { message: error?.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
