import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { InvoiceNumberingService } from "@/lib/services/InvoiceNumberingService";
import { validateCategoryOccurrenceConfiguration } from "@/lib/services/ProductOccurrenceService";
import {
  computeDailyChronologicalStock,
  type StockLedgerRow,
  validateStockConservation,
} from "@/lib/services/StockCalculationService";
import { checkPurchaseInvoiceAmountRange } from "@/lib/services/purchase-balance/types";
import { fetchAllQueryRows, fetchRowsByIds } from "@/lib/supabase/fetchAll";
import { createClient } from "@/lib/supabase/server";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import { repairInvoiceAmountRange } from "@/lib/utils/reconcile-invoice-quantities";

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
      occurrenceSemantics,
      categoryAllocation,
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
        const realProducts = await fetchRowsByIds(
          (chunk) =>
            supabase.from("products").select("id, category").in("id", chunk),
          productIds,
        );
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

    // Sprint 1.7S/1.7T — Product Occurrence config gate. This route is the
    // sole authoritative persistence point for a Sales batch (unlike
    // Purchase, whose batch row is inserted directly from the client) — an
    // invalid occurrence configuration must never reach the invoice_batch
    // insert below.
    //
    // Sprint 1.7S originally scoped this to CATEGORY only, because this
    // route's `products` payload didn't carry per-product
    // occurrencePercentage at all — running the full GLOBAL/legacy
    // validator would have rejected every Sales batch. Sprint 1.7T's own
    // audit found that gap and fixed it directly in useInvoiceForm.ts's
    // handleSaveSalesBatch (the only real caller of this route), which now
    // always sends occurrencePercentage. That fix removes the reason for
    // the CATEGORY-only scoping: with it in place, a direct/bypassed call
    // to this route (skipping the UI's own client-side check entirely)
    // could otherwise persist a GLOBAL/NULL-semantics batch — plus its
    // actual invoices, since the invoicesOverride path below never calls
    // InvoiceEngine.generateAndSaveInvoices and therefore never reaches
    // the Sprint 1.7N post-generation gate either — with an invalid or
    // missing occurrence configuration, completely unvalidated. Running
    // this check unconditionally (GLOBAL and null delegate straight to the
    // existing validateOccurrenceConfiguration, unchanged) closes that
    // persistence-boundary gap.
    const resolvedOccurrenceSemantics: "GLOBAL" | "CATEGORY" | null =
      occurrenceSemantics === "CATEGORY" ? "CATEGORY" : occurrenceSemantics === "GLOBAL" ? "GLOBAL" : null;
    const occConfigValidation = validateCategoryOccurrenceConfiguration(
      products || [],
      categoryAllocation || null,
      resolvedOccurrenceSemantics,
    );
    if (!occConfigValidation.valid) {
      return NextResponse.json(
        {
          message: `Product Occurrence Configuration Invalid: ${occConfigValidation.errors.join(" ")}`,
        },
        { status: 400 },
      );
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

    // ledgerData is passed directly to validateStockConservation() below,
    // right before the invoicesOverride insert — that call is the actual
    // consumer of this ledger fetch; see the Sprint 1.3B comment there.

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
        category_allocation:
          resolvedOccurrenceSemantics === "CATEGORY"
            ? categoryAllocation
            : null,
        occurrence_semantics: resolvedOccurrenceSemantics,
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

      // Last-chance safety net before insert: whatever combination of
      // generation/reconciliation/price-solving produced these lines, no
      // line may leave here outside its Product Rule [rate_min, rate_max],
      // and no zero-quantity line may survive (roundToQuarterIncrement can
      // round a quantity below 0.125 down to exactly 0 — every upstream
      // "drop empty lines" filter uses a finer 0.001 threshold, so a line
      // in that gap slips through them all and only becomes exactly zero
      // right here).
      const rateRangeById = new Map<string, { min: number; max: number }>();
      for (const p of products || []) {
        const min = parseFloat(p.perDayRateMin);
        const max = parseFloat(p.perDayRateMax);
        if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
          rateRangeById.set(p.product_id || p.id, { min, max });
        }
      }

      // Hotfix — chronological invoice numbering. invoicesOverride's array
      // order was used directly for seqCounter below — but
      // reconcileInvoicesToTargets (the Daily Stock Review reconciliation
      // this override comes from) can append brand-new "overflow"
      // invoices at the END of the array regardless of their own date, to
      // avoid ever exceeding maximumInvoiceAmount on an existing invoice.
      // Without a re-sort here, that gave those invoices a number block
      // completely divorced from their real dates — e.g. #512 and #532
      // both dated Aug 1 and Aug 2, interleaved, with the number bearing
      // no relationship to the date. A stable sort by invoice_date
      // guarantees the assigned sequence number always increases with
      // date, matching what a real invoicing system needs — same fix
      // already applied on the generation side (generateInvoiceSplitupsInternal),
      // needed again here because this override path bypasses that sort
      // entirely.
      const sortedInvoicesOverride = [...invoicesOverride].sort((a, b) =>
        String(a.invoice_date || "").localeCompare(String(b.invoice_date || "")),
      );

      // Quantity quarter-rounding compensation: rounding each line to the
      // nearest 0.25 independently does NOT preserve the sum across lines
      // that split the same (date, product) target across multiple
      // invoices — e.g. three lines of 6.833/6.833/6.834 (summing to an
      // exact 20.50) each round DOWN to 6.75, persisting a total of 20.25.
      // That 0.25 shortfall then reads as unsold stock and survives as
      // leftover carried into next month's opening stock even when the
      // user picked "Null" (sell everything) with no manual edits. Fix:
      // round each line first as before, then redistribute the rounding
      // drift within each (date, product) group by nudging lines up/down
      // in 0.25 steps until the rounded sum matches the pre-rounding sum
      // rounded to the nearest 0.25.
      const rawLines: {
        invIndex: number;
        prod: any;
        qty: number;
        originalQty: number;
        rate: number;
      }[] = [];
      sortedInvoicesOverride.forEach((inv: any, invIndex: number) => {
        for (const p of inv.products || []) {
          const originalQty = Number(p.quantity || 0);
          const qty = roundToQuarterIncrement(originalQty);
          let rate = Math.round(Number(p.rate || 1));
          const range = rateRangeById.get(p.product_id);
          if (range) {
            rate = Math.min(range.max, Math.max(range.min, rate));
          }
          rawLines.push({ invIndex, prod: p, qty, originalQty, rate });
        }
      });

      const groups = new Map<string, typeof rawLines>();
      for (const line of rawLines) {
        const key = `${sortedInvoicesOverride[line.invIndex].invoice_date}_${line.prod.product_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(line);
      }
      for (const groupLines of groups.values()) {
        const rawSum = groupLines.reduce((s, l) => s + l.originalQty, 0);
        const targetSum = roundToQuarterIncrement(rawSum);
        let roundedSum = groupLines.reduce((s, l) => s + l.qty, 0);
        let diff = Math.round((targetSum - roundedSum) / 0.25) * 0.25;
        let guard = 0;
        while (Math.abs(diff) >= 0.125 && guard < 10000) {
          guard++;
          if (diff > 0) {
            const target = groupLines.reduce((a, b) => (b.qty > a.qty ? b : a));
            target.qty = Math.round((target.qty + 0.25) * 1000) / 1000;
            diff -= 0.25;
          } else {
            const candidates = groupLines.filter((l) => l.qty >= 0.25);
            if (candidates.length === 0) break;
            const target = candidates.reduce((a, b) => (b.qty > a.qty ? b : a));
            target.qty = Math.round((target.qty - 0.25) * 1000) / 1000;
            diff += 0.25;
          }
        }
      }

      // Hotfix — real numbering defects confirmed on a real batch: an
      // invoice number (e.g. #165) missing entirely from the sequence, and
      // brand-new "overflow" invoices (opened later by
      // repairInvoiceAmountRange below) landing in the correct DATE
      // position but keeping a NUMBER from the tail of the counter (e.g.
      // #390 sitting between #114 and #115). Root cause: invoice_number
      // used to be assigned HERE, before repairInvoiceAmountRange ran —
      // which can both REMOVE invoices (merging a below-minimum invoice
      // into a peer, permanently orphaning that invoice's
      // already-assigned number) and ADD brand-new ones (shed overflow),
      // numbered by simply continuing the counter from wherever the first
      // pass left off, with no relationship to that new invoice's actual
      // date. Fixed by deferring ALL numbering to a single final pass,
      // below, after repairInvoiceAmountRange has finished adding and
      // removing invoices — every survivor gets numbered together, once,
      // in true date order, so numbers are always gap-free and always
      // increase with date, whether an invoice came from the original
      // pass or was opened during repair.
      const invoicesToInsert = sortedInvoicesOverride.map((inv: any, invIndex: number) => {
        const normalizedProducts = rawLines
          .filter((l) => l.invIndex === invIndex)
          .map((l) => {
            const amt = Math.round(l.qty * l.rate);
            return {
              ...l.prod,
              quantity: l.qty,
              amount: amt,
              rate: l.rate,
            };
          })
          .filter((p: any) => p.quantity > 0);

        const totalAmt = Math.round(
          normalizedProducts.reduce(
            (sum: number, p: any) => sum + Math.round(p.amount || 0),
            0,
          ),
        );

        return {
          invoice_batch_id: newBatch.id,
          invoice_date: inv.invoice_date,
          total_amount: totalAmt,
          products: normalizedProducts,
          // The leftover/sold split was already decided and confirmed by
          // the user in the Daily Stock Review modal (Null or Auto
          // Allocate), so the ledger gets updated immediately below,
          // independent of whatever happens to this batch afterward. But
          // that ledger commitment is separate from the invoice/batch
          // "generated" status, which is purely a UI reveal state — the
          // user still explicitly clicks "Generate Splitup" on the batch
          // details page to reveal line items, so invoices stay "pending"
          // here.
          status: "pending",
          batch_type: "SALES",
        };
      }).filter((inv: any) => inv.products.length > 0);

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
        "invoices before repair:",
        invoicesToInsert.length,
      );
      console.log("==========================================");

      // ── Server-side invoice amount range self-correction ────────────────
      // Hotfix: reconcileInvoicesToTargets/enforceMinimumInvoiceAmount/
      // solveRatesToHitTotal (the Daily Stock Review reconciliation this
      // invoicesOverride comes from) each have documented "last resort"
      // escape hatches that can leave an invoice below minimumInvoiceAmount
      // or above maximumInvoiceAmount when no compatible same-date/
      // category invoice has room to absorb the difference — confirmed on
      // a real batch (5 regular invoices out of range, e.g. ₹5,181 against
      // a ₹7,000–49,800 configured range). Rather than reject the whole
      // batch over this, repairInvoiceAmountRange actually fixes it here:
      // sheds excess from over-max invoices to same-date/category peers (or
      // opens a new invoice for the overflow), merges under-min invoices
      // into peers, and as a last resort grows a still-under-min invoice's
      // existing lines within REAL remaining stock — computed the same way
      // (computeDailyChronologicalStock) the stock-conservation check right
      // below this uses, so growth here can never oversell past what that
      // check would allow anyway. Major Customer invoices are excluded
      // (checked against their own max_invoice_amount, not this range).
      // Only if genuinely nothing could be done (real stock exhausted) does
      // this still reject, with the same clear per-invoice message as
      // before — now the true last resort instead of the first response.
      const majorCustomerIdSet = new Set<string>(
        (majorCustomers || [])
          .map((m: any) => m.customer_id)
          .filter(Boolean),
      );
      const dailyStock = computeDailyChronologicalStock(
        ledgerData as StockLedgerRow[],
      );
      const remainingStockByDateProduct = new Map<string, number>();
      for (const day of dailyStock) {
        remainingStockByDateProduct.set(
          `${day.ledger_date}_${day.product_id}`,
          day.closing,
        );
      }
      for (const inv of invoicesToInsert) {
        for (const p of inv.products || []) {
          const key = `${inv.invoice_date}_${p.product_id}`;
          remainingStockByDateProduct.set(
            key,
            Math.max(
              0,
              (remainingStockByDateProduct.get(key) || 0) -
                Number(p.quantity || 0),
            ),
          );
        }
      }

      const repairResult = repairInvoiceAmountRange(
        invoicesToInsert,
        parseFloat(minimumInvoiceAmount) || 0,
        parseFloat(maximumInvoiceAmount) || 0,
        products || [],
        remainingStockByDateProduct,
        receivingCompanyId,
        majorCustomerIdSet,
      );
      const repairedInvoices = repairResult.invoices;

      if (repairResult.stillViolating.length > 0) {
        const majorMaxById = new Map<string, number>();
        for (const m of majorCustomers || []) {
          const maxAmt =
            typeof m.max_invoice_amount === "string"
              ? parseFloat(m.max_invoice_amount)
              : m.max_invoice_amount;
          if (m.customer_id && maxAmt && maxAmt > 0) {
            majorMaxById.set(m.customer_id, maxAmt);
          }
        }
        const rangeViolations = repairResult.stillViolating.map((inv: any) => {
          const invCustomerId =
            (inv as any).customer_id || inv.products?.[0]?.customer_id;
          const majorMax = invCustomerId
            ? majorMaxById.get(invCustomerId)
            : undefined;
          const check = majorMax
            ? checkPurchaseInvoiceAmountRange(inv.total_amount, null, majorMax)
            : checkPurchaseInvoiceAmountRange(
                inv.total_amount,
                parseFloat(minimumInvoiceAmount),
                parseFloat(maximumInvoiceAmount),
              );
          const rangeDesc = !check.valid
            ? check.reason === "BELOW_MIN"
              ? `below minimum ₹${(check.min ?? 0).toFixed(2)}`
              : `above maximum ₹${(check.max ?? 0).toFixed(2)}${majorMax ? " (major customer limit)" : ""}`
            : "range violation";
          // Numbering hasn't run yet at this point (moved to after repair
          // so it can number every survivor gap-free — see the comment at
          // invoicesToInsert above), so identify by date here instead.
          return `invoice dated ${inv.invoice_date || "unknown date"}: ₹${check.total.toFixed(2)} (${rangeDesc})`;
        });
        await supabase.from("invoice_batch").delete().eq("id", newBatch.id);
        return NextResponse.json(
          {
            message: `Batch creation blocked. Could not automatically fix ${repairResult.stillViolating.length} invoice(s) outside the configured amount range — real remaining stock ran out before they could be brought into range: ${rangeViolations.join(", ")}. Try linking more/bigger Purchase stock, adjusting the Daily Stock Ledger allocation, or widening the invoice amount range.`,
          },
          { status: 400 },
        );
      }

      // repairInvoiceAmountRange can open brand-new invoices for shed
      // overflow (no compatible peer had room) — those only carry
      // invoice_date/customer_id/products/total_amount, not yet the
      // DB-required fields every other invoice already has. Backfill those
      // here; invoice_number itself is assigned below, in one single pass
      // over every survivor together (see the comment at invoicesToInsert
      // above for why numbering was moved here instead of before repair).
      for (const inv of repairedInvoices) {
        if (!(inv as any).invoice_batch_id) {
          (inv as any).invoice_batch_id = newBatch.id;
          (inv as any).status = "pending";
          (inv as any).batch_type = "SALES";
        }
      }

      // Single, final numbering pass — every invoice that survived repair
      // (original or newly-opened), sorted by date, numbered together in
      // one gap-free, strictly date-increasing sequence. A stable sort
      // preserves same-date relative order from the earlier date sort.
      const finalSortedInvoices = [...repairedInvoices].sort((a: any, b: any) =>
        String(a.invoice_date || "").localeCompare(String(b.invoice_date || "")),
      );
      let seqCounter = startingCounter;
      for (const inv of finalSortedInvoices) {
        (inv as any).invoice_number = InvoiceNumberingService.formatInvoiceNumber(
          companyAbbr,
          canonicalFy,
          "S",
          seqCounter++,
        );
      }

      // ── Server-side stock conservation (Sprint 1.3B) ──────────────────
      // The Daily Stock Review modal already blocks proposed_sold >
      // available client-side, but nothing re-checked it here — this is
      // the final authoritative point before anything is persisted.
      // Rejects the ENTIRE request (no partial save) since nothing has
      // been inserted into the invoice table yet at this point — only the
      // invoice_batch row exists so far, rolled back below on failure.
      const proposedLines = repairedInvoices.flatMap((inv: any) =>
        (inv.products || []).map((p: any) => ({
          product_id: p.product_id,
          ledger_date: inv.invoice_date,
          quantity: Number(p.quantity || 0),
        })),
      );
      const conservation = validateStockConservation(
        ledgerData as StockLedgerRow[],
        proposedLines,
      );

      if (!conservation.valid) {
        await supabase.from("invoice_batch").delete().eq("id", newBatch.id);

        if (conservation.negativeQuantityLines.length > 0) {
          const detail = conservation.negativeQuantityLines
            .map((l) => `${l.product_id} on ${l.ledger_date} (${l.quantity})`)
            .join("; ");
          return NextResponse.json(
            {
              message: `Invalid quantity: negative quantities are not allowed — ${detail}.`,
            },
            { status: 400 },
          );
        }

        const detail = conservation.violations
          .map(
            (v) =>
              `Product ${v.product_id} on ${v.ledger_date}: requested ${v.requested}, available ${v.available}`,
          )
          .join("; ");
        return NextResponse.json(
          {
            message: `Stock conservation violation — requested sold quantity exceeds available stock: ${detail}.`,
          },
          { status: 400 },
        );
      }

      // ── Rate-only force-close (fast fix for residual reconciliation drift) ──
      // The client-side Daily Stock Ledger reconciliation
      // (solveRatesToHitTotal/repairInvoiceAmountRange) can leave a small
      // residual drift under real constraints even after the earlier
      // per-line ±1 rupee nudge fix — confirmed live on a real batch
      // (configured ₹15,721,419, reconciled ₹15,729,661, ₹8,242 off).
      // Quantity is locked (already confirmed via the Daily Stock Ledger
      // review, and the stock-conservation check above already passed
      // against these exact quantities), so this closes any remaining gap
      // by nudging RATE only, walking invoices/lines from last to first,
      // bounded by each product's real [rate_min, rate_max] — same
      // force-close philosophy as InvoiceEngine's generation path,
      // implemented inline here since this route can't call InvoiceEngine's
      // private solving methods directly.
      {
        const targetTotal = Math.round(parseFloat(totalAmount));
        let currentTotal = Math.round(
          repairedInvoices.reduce(
            (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
            0,
          ),
        );
        let remaining = targetTotal - currentTotal;

        const orderedInvoices = [...repairedInvoices].reverse();
        for (const inv of orderedInvoices as any[]) {
          if (remaining === 0) break;
          const lines = [...(inv.products || [])].reverse();
          for (const p of lines as any[]) {
            if (remaining === 0) break;
            const qty = Number(p.quantity || 0);
            if (qty <= 0) continue;
            const range = rateRangeById.get(p.product_id);
            const curRate = Math.round(Number(p.rate || 1));
            const minRate = range ? range.min : 1;
            const maxRate = range ? range.max : Infinity;

            const desiredDeltaRate = remaining / qty;
            const deltaRate =
              remaining > 0
                ? Math.ceil(desiredDeltaRate)
                : Math.floor(desiredDeltaRate);
            const newRate = Math.max(
              minRate,
              Math.min(maxRate, curRate + deltaRate),
            );
            if (newRate === curRate) continue;

            const oldAmt = Math.round(qty * curRate);
            const newAmt = Math.round(qty * newRate);
            p.rate = newRate;
            p.amount = newAmt;
            inv.total_amount = Math.round(
              (inv.total_amount || 0) - oldAmt + newAmt,
            );
            remaining -= newAmt - oldAmt;
          }
        }
      }

      // ── Server-side exact-total guard ────────────────────────────────
      // Explicit client requirement: the saved batch total must match the
      // configured Total Amount to the exact rupee, never even ₹1 off.
      // generateInvoiceSplitupsInternal (the dry-run generator) already
      // hard-rejects this upstream, but invoicesOverride here reflects
      // whatever the client's own reconciliation (solveRatesToHitTotal,
      // repairInvoiceAmountRange, quarter-rounding compensation) produced
      // — each of those can, in principle, leave a residual under real
      // constraints, and nothing re-verified the FINAL sum at the actual
      // persistence boundary. This is that final check: reject the entire
      // batch (nothing inserted yet) rather than ever save a total that
      // doesn't match what was configured.
      const savedTotal = Math.round(
        repairedInvoices.reduce(
          (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
          0,
        ),
      );
      const configuredTotal = Math.round(parseFloat(totalAmount));
      if (savedTotal !== configuredTotal) {
        await supabase.from("invoice_batch").delete().eq("id", newBatch.id);
        return NextResponse.json(
          {
            message: `Sales Batch Total mismatch: configured Total Amount is ₹${configuredTotal}, but the reconciled invoices sum to ₹${savedTotal} (₹${configuredTotal - savedTotal} short of exact). Nothing was saved. Try adjusting the Daily Stock Ledger allocation or widening the invoice amount range, then regenerate.`,
          },
          { status: 400 },
        );
      }

      // Hotfix: a large batch's invoice insert is one bulk request (several
      // hundred KB+ of JSONB for a few hundred invoices) — PostgREST wraps
      // it in a single transaction, so it's all-or-nothing (safe to retry
      // whole), but that also means it's the single slowest, most
      // network-timeout-prone call in this whole route. Confirmed on a
      // real batch: "TypeError: fetch failed" / "read ETIMEDOUT" after 64s
      // on the first attempt — a transient network condition, not a data
      // or logic problem (the exact same payload had already passed the
      // stock-conservation check above). Retrying once, same pattern
      // already used for postSalesBatchStockLedger below, turns a
      // momentary network blip into a silent success instead of losing
      // the whole batch and forcing the user to regenerate from scratch.
      // repairInvoiceAmountRange (and reconcileInvoicesToTargets before it)
      // build their own brand-new invoice objects with a top-level
      // `customer_id` — needed internally (isMajorInvoice/getCategory
      // fallbacks) since a freshly-opened invoice has no products yet at
      // the moment those checks might run — but `public.invoice` has no
      // such column; every invoice's real customer lives on each line's
      // own `products[].customer_id` instead. Previously unreachable in
      // practice (the shed-overflow path that creates these objects used
      // to give up before ever getting there), so this is a real,
      // confirmed regression once that path started succeeding: "Could
      // not find the 'customer_id' column of 'invoice' in the schema
      // cache". Strip it here, at the actual insert boundary, rather than
      // in every construction site upstream.
      const invoicesForInsert = repairedInvoices.map((inv: any) => {
        const { customer_id, ...rest } = inv;
        return rest;
      });

      let insertedInvoices: any[] | null = null;
      let invoiceInsertError: { message: string } | null = null;
      {
        const attempt1 = await supabase
          .from("invoice")
          .insert(invoicesForInsert)
          .select();
        if (attempt1.error) {
          console.error(
            "Error inserting sales invoices, retrying once:",
            attempt1.error,
          );
          const attempt2 = await supabase
            .from("invoice")
            .insert(invoicesForInsert)
            .select();
          insertedInvoices = attempt2.data;
          invoiceInsertError = attempt2.error;
        } else {
          insertedInvoices = attempt1.data;
        }
      }

      if (invoiceInsertError) {
        console.error(
          "Error inserting sales invoices (after retry):",
          invoiceInsertError,
        );
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
      // stays as leftover vs. gets sold, so the very next sales batch sees
      // the correct leftover regardless of when (or whether) this batch's
      // invoices get revealed/finalized. postSalesBatchStockLedger is NOT
      // idempotent (it ADDS to whatever's already recorded), so it must
      // only ever run here, exactly once — /api/reveal-sales-batch-splitup
      // and the Finalize fallback in /api/batch-status only flip status
      // now, they no longer call it.
      //
      // The batch row and every invoice are already durably committed by
      // this point, so a transient failure in this bookkeeping step (e.g.
      // a momentary PostgREST timeout re-reading the invoices we just
      // inserted) must never turn an already-successful save into a scary
      // generic error popup for the user. Retry once, and if it still
      // fails, still report success (the batch is genuinely fine) but say
      // exactly what didn't happen instead of a vague failure.
      let ledgerWarning: string | null = null;
      if (stockSourceBatchId) {
        try {
          await InvoiceEngine.postSalesBatchStockLedger(
            supabase,
            newBatch.id,
            stockSourceBatchId,
          );
        } catch (ledgerErr: any) {
          console.error(
            "postSalesBatchStockLedger failed, retrying once:",
            ledgerErr,
          );
          try {
            await InvoiceEngine.postSalesBatchStockLedger(
              supabase,
              newBatch.id,
              stockSourceBatchId,
            );
          } catch (retryErr: any) {
            console.error(
              "postSalesBatchStockLedger failed again after retry:",
              retryErr,
            );
            ledgerWarning = `Batch and invoices saved successfully, but updating the stock leftover ledger failed: ${retryErr?.message || "unknown error"}. Leftover shown for the next sales batch from this source may be stale until this is retried.`;
          }
        }
      }
      // invoice_batch.status stays "pending" (as inserted above) — the
      // user still explicitly clicks "Generate Splitup" to reveal the
      // invoices, that click flips status to "generated".
      if (ledgerWarning) {
        return NextResponse.json({
          success: true,
          batchId: newBatch.id,
          invoicesCount: savedInvoices.length,
          proposedInvoices: savedInvoices,
          message: ledgerWarning,
        });
      }
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
