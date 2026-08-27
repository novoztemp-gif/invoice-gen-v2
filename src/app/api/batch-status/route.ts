import { NextRequest, NextResponse } from "next/server";
import { InvoiceEngine } from "@/lib/services/InvoiceEngine";
import { checkPurchaseInvoiceAmountRange } from "@/lib/services/purchase-balance/types";
import { createClient } from "@/lib/supabase/server";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";

export async function POST(request: NextRequest) {
  try {
    const { batchId, action } = await request.json();

    if (!batchId || !action) {
      return NextResponse.json(
        { message: "Missing batchId or action" },
        { status: 400 },
      );
    }

    if (action !== "FINALIZE" && action !== "REOPEN") {
      return NextResponse.json({ message: "Invalid action" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    if (action === "FINALIZE") {
      let invoices: any[] = [];
      try {
        invoices = await fetchAllInvoicesForBatch(supabase, batchId);
      } catch (fetchError: any) {
        return NextResponse.json(
          { message: "Failed to fetch invoices for finalization check." },
          { status: 500 },
        );
      }

      if (!invoices || invoices.length === 0) {
        return NextResponse.json(
          { message: "Cannot finalize a batch with no invoices." },
          { status: 400 },
        );
      }

      const invalidInvoices: string[] = [];
      for (const inv of invoices) {
        const validation = InvoiceEngine.validateInvoiceData(inv);
        if (!validation.isValid) {
          invalidInvoices.push(
            `${inv.invoice_number || inv.id}: ${validation.message}`,
          );
        }
      }

      if (invalidInvoices.length > 0) {
        return NextResponse.json(
          {
            message:
              "Batch finalization blocked. The following invoices violate accounting rules (negative or zero values found):",
            details: invalidInvoices,
          },
          { status: 400 },
        );
      }

      // Invoice Amount Range (Sprint 1.5A for Purchase; extended to Sales
      // in Sprint 1.7R) — finalization must not rely solely on
      // generation-time enforcement, since editing can (subject to its own
      // grandfather rule) leave an invoice outside [minimum_invoice_amount,
      // maximum_invoice_amount]. Unlike the edit-time check, this is an
      // ABSOLUTE gate with no grandfathering — a batch may not become
      // FINALIZED while any invoice violates the configured range, full
      // stop. checkPurchaseInvoiceAmountRange is purely arithmetic (total
      // vs. min/max) despite its Purchase-sounding name/module — reused
      // as-is here rather than duplicating the same range math for Sales.
      // No stock/ledger data is touched here.
      const { data: batchForRangeCheck } = await supabase
        .from("invoice_batch")
        .select(
          "batch_type, minimum_invoice_amount, maximum_invoice_amount, major_customers",
        )
        .eq("id", batchId)
        .single();

      if (
        batchForRangeCheck?.batch_type === "PURCHASE" ||
        batchForRangeCheck?.batch_type === "SALES"
      ) {
        // Major customer/supplier invoices are budgeted against THEIR OWN
        // configured max_invoice_amount (set per major customer, often
        // deliberately different from the batch's normal invoice amount
        // range) — not the batch-wide minimum/maximum every other invoice
        // follows. Checking them against the normal range was flagging
        // legitimately-configured major-customer invoices as violations.
        // There's no separate minimum for major customers (
        // MajorCustomerConfig only has max_invoice_amount), so only the
        // upper bound is checked for these — the batch-wide minimum still
        // applies to every other (non-major) invoice as before.
        const majorMaxById = new Map<string, number>();
        for (const m of batchForRangeCheck.major_customers || []) {
          const maxAmt =
            typeof m.max_invoice_amount === "string"
              ? parseFloat(m.max_invoice_amount)
              : m.max_invoice_amount;
          if (m.customer_id && maxAmt && maxAmt > 0) {
            majorMaxById.set(m.customer_id, maxAmt);
          }
        }

        const rangeViolations: string[] = [];
        for (const inv of invoices) {
          const invCustomerId =
            inv.customer_id ||
            inv.supplier_id ||
            inv.products?.[0]?.customer_id ||
            inv.products?.[0]?.supplier_id;
          const majorMax = invCustomerId
            ? majorMaxById.get(invCustomerId)
            : undefined;

          const check = majorMax
            ? checkPurchaseInvoiceAmountRange(inv.total_amount, null, majorMax)
            : checkPurchaseInvoiceAmountRange(
                inv.total_amount,
                batchForRangeCheck.minimum_invoice_amount,
                batchForRangeCheck.maximum_invoice_amount,
              );
          if (!check.valid) {
            const rangeDesc =
              check.reason === "BELOW_MIN"
                ? `below minimum ₹${(check.min ?? 0).toFixed(2)}`
                : `above maximum ₹${(check.max ?? 0).toFixed(2)}${majorMax ? " (major customer limit)" : ""}`;
            rangeViolations.push(
              `${inv.invoice_number || inv.id}: ₹${check.total.toFixed(2)} (${rangeDesc})`,
            );
          }
        }

        if (rangeViolations.length > 0) {
          return NextResponse.json(
            {
              message:
                "Batch finalization blocked. The following invoices are outside the batch's configured invoice amount range:",
              details: rangeViolations,
            },
            { status: 400 },
          );
        }
      }

      // A SALES batch's source purchase batch already gets its
      // daily_stock_ledger.sold_quantity updated at batch-creation time
      // (the moment the user confirms Auto Allocate/Null in the Daily
      // Stock Review modal) — postSalesBatchStockLedger is NOT idempotent
      // (it ADDS to whatever's already recorded), so it must never be
      // called again here. If the user finalizes without ever clicking
      // "Generate Splitup" to reveal invoices, just flip status so the
      // batch isn't left showing "pending" invoices once it's finalized —
      // no ledger call needed, that part is already done.
      const stillPending = invoices.some((inv: any) => inv.status === "pending");
      if (stillPending) {
        // Hotfix — neither update's result used to be checked at all
        // (not even destructured). If either failed (RLS denial,
        // transient error), execution fell straight through to
        // updateBatchStatus below and marked the batch FINALIZED anyway
        // — leaving it permanently finalized while its invoices stayed
        // stuck at status "pending", with nothing surfacing that
        // mismatch. Both must succeed before finalization proceeds.
        const { error: invoiceUpdateError } = await supabase
          .from("invoice")
          .update({ status: "generated" })
          .eq("invoice_batch_id", batchId);
        if (invoiceUpdateError) {
          throw new Error(
            `Failed to update invoice status before finalizing: ${invoiceUpdateError.message}`,
          );
        }

        const { error: batchUpdateError } = await supabase
          .from("invoice_batch")
          .update({ status: "generated" })
          .eq("id", batchId);
        if (batchUpdateError) {
          throw new Error(
            `Failed to update batch status before finalizing: ${batchUpdateError.message}`,
          );
        }
      }
    }

    await InvoiceEngine.updateBatchStatus(supabase, batchId, action, user.id);

    return NextResponse.json({
      success: true,
      message: `Batch successfully ${action === "FINALIZE" ? "finalized" : "reopened"}.`,
    });
  } catch (error: any) {
    console.error("Batch Status API Error:", error);
    return NextResponse.json(
      { message: error.message || "An unexpected error occurred" },
      { status: 500 },
    );
  }
}
