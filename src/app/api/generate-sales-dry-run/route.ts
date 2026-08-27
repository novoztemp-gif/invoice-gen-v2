import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { InvoiceNumberingService } from "@/lib/services/InvoiceNumberingService";
import {
  getFinalClosingStockByProduct,
  type StockLedgerRow,
} from "@/lib/services/StockCalculationService";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import { reconcileInvoicesToTargets } from "@/lib/utils/reconcile-invoice-quantities";

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
    const batchIds = stockSourceBatchId
      .split(",")
      .map((id: string) => id.trim())
      .filter((id: string) => Boolean(id));

    // Paginated — a source batch with many products/days easily exceeds
    // PostgREST's default 1000-row cap, which would silently drop
    // whichever products' rows fell past the cutoff.
    let ledgerData: any[] = [];
    try {
      ledgerData = await fetchAllQueryRows((from, to) =>
        supabase
          .from("daily_stock_ledger")
          .select(
            "purchase_batch_id, ledger_date, product_id, opening_stock, purchased_quantity, sold_quantity",
          )
          .in(
            "purchase_batch_id",
            batchIds.length > 0 ? batchIds : [stockSourceBatchId],
          )
          .order("ledger_date", { ascending: true })
          .order("product_id", { ascending: true })
          .range(from, to),
      );
    } catch (err: any) {
      return NextResponse.json(
        { message: `Failed to load stock ledger: ${err?.message || "Unknown error"}` },
        { status: 500 },
      );
    }

    const effectiveLedgerData = ledgerData || [];

    // No synthetic/estimated fallback: the Daily Stock Ledger must always
    // be built from real, persisted daily_stock_ledger rows — which only
    // exist once a purchase batch is Finalized
    // (InvoiceEngine.postPurchaseBatchStockLedger). The frontend already
    // only lets a Finalized batch be selected as a source
    // (fetchAvailableSources in generate-invoice/page.tsx), so an empty
    // result here means something upstream is inconsistent — surface that
    // clearly instead of silently estimating numbers that were never
    // actually purchased on those exact days.
    if (effectiveLedgerData.length === 0 && batchIds.length > 0) {
      return NextResponse.json(
        {
          message:
            "No daily stock ledger data found for the selected purchase batch(es). The batch must be Finalized before it can be used as a Sales stock source.",
        },
        { status: 400 },
      );
    }

    // 2. Build the fixed sales date range up front. Everything below always
    // walks THIS range, never a selected batch's own historical purchase
    // dates — a Leftover Stock batch's real ledger rows can be from an
    // entirely earlier period; only its net remaining stock carries into
    // this range, as a single day-1 opening seed.
    const fromDate = new Date(invoiceDateFrom);
    const toDate = new Date(invoiceDateTo);
    const timeDiff = toDate.getTime() - fromDate.getTime();
    const numberOfDays = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;
    const dateList: string[] = [];
    {
      const d = new Date(fromDate);
      for (let i = 0; i < numberOfDays; i++) {
        dateList.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
      }
    }

    // A batch counts as "touched" (Leftover Stock semantics) if any of its
    // own ledger rows show sold_quantity > 0 — mirrors the same rule
    // get-purchase-batch-stock-summary and fetchAvailableSources use to
    // label a source card "Leftover Stock" vs "Purchase Batch".
    const touchedBatchIds = new Set<string>();
    for (const row of effectiveLedgerData) {
      if (Number(row.sold_quantity || 0) > 0.001 && row.purchase_batch_id) {
        touchedBatchIds.add(row.purchase_batch_id);
      }
    }

    // Leftover Stock sources: their net remaining, becomes a single day-1
    // opening-stock seed for this generation's date range. Fresh Purchase
    // Batch sources: their real per-day purchased_quantity is used as-is,
    // keyed to its own actual date.
    //
    // The leftover seed is computed via the shared StockCalculationService
    // (Sprint 1.2) — the same chronological recurrence used everywhere
    // else, rather than a locally reimplemented loop.
    const leftoverRows: StockLedgerRow[] = [];
    const freshPurchasedByKey = new Map<string, number>();
    const productIdsInScope = new Set<string>();

    for (const row of effectiveLedgerData) {
      if (!row.product_id) continue;
      productIdsInScope.add(row.product_id);
      if (touchedBatchIds.has(row.purchase_batch_id)) {
        leftoverRows.push(row as StockLedgerRow);
      } else {
        const key = `${row.ledger_date}_${row.product_id}`;
        freshPurchasedByKey.set(
          key,
          (freshPurchasedByKey.get(key) || 0) +
            Number(row.purchased_quantity || 0),
        );
      }
    }

    const leftoverSeedByProduct = getFinalClosingStockByProduct(leftoverRows);

    // ── Build per-day stock picture across the requested date range ─────
    // Day 1's opening = the leftover seed (0 if no Leftover Stock source
    // was selected); every later day's carry-forward is tracked internally
    // by generateInvoiceSplitupsInternal's own runningRemaining tracker, so
    // only day-1's opening and each day's purchased figure need seeding
    // here. A FRESH map is needed per generation attempt below —
    // generateInvoiceSplitupsInternal deducts from it in place as it
    // consumes stock, so reusing one across retries would carry over a
    // failed attempt's partial consumption into the next.
    const buildFreshStockMap = () => {
      const map = new Map<string, any>();
      for (const dateStr of dateList) {
        for (const productId of productIdsInScope) {
          const key = `${dateStr}_${productId}`;
          const purchased = freshPurchasedByKey.get(key) || 0;
          const opening =
            dateStr === dateList[0]
              ? leftoverSeedByProduct.get(productId) || 0
              : 0;
          map.set(key, { opening, purchased });
        }
      }
      return map;
    };

    // Resolve starting invoice counter from invoice_sequences
    const canonicalFy = InvoiceNumberingService.normalizeFinancialYear(
      `FY${financialYearStart}-${String(financialYearEnd).slice(2)}`,
    );

    const { previousEndingSequenceNumber, previousEndingSequence } = body;
    const rawPrevSeq = previousEndingSequenceNumber ?? previousEndingSequence;

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

    // Mock batch config for engine processing
    const mockBatch: any = {
      id: "placeholder",
      batch_type: "SALES",
      issuing_company_id: issuingCompanyId,
      issuing_company_abbreviation: companyAbbr,
      previous_ending_sequence: rawPrevSeq,
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

    // 3. Generate proposed invoices in-memory using the redesigned sequential
    // allocator — auto-retried on failure. Generation is randomized
    // (category/product/rate picks), so a "Major Customer balancing
    // failed"/"exceeds configured maximum"/"cannot satisfy requested
    // amount" failure on one attempt is frequently just an unlucky roll —
    // confirmed repeatedly this session that simply regenerating (a fresh
    // stock map, fresh randomness) often succeeds on the very next try.
    // Previously this meant the user had to notice the error and manually
    // click "Create Batch" again; now the server does that internally and
    // only surfaces an error once every attempt has failed.
    //
    // Hotfix — was scoped to only Major-Customer-pattern messages, on the
    // reasoning that other failures (e.g. "Minimum Invoice Amount
    // Violation: no compatible same-category invoice ... had room")
    // reflect a structural problem that won't change between attempts.
    // Audited every throw site inside generateInvoiceSplitupsInternal
    // (the function this route calls): every one of them depends on THIS
    // attempt's random category/product/date placement (which invoices
    // ended up small, which products got picked, which day a major
    // customer landed on) — none of them are a fixed, attempt-independent
    // config error the way "Product Occurrence Configuration Invalid"
    // (percentages don't sum to 100%) would be — and that specific class
    // of error is not reachable from this route at all (config-shape
    // validation happens earlier, at the persistence route, not here).
    // So every failure this function can actually throw is worth
    // retrying — matching Purchase generation's own "retry everything"
    // philosophy (generateWithAutoRetry has no message filter at all).
    const MAX_GENERATION_ATTEMPTS = 100;
    const isRetryableGenerationError = (_message: string): boolean => true;

    let invoices: any[] | undefined;
    let lastGenerationError: any = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        invoices = (InvoiceEngine as any).generateInvoiceSplitupsInternal(
          mockBatch,
          numberOfDays,
          fromDate,
          startingCounter,
          buildFreshStockMap(),
        );
        lastGenerationError = null;
        break;
      } catch (err: any) {
        lastGenerationError = err;
        if (!isRetryableGenerationError(err?.message)) break;
        console.warn(
          `[generate-sales-dry-run] Attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed (${err?.message}) — retrying with a fresh random pass.`,
        );
      }
    }

    if (lastGenerationError || !invoices) {
      // Nothing was persisted here — a dry-run failure never creates a
      // batch row (that only happens after this dry-run succeeds and the
      // Daily Stock Ledger review is submitted), so there is nothing to
      // "clear" or discard. Make that explicit instead of implying an
      // action that doesn't apply to this failure point.
      // Hint text is now selected by what the error actually says, not by
      // whether it was retried (everything gets retried now — see above).
      // The Major-Customer-specific hint only makes sense for a Major
      // Customer failure; a generic hint covers everything else so a
      // "Minimum Invoice Amount Violation" doesn't get told to check
      // Anticipated Major Customer Demand.
      const isMajorCustomerRelated = /Major Customer/i.test(
        lastGenerationError?.message || "",
      );
      return NextResponse.json(
        {
          message:
            (lastGenerationError?.message ||
              "Sales invoice generation failed.") +
            ` (auto-retried ${MAX_GENERATION_ATTEMPTS} times — this looks like a genuine capacity constraint, not a one-off random miss. Nothing was saved. ` +
            (isMajorCustomerRelated
              ? `Likely causes on the linked Purchase batch: (1) some products in this category have a 0% (or unset) Occurrence Percentage, so Purchase never buys them at all — check Product Rules for this category and give more products a non-zero Occurrence Percentage; (2) too few suppliers selected for this category — a supplier can never receive two invoices on the same day, so concentrating a large amount on one day needs enough distinct suppliers to cover it at the batch's own Maximum Invoice Amount; (3) a single invoice line can never exceed a product's own configured Maximum Quantity no matter how much stock accumulates, so raising Quantity/Rate maximums for that category's products can also help. Otherwise: link additional/larger Purchase stock, reduce the amount or increase the invoice count for this Major Customer, or set up "Anticipated Major Customer Demand" on the Purchase batch for this exact customer next time.)`
              : `Try widening the date range, lowering the Minimum Invoice Amount, adjusting the batch's Quantity/Rate rules, or reducing the total amount so more combinations become reachable.)`),
        },
        { status: 400 },
      );
    }

    // Sum up the proposed quantities per date and product
    const proposedQtyMap = new Map<string, number>();
    for (const inv of invoices) {
      for (const p of inv.products) {
        const key = `${inv.invoice_date}_${p.product_id}`;
        const sum = (proposedQtyMap.get(key) || 0) + p.quantity;
        proposedQtyMap.set(key, sum);
      }
    }

    const { data: dbProducts } = await supabase
      .from("products")
      .select("id, product_name, unit_of_measure");
    const dbProductMap = new Map();
    (dbProducts || []).forEach((p) => dbProductMap.set(p.id, p));

    // 4. Construct the review rows by walking the requested date range and
    // carrying forward the new proposed sales per product. Day 1's opening
    // is the Leftover Stock seed (0 if none selected); purchased_quantity
    // per day comes only from fresh (untouched) Purchase Batch sources.
    const reviewRows: any[] = [];
    for (const productId of productIdsInScope) {
      const productObj = products.find((p: any) => p.product_id === productId);
      const dbProd = dbProductMap.get(productId);
      const productName =
        productObj?.product_name || dbProd?.product_name || "Product";
      const unit =
        productObj?.unit_of_measure || dbProd?.unit_of_measure || "kg";

      let carryForward = leftoverSeedByProduct.get(productId) || 0;

      for (const dateStr of dateList) {
        const opening = carryForward;
        const purchased = freshPurchasedByKey.get(`${dateStr}_${productId}`) || 0;

        const key = `${dateStr}_${productId}`;
        let proposed = proposedQtyMap.get(key) || 0;

        const available = roundToQuarterIncrement(opening + purchased);
        let remaining = roundToQuarterIncrement(available - proposed);

        // Perform final normalization step to strictly enforce Remaining ∈ [0, 15]
        if (remaining > 15) {
          proposed = roundToQuarterIncrement(proposed + (remaining - 15));
          remaining = 15;
        } else if (remaining < 0) {
          proposed = roundToQuarterIncrement(proposed + remaining);
          remaining = 0;
        }

        // Recompute to guarantee 0 <= remaining <= 15
        remaining = roundToQuarterIncrement(available - proposed);
        proposedQtyMap.set(key, proposed);

        reviewRows.push({
          date: dateStr,
          product_id: productId,
          product_name: productName,
          opening_stock: opening,
          purchased_quantity: purchased,
          proposed_sold: proposed,
          remaining_stock: remaining,
          unit: unit,
        });

        carryForward = remaining;
      }
    }

    // Adjust the invoices to match the normalized proposed quantities.
    // Major Customer invoices already carry their own exact,
    // separately-configured amount/category and must never be touched by
    // this reconciliation, in the preview any more than at save time.
    const majorCustomerIdsForReconcile = new Set<string>(
      (majorCustomers || [])
        .map((m: any) => m.customer_id)
        .filter(Boolean),
    );
    const reconciledInvoices = reconcileInvoicesToTargets(
      invoices,
      proposedQtyMap,
      mockBatch.products,
      mockBatch.receiving_company_id,
      Number(maximumInvoiceAmount) || undefined,
      majorCustomerIdsForReconcile,
      Number(minimumInvoiceAmount) || undefined,
    );
    invoices.length = 0;
    invoices.push(...reconciledInvoices);

    // Sort reviewRows by date ASC, then product_name ASC
    reviewRows.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.product_name.localeCompare(b.product_name);
    });

    console.log("DRY-RUN: invoices count:", invoices?.length);
    const stringifiedInvoices = JSON.stringify(invoices);
    console.log(
      "DRY-RUN: stringified invoices size:",
      stringifiedInvoices?.length,
    );
    if (invoices && invoices.length > 0) {
      console.log(
        "DRY-RUN: Sample Invoice:",
        JSON.stringify(invoices[0]).slice(0, 1000),
      );
    }
    const countPerDate = new Map<string, number>();
    for (const inv of invoices) {
      countPerDate.set(
        inv.invoice_date,
        (countPerDate.get(inv.invoice_date) || 0) + 1,
      );
    }
    console.log(
      "DRY-RUN: Invoices count per date:",
      Object.fromEntries(countPerDate),
    );

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
