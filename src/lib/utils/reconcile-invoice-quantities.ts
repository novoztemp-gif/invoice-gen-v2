/**
 * Adjusts a set of generated invoices so that the summed quantity per
 * date+product matches a target map exactly, redistributing the delta
 * across that date's invoices.
 *
 * Used by both the sales dry-run generator (to enforce remaining-stock
 * bounds) and the Daily Stock Ledger review save path (to make the user's
 * Null/Auto Allocate/manual edits actually apply to what gets persisted).
 */
export function reconcileInvoicesToTargets(
  invoices: any[],
  targetQtyMap: Map<string, number>,
  productConfigs: any[],
  fallbackCustomerId?: string | null,
  maximumInvoiceAmount?: number,
): any[] {
  const currentQtyMap = new Map<string, number>();
  for (const inv of invoices) {
    for (const p of inv.products || []) {
      const key = `${inv.invoice_date}_${p.product_id}`;
      currentQtyMap.set(
        key,
        (currentQtyMap.get(key) || 0) + Number(p.quantity || 0),
      );
    }
  }

  for (const [key, targetQty] of targetQtyMap.entries()) {
    const sepIdx = key.indexOf("_");
    const dateStr = key.slice(0, sepIdx);
    const productId = key.slice(sepIdx + 1);
    const currentQty = currentQtyMap.get(key) || 0;
    const diff = Math.round((targetQty - currentQty) * 100) / 100;

    if (Math.abs(diff) <= 0.001) continue;

    const sameDateInvoices = invoices.filter(
      (inv: any) => inv.invoice_date === dateStr,
    );
    const pConfig = productConfigs.find(
      (p: any) => p.product_id === productId,
    );
    const minRate = parseFloat(pConfig?.perDayRateMin) || 100;
    const maxRate = parseFloat(pConfig?.perDayRateMax) || 100;

    const headroomOf = (inv: any) =>
      maximumInvoiceAmount
        ? Math.max(0, maximumInvoiceAmount - Number(inv.total_amount || 0))
        : Infinity;

    if (diff > 0) {
      // Increase: spread the diff across same-date invoices that have room
      // under maximumInvoiceAmount — never dump it all onto a single
      // invoice regardless of its limit. Existing lines for this product
      // get topped up first, then new lines are added to invoices that
      // don't carry it yet, and only if literally no invoice has any room
      // left does it fall back to exceeding the cap (logged, not silent).
      let remainingDiff = diff;

      for (const inv of sameDateInvoices) {
        if (remainingDiff <= 0.001) break;
        const prodObj = inv.products.find(
          (p: any) => p.product_id === productId,
        );
        if (!prodObj) continue;
        const headroom = headroomOf(inv);
        if (headroom <= 0) continue;
        const rate = prodObj.rate || Math.round((minRate + maxRate) / 2) || 1;
        const qtyToAdd = Math.min(remainingDiff, headroom / rate);
        if (qtyToAdd <= 0) continue;
        prodObj.quantity = Math.round((prodObj.quantity + qtyToAdd) * 100) / 100;
        prodObj.amount = Math.round(prodObj.quantity * prodObj.rate * 100) / 100;
        inv.total_amount = inv.products.reduce(
          (sum: any, p: any) => sum + p.amount,
          0,
        );
        remainingDiff = Math.round((remainingDiff - qtyToAdd) * 100) / 100;
      }

      if (remainingDiff > 0.001) {
        const newLineCategory = String(
          pConfig?.category || "Meat",
        ).toUpperCase();
        for (const inv of sameDateInvoices) {
          if (remainingDiff <= 0.001) break;
          if (inv.products.some((p: any) => p.product_id === productId))
            continue;
          // Never add a product onto an invoice that already carries a
          // DIFFERENT category — category purity is a hard business rule
          // elsewhere in this pipeline, and this reconciliation step
          // (adding a brand-new line to make a target quantity match) was
          // the one place that never checked it.
          const invCategory = inv.products[0]?.category
            ? String(inv.products[0].category).toUpperCase()
            : null;
          if (invCategory && invCategory !== newLineCategory) continue;
          const headroom = headroomOf(inv);
          if (headroom <= 0) continue;
          const rate = Math.round((minRate + maxRate) / 2) || 1;
          const qtyToAdd = Math.min(remainingDiff, headroom / rate);
          if (qtyToAdd <= 0) continue;
          inv.products.push({
            product_id: productId,
            product_name: pConfig?.product_name || "Unknown Product",
            hsn_code: pConfig?.hsn_code || "",
            unit_of_measure: pConfig?.unit_of_measure || "kg",
            category: pConfig?.category || "Meat",
            quantity: Math.round(qtyToAdd * 100) / 100,
            rate,
            amount: Math.round(qtyToAdd * rate * 100) / 100,
            customer_id:
              inv.products[0]?.customer_id ||
              inv.receiving_company_id ||
              fallbackCustomerId ||
              null,
          });
          inv.total_amount = inv.products.reduce(
            (sum: any, p: any) => sum + p.amount,
            0,
          );
          remainingDiff = Math.round((remainingDiff - qtyToAdd) * 100) / 100;
        }
      }

      if (remainingDiff > 0.001) {
        const matchingInv =
          sameDateInvoices.find((inv: any) =>
            inv.products.some((p: any) => p.product_id === productId),
          ) || sameDateInvoices[0];
        if (matchingInv) {
          console.warn(
            `[reconcileInvoicesToTargets] +${remainingDiff} of product ${productId} on ${dateStr} didn't fit within maximumInvoiceAmount on any same-date invoice — exceeding the limit on invoice ${matchingInv.invoice_number || matchingInv.id || "(unsaved)"} as a last resort.`,
          );
          let prodObj = matchingInv.products.find(
            (p: any) => p.product_id === productId,
          );
          if (!prodObj) {
            const rate = Math.round((minRate + maxRate) / 2) || 1;
            prodObj = {
              product_id: productId,
              product_name: pConfig?.product_name || "Unknown Product",
              hsn_code: pConfig?.hsn_code || "",
              unit_of_measure: pConfig?.unit_of_measure || "kg",
              quantity: 0,
              rate,
              amount: 0,
              customer_id:
                matchingInv.products[0]?.customer_id ||
                matchingInv.receiving_company_id ||
                fallbackCustomerId ||
                null,
            };
            matchingInv.products.push(prodObj);
          }
          prodObj.quantity =
            Math.round((prodObj.quantity + remainingDiff) * 100) / 100;
          prodObj.amount =
            Math.round(prodObj.quantity * prodObj.rate * 100) / 100;
          matchingInv.total_amount = matchingInv.products.reduce(
            (sum: any, p: any) => sum + p.amount,
            0,
          );
        }
      }
    } else {
      // Decrease: subtract from matching invoices until diff is fully applied
      let remainingDiff = Math.abs(diff);
      for (const inv of sameDateInvoices) {
        if (remainingDiff <= 0.001) break;
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
      // Every date+product's full ledger amount should already be on some
      // invoice by construction (see InvoiceEngine's deterministic sales
      // generation) — this should never be reachable. Surface it loudly
      // instead of silently leaving the target unmet if it ever is, so a
      // future regression gets caught instead of hidden.
      if (remainingDiff > 0.001) {
        console.warn(
          `[reconcileInvoicesToTargets] Could not fully reduce product ${productId} on ${dateStr} — ${remainingDiff} left unresolved (existing invoice lines didn't hold enough quantity to absorb it). This should not happen if generation is ledger-accurate.`,
        );
      }
    }
  }

  // Filter out empty invoices (if any)
  return invoices.filter(
    (inv: any) => inv.products.length > 0 && inv.total_amount > 0,
  );
}

/**
 * Merges any invoice below `minimumAmount` into another eligible invoice
 * from the same date (same category only, to preserve category purity —
 * mixed-category invoices are a hard validation error elsewhere) whose
 * combined total stays within `maximumAmount`. Repeats until stable.
 *
 * Used as a safety net after Daily Stock Ledger modal edits are reconciled
 * into real invoices (via reconcileInvoicesToTargets), since that
 * redistribution has no awareness of the batch's invoice amount thresholds.
 * Restricted to same-date merges so per-date/product sold quantities that
 * the stock ledger relies on are preserved.
 */
export function enforceMinimumInvoiceAmount(
  invoices: any[],
  minimumAmount: number,
  maximumAmount: number,
): any[] {
  if (!minimumAmount || minimumAmount <= 0) return invoices;

  const getCategory = (inv: any): string =>
    inv.products?.[0]?.category || inv.category_key || "Meat";

  const unfixable = new Set<any>();
  let mergedSomething = true;

  while (mergedSomething) {
    mergedSomething = false;

    const belowMinIdx = invoices.findIndex(
      (inv) =>
        Number(inv.total_amount || 0) < minimumAmount && !unfixable.has(inv),
    );
    if (belowMinIdx === -1) break;

    const belowMinInv = invoices[belowMinIdx];
    const belowMinCategory = getCategory(belowMinInv);
    const belowMinProductIds = new Set(
      belowMinInv.products.map((p: any) => p.product_id),
    );

    const targetIdx = invoices.findIndex(
      (inv, idx) =>
        idx !== belowMinIdx &&
        inv.invoice_date === belowMinInv.invoice_date &&
        getCategory(inv) === belowMinCategory &&
        Number(inv.total_amount || 0) + Number(belowMinInv.total_amount || 0) <=
          maximumAmount &&
        // Concatenating product lines blindly duplicates a product (at two
        // different rates) whenever both invoices already carry it.
        !inv.products.some((p: any) => belowMinProductIds.has(p.product_id)),
    );

    if (targetIdx !== -1) {
      const targetInv = invoices[targetIdx];
      targetInv.products.push(...belowMinInv.products);
      targetInv.total_amount =
        Math.round(
          (Number(targetInv.total_amount || 0) +
            Number(belowMinInv.total_amount || 0)) *
            100,
        ) / 100;
      invoices.splice(belowMinIdx, 1);
      mergedSomething = true;
    } else {
      unfixable.add(belowMinInv);
      mergedSomething = true;
    }
  }

  return invoices;
}
