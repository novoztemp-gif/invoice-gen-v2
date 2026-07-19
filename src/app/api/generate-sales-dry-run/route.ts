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
    console.log("DRY-RUN: raw ledgerData from DB:", JSON.stringify(ledgerData));

    // ── Build per-day stock picture ────────────────────────────────────────
    // For each product, walk the days in order and carry forward the
    // remaining stock so that opening(day n+1) = remaining(day n).
    //
    // We build two maps:
    //   perDayLedger   — full opening/purchased/prevSold/available per day
    //   availableStockMap — keyed by "date_productId" → available stock
    //                       (this is what the engine uses to derive purchased)
    //
    const productGroups = new Map<string, any[]>();
    for (const row of ledgerData || []) {
      if (!productGroups.has(row.product_id)) {
        productGroups.set(row.product_id, []);
      }
      productGroups.get(row.product_id)!.push(row);
    }

    // perDayLedger: "date_productId" → { opening, purchased, prevSold, available }
    const perDayLedger = new Map<
      string,
      {
        opening: number;
        purchased: number;
        prevSold: number;
        available: number;
      }
    >();

    // availableStockMap: "date_productId" → available stock for this day
    // The generator interprets this as  available ≈ opening + purchased
    // (it derives purchased = available - running_opening).
    // To make that derivation exact we store the true "opening + purchased"
    // (i.e. available before sales on that day, after applying carry-forward).
    const availableStockMap = new Map<string, any>();

    for (const [productId, rows] of productGroups.entries()) {
      // Sort rows chronologically
      rows.sort((a: any, b: any) => a.ledger_date.localeCompare(b.ledger_date));

      let carryForward = Number(rows[0].opening_stock) || 0;

      for (const row of rows) {
        const opening = carryForward;
        const purchased = Number(row.purchased_quantity) || 0;
        const prevSold = Number(row.sold_quantity) || 0;

        // Available before any new sales on this day
        const availableBeforeSales = opening + purchased;
        // Available after existing recorded sales
        const available = Math.max(0, availableBeforeSales - prevSold);

        const key = `${row.ledger_date}_${productId}`;
        perDayLedger.set(key, { opening, purchased, prevSold, available });

        // Store opening and purchased so the generator can derive available stock correctly
        availableStockMap.set(key, {
          opening: opening,
          purchased: Math.max(0, purchased - prevSold),
        });

        // Next day opens with whatever is left after recorded sales
        carryForward = available;
      }
    }

    // 2. Build the date list
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

    // 3. Generate proposed invoices in-memory using the redesigned sequential allocator
    const invoices = (InvoiceEngine as any).generateInvoiceSplitupsInternal(
      mockBatch,
      numberOfDays,
      fromDate,
      startingCounter,
      availableStockMap,
    );

    // Sum up the proposed quantities per date and product
    const proposedQtyMap = new Map<string, number>();
    const originalProposedQtyMap = new Map<string, number>();
    for (const inv of invoices) {
      for (const p of inv.products) {
        const key = `${inv.invoice_date}_${p.product_id}`;
        const sum = (proposedQtyMap.get(key) || 0) + p.quantity;
        proposedQtyMap.set(key, sum);
        originalProposedQtyMap.set(key, sum);
      }
    }

    // 4. Construct the review rows by chronologically carrying forward the new proposed sales per product
    const reviewRows: any[] = [];
    for (const [productId, rows] of productGroups.entries()) {
      // Sort rows chronologically
      rows.sort((a: any, b: any) => a.ledger_date.localeCompare(b.ledger_date));

      let carryForward = Number(rows[0].opening_stock) || 0;

      const productObj = products.find((p: any) => p.product_id === productId);
      const productName = productObj?.product_name || "Unknown Product";
      const unit = productObj?.unit_of_measure || "kg";

      for (const row of rows) {
        const opening = carryForward;
        const purchased = Number(row.purchased_quantity) || 0;
        const prevSold = Number(row.sold_quantity) || 0;

        const key = `${row.ledger_date}_${productId}`;
        let proposed = proposedQtyMap.get(key) || 0;

        const available =
          Math.round((opening + purchased - prevSold) * 100) / 100;
        let remaining = Math.round((available - proposed) * 100) / 100;

        // Perform final normalization step to strictly enforce Remaining ∈ [0, 15]
        if (remaining > 15) {
          proposed = Math.round((proposed + (remaining - 15)) * 100) / 100;
          remaining = 15;
        } else if (remaining < 0) {
          proposed = Math.round((proposed + remaining) * 100) / 100;
          remaining = 0;
        }

        // Recompute to guarantee 0 <= remaining <= 15
        remaining = Math.round((available - proposed) * 100) / 100;
        proposedQtyMap.set(key, proposed);

        reviewRows.push({
          date: row.ledger_date,
          product_id: productId,
          product_name: productName,
          opening_stock: opening,
          purchased_quantity: Math.max(0, purchased - prevSold),
          proposed_sold: proposed,
          remaining_stock: remaining,
          unit: unit,
        });

        carryForward = remaining;
      }
    }

    // Adjust the invoices to match the normalized proposed quantities
    for (const [key, normalizedProposed] of proposedQtyMap.entries()) {
      const [dateStr, productId] = key.split("_");
      const originalProposed = originalProposedQtyMap.get(key) || 0;
      const diff =
        Math.round((normalizedProposed - originalProposed) * 100) / 100;

      if (Math.abs(diff) > 0.001) {
        if (diff > 0) {
          // Increase: add the entire diff to the first matching invoice
          let matchingInv = invoices.find(
            (inv: any) =>
              inv.invoice_date === dateStr &&
              inv.products.some((p: any) => p.product_id === productId),
          );
          if (!matchingInv) {
            matchingInv = invoices.find(
              (inv: any) => inv.invoice_date === dateStr,
            );
          }
          if (matchingInv) {
            let prodObj = matchingInv.products.find(
              (p: any) => p.product_id === productId,
            );
            if (!prodObj) {
              const pConfig = mockBatch.products.find(
                (p: any) => p.product_id === productId,
              );
              const minRate = parseFloat(pConfig?.perDayRateMin) || 100;
              const maxRate = parseFloat(pConfig?.perDayRateMax) || 100;
              const rate =
                Math.round(
                  (minRate + Math.random() * (maxRate - minRate)) * 100,
                ) / 100;

              prodObj = {
                product_id: productId,
                product_name: pConfig?.product_name || "Unknown Product",
                hsn_code: pConfig?.hsn_code || "",
                unit_of_measure: pConfig?.unit_of_measure || "kg",
                quantity: 0,
                rate: rate,
                amount: 0,
                customer_id:
                  matchingInv.products[0]?.customer_id ||
                  mockBatch.receiving_company_id,
              };
              matchingInv.products.push(prodObj);
            }
            const oldQty = prodObj.quantity;
            const newQty = Math.round((oldQty + diff) * 100) / 100;
            prodObj.quantity = newQty;
            prodObj.amount = Math.round(newQty * prodObj.rate * 100) / 100;
            matchingInv.total_amount = matchingInv.products.reduce(
              (sum: any, p: any) => sum + p.amount,
              0,
            );
          }
        } else {
          // Decrease: subtract from matching invoices until diff is fully applied (diff is negative)
          let remainingDiff = Math.abs(diff);
          for (const inv of invoices) {
            if (inv.invoice_date === dateStr && remainingDiff > 0.001) {
              const prodObj = inv.products.find(
                (p: any) => p.product_id === productId,
              );
              if (prodObj) {
                const qtyToSubtract = Math.min(prodObj.quantity, remainingDiff);
                prodObj.quantity =
                  Math.round((prodObj.quantity - qtyToSubtract) * 100) / 100;
                prodObj.amount =
                  Math.round(prodObj.quantity * prodObj.rate * 100) / 100;
                if (prodObj.quantity <= 0.001) {
                  // Remove product from invoice
                  inv.products = inv.products.filter(
                    (p: any) => p.product_id !== productId,
                  );
                }
                inv.total_amount = inv.products.reduce(
                  (sum: any, p: any) => sum + p.amount,
                  0,
                );
                remainingDiff =
                  Math.round((remainingDiff - qtyToSubtract) * 100) / 100;
              }
            }
          }
        }
      }
    }

    // Filter out empty invoices (if any)
    const activeInvoices = invoices.filter(
      (inv: any) => inv.products.length > 0 && inv.total_amount > 0,
    );
    invoices.length = 0;
    invoices.push(...activeInvoices);

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
