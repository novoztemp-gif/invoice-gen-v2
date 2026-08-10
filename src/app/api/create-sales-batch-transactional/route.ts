import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { InvoiceNumberingService } from "@/lib/services/InvoiceNumberingService";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
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

    // The client-supplied `products` payload carries whatever category
    // value was on the SOURCE PURCHASE batch's stored config — which is
    // frequently missing or wrong, and generation's category-purity logic
    // (keeping fruit and meat off the same invoice) silently defaults an
    // unrecognized product to "Meat" instead of erroring, so a wrong or
    // missing category here doesn't fail loudly, it just quietly mixes
    // categories. Override every product's category with a fresh lookup
    // from the products table — the actual source of truth — before
    // anything downstream uses it.
    if (Array.isArray(products) && products.length > 0) {
      const productIds = Array.from(
        new Set(
          products.map((p: any) => p.product_id || p.id).filter(Boolean),
        ),
      );
      if (productIds.length > 0) {
        const { data: realProducts } = await supabase
          .from("products")
          .select("id, category")
          .in("id", productIds);
        const categoryById = new Map(
          (realProducts || []).map((p: any) => [String(p.id), p.category]),
        );
        for (const p of products) {
          const pid = String(p.product_id || p.id || "");
          const realCategory = categoryById.get(pid);
          if (realCategory) {
            p.category = realCategory;
          }
        }
      }
    }

    // Support single or comma-separated batch IDs
    const batchIds = stockSourceBatchId
      .split(",")
      .map((id: string) => id.trim())
      .filter((id: string) => Boolean(id));

    const primaryBatchId = batchIds[0] || stockSourceBatchId.split(",")[0];

    // 1. Fetch daily stock ledger for the selected stock source purchase
    // batch(es). Paginated — a source batch with many products/days easily
    // exceeds PostgREST's default 1000-row cap.
    let ledgerData: any[] = [];
    let ledgerError: any = null;
    try {
      ledgerData = await fetchAllQueryRows((from, to) => {
        let q = supabase
          .from("daily_stock_ledger")
          .select(
            "ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          // Secondary sort key makes pagination deterministic — ordering by
          // ledger_date alone lets Postgres break same-date ties
          // differently per paginated page, duplicating or dropping rows
          // once the ledger exceeds a page size.
          .order("ledger_date", { ascending: true })
          .order("product_id", { ascending: true });
        q =
          batchIds.length > 0
            ? q.in("purchase_batch_id", batchIds)
            : q.eq("purchase_batch_id", primaryBatchId);
        return q.range(from, to);
      });
    } catch (err: any) {
      ledgerError = err;
    }

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
        status: "pending",
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

      // Manual Sequence Override or Auto-Detection of Highest Existing Sequence Number
      let startingCounter = 1;
      const isManualSequenceOverride =
        rawPrevSeq !== undefined &&
        rawPrevSeq !== null &&
        rawPrevSeq !== "" &&
        !isNaN(Number(rawPrevSeq)) &&
        Number(rawPrevSeq) >= 0;

      if (isManualSequenceOverride) {
        startingCounter = Number(rawPrevSeq) + 1;
      } else {
        const prefix = `${companyAbbr}-${canonicalFy}-S`;
        let maxSeq = 0;
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;

        while (hasMore) {
          const { data: pageInvoices } = await supabase
            .from("invoice")
            .select("invoice_number")
            .like("invoice_number", `${prefix}-%`)
            .range(page * pageSize, (page + 1) * pageSize - 1);

          if (pageInvoices && pageInvoices.length > 0) {
            for (const row of pageInvoices) {
              const parts = (row.invoice_number || "").split("-");
              const seqNum = parseInt(parts[parts.length - 1], 10);
              if (!isNaN(seqNum) && seqNum > maxSeq) {
                maxSeq = seqNum;
              }
            }
            if (pageInvoices.length < pageSize) {
              hasMore = false;
            } else {
              page++;
            }
          } else {
            hasMore = false;
          }
        }
        startingCounter = maxSeq + 1;
      }

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
          // The leftover/sold split was already decided and confirmed by
          // the user in the Daily Stock Review modal (Null or Auto
          // Allocate) — that confirmation IS the commitment, not a later
          // "Generate Splitup" click. Insert directly as "generated" so
          // the source purchase batch's daily_stock_ledger gets updated
          // immediately below, and the leftover is correct for the very
          // next sales batch right away, independent of whatever happens
          // to this batch afterward (edited, finalized, or left alone).
          status: "generated",
          batch_type: "SALES",
        };
      });

      // Invoice numbers are assigned strictly from the user-provided
      // Previous Ending Sequence Number + 1, with no auto-detection or
      // collision-based renumbering against existing invoices. If the
      // numbers collide with something already in the database, the insert
      // below fails on the table's own uniqueness constraint rather than
      // silently reassigning numbers the user didn't ask for.

      console.log("==========================================");
      console.log("[INSERT PATH B - create-sales-batch-transactional]");
      console.log("process.pid:", process.pid);
      console.log("NODE_ENV:", process.env.NODE_ENV);
      console.log("url:", request.url);
      console.log(
        "first 5 invoices to insert:",
        invoicesToInsert.slice(0, 5).map((i: any) => i.invoice_number),
      );
      console.log("==========================================");

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

      // Commit the leftover decision to the ledger right now — this is the
      // moment the user actually confirmed how much of the purchased stock
      // stays as leftover vs. gets sold. Also flip the batch's own status
      // to "generated" so /api/reveal-sales-batch-splitup (guarded on
      // status === "pending") correctly treats this as already revealed
      // and never runs postSalesBatchStockLedger a second time — it's not
      // idempotent (it ADDS to whatever's already recorded).
      if (stockSourceBatchId) {
        await InvoiceEngine.postSalesBatchStockLedger(
          supabase,
          newBatch.id,
          stockSourceBatchId,
        );
      }
      await supabase
        .from("invoice_batch")
        .update({ status: "generated" })
        .eq("id", newBatch.id);
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
