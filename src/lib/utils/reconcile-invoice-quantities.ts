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
  majorCustomerIds?: Set<string>,
  minimumInvoiceAmount?: number,
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

  const isMajorInvoice = (inv: any): boolean =>
    !!majorCustomerIds &&
    (majorCustomerIds.has(inv.customer_id) ||
      majorCustomerIds.has(inv.products?.[0]?.customer_id));

  // Hotfix — Null mode ("sell 100% of available stock, zero leftover")
  // must never silently drop quantity. A single product's own leftover
  // can be too small to justify a standalone new invoice (below
  // minimumInvoiceAmount) even when every same-date invoice is already
  // full — that used to just log a console.warn and move on, leaving the
  // stock permanently unsold and reappearing as "Leftover Stock" even
  // though the user explicitly chose Null. Instead of dropping it here,
  // it's queued and resolved in one pooled pass AFTER the main loop below
  // (see "Final pass"), combined across every OTHER product sharing the
  // same date+category — leftovers that are individually too small to
  // form a valid invoice routinely clear the minimum once pooled
  // together, since real Sales days rarely have just one product's worth
  // of unplaceable overflow.
  const droppedResidual: {
    dateStr: string;
    productId: string;
    qty: number;
    rate: number;
    category: string;
  }[] = [];

  for (const [key, targetQty] of targetQtyMap.entries()) {
    const sepIdx = key.indexOf("_");
    const dateStr = key.slice(0, sepIdx);
    const productId = key.slice(sepIdx + 1);
    const currentQty = currentQtyMap.get(key) || 0;
    const diff = Math.round((targetQty - currentQty) * 100) / 100;

    if (Math.abs(diff) <= 0.001) continue;

    // Major Customer invoices already carry their own exact,
    // separately-configured amount and category from generation — Null
    // mode/Auto Allocate reconciliation must never touch them, whether
    // topping up an existing line, adding a new one, or (especially) the
    // last-resort overflow fallback below.
    const sameDateInvoices = invoices.filter(
      (inv: any) => inv.invoice_date === dateStr && !isMajorInvoice(inv),
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
        // Hotfix: exceeding maximumInvoiceAmount is a hard business rule
        // violation — this used to prefer growing an existing matching
        // invoice PAST its configured maximum over opening a new, safe
        // invoice, purely because a matching invoice happened to exist.
        // Confirmed as the direct cause of invoices showing up above the
        // configured range. Opening new invoice(s) for the overflow is
        // ALWAYS tried first now — it never violates the cap (splitting
        // into more than one new invoice if a single one would still
        // exceed it) — and growing an existing invoice past its limit is
        // the absolute last resort, only when there's no fallback
        // customer to open a new invoice with at all.
        const rate = Math.round((minRate + maxRate) / 2) || 1;
        const newLineCategory = String(
          pConfig?.category || "Meat",
        ).toUpperCase();

        // A brand-new invoice must itself land within [minimum, maximum] —
        // opening one for an overflow too small to clear the configured
        // minimum would just trade a maximum-side violation for a
        // minimum-side one. Only take the "open new invoice(s)" path when
        // the overflow is actually big enough to form a valid invoice on
        // its own; otherwise this falls through to the existing-invoice
        // last resort below, exactly as before this fix — genuinely rare,
        // since it only applies to a small residual, not the general case.
        const overflowAmount = Math.round(remainingDiff * rate * 100) / 100;
        const canOpenNewInvoice =
          !!fallbackCustomerId &&
          (!minimumInvoiceAmount || overflowAmount >= minimumInvoiceAmount);

        if (canOpenNewInvoice) {
          console.warn(
            `[reconcileInvoicesToTargets] +${remainingDiff} of product ${productId} on ${dateStr} didn't fit within maximumInvoiceAmount on any same-date invoice — opening new invoice(s) for the overflow instead of exceeding the configured maximum.`,
          );
          // A single new invoice might still exceed maximumInvoiceAmount
          // if remainingDiff itself is large — split across as many new
          // invoices as needed so none of them ever exceeds the cap.
          const maxQtyPerInvoice = maximumInvoiceAmount
            ? Math.max(0.01, maximumInvoiceAmount / rate)
            : Infinity;
          while (remainingDiff > 0.001) {
            const qtyThisInvoice = Math.min(remainingDiff, maxQtyPerInvoice);
            if (qtyThisInvoice <= 0) break;
            invoices.push({
              invoice_date: dateStr,
              customer_id: fallbackCustomerId,
              products: [
                {
                  product_id: productId,
                  product_name: pConfig?.product_name || "Unknown Product",
                  hsn_code: pConfig?.hsn_code || "",
                  unit_of_measure: pConfig?.unit_of_measure || "kg",
                  category: pConfig?.category || "Meat",
                  quantity: Math.round(qtyThisInvoice * 100) / 100,
                  rate,
                  amount: Math.round(qtyThisInvoice * rate * 100) / 100,
                  customer_id: fallbackCustomerId,
                },
              ],
              total_amount: Math.round(qtyThisInvoice * rate * 100) / 100,
            });
            remainingDiff = Math.round((remainingDiff - qtyThisInvoice) * 100) / 100;
          }
        } else {
          // Queued instead of immediately exceeding an existing invoice's
          // cap or silently dropping it — see the "Final pass" after the
          // main loop, which pools this with any other product's leftover
          // sharing this exact date+category before deciding it truly has
          // nowhere to go.
          droppedResidual.push({
            dateStr,
            productId,
            qty: remainingDiff,
            rate,
            category: newLineCategory,
          });
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

  // ── Final pass: place every queued residual (droppedResidual) ───────
  // Pools leftovers across every product sharing the same date+category
  // before giving up on any of them — a product's own overflow can be
  // too small to justify a standalone invoice, but rarely stays that way
  // once combined with whatever else on that date+category also didn't
  // fit. This is what makes Null mode ("sell everything") actually reach
  // zero leftover instead of quietly leaving a few kilos unsold.
  if (droppedResidual.length > 0) {
    const groups = new Map<string, typeof droppedResidual>();
    for (const r of droppedResidual) {
      const gKey = `${r.dateStr}_${r.category}`;
      if (!groups.has(gKey)) groups.set(gKey, []);
      groups.get(gKey)!.push(r);
    }

    for (const [gKey, entries] of groups.entries()) {
      const sepIdx2 = gKey.indexOf("_");
      const dateStr = gKey.slice(0, sepIdx2);
      const category = gKey.slice(sepIdx2 + 1);

      // Merge multiple queued entries for the SAME product into one.
      const remaining = new Map<string, { qty: number; rate: number }>();
      for (const r of entries) {
        const existing = remaining.get(r.productId);
        if (existing) {
          existing.qty = Math.round((existing.qty + r.qty) * 100) / 100;
        } else {
          remaining.set(r.productId, { qty: r.qty, rate: r.rate });
        }
      }

      const groupDateInvoices = invoices.filter(
        (inv: any) => inv.invoice_date === dateStr && !isMajorInvoice(inv),
      );
      const headroomOf = (inv: any) =>
        maximumInvoiceAmount
          ? Math.max(0, maximumInvoiceAmount - Number(inv.total_amount || 0))
          : Infinity;

      // 1. Top up existing same-date/category invoices with headroom,
      // spreading across whichever products still need placing.
      for (const inv of groupDateInvoices) {
        const invCategory = inv.products[0]?.category
          ? String(inv.products[0].category).toUpperCase()
          : null;
        if (invCategory && invCategory !== category) continue;
        let headroom = headroomOf(inv);
        if (headroom <= 0) continue;
        for (const [productId, entry] of remaining.entries()) {
          if (headroom <= 0.001) break;
          if (entry.qty <= 0.001) continue;
          const pConfig = productConfigs.find(
            (p: any) => p.product_id === productId,
          );
          const qtyToAdd = Math.min(entry.qty, headroom / entry.rate);
          if (qtyToAdd <= 0) continue;
          const prodObj = inv.products.find(
            (p: any) => p.product_id === productId,
          );
          if (prodObj) {
            prodObj.quantity =
              Math.round((prodObj.quantity + qtyToAdd) * 100) / 100;
            prodObj.amount =
              Math.round(prodObj.quantity * prodObj.rate * 100) / 100;
          } else {
            inv.products.push({
              product_id: productId,
              product_name: pConfig?.product_name || "Unknown Product",
              hsn_code: pConfig?.hsn_code || "",
              unit_of_measure: pConfig?.unit_of_measure || "kg",
              category: pConfig?.category || category,
              quantity: Math.round(qtyToAdd * 100) / 100,
              rate: entry.rate,
              amount: Math.round(qtyToAdd * entry.rate * 100) / 100,
              customer_id:
                inv.products[0]?.customer_id ||
                inv.receiving_company_id ||
                fallbackCustomerId ||
                null,
            });
          }
          inv.total_amount = inv.products.reduce(
            (s: number, p: any) => s + p.amount,
            0,
          );
          entry.qty = Math.round((entry.qty - qtyToAdd) * 100) / 100;
          headroom = headroomOf(inv);
        }
      }

      // 2. Whatever's left, pooled across every product in this
      // date+category, forms brand new invoice(s) — packing products in
      // until maximumInvoiceAmount is reached, opening another invoice
      // for the remainder. Combining products is what usually clears
      // minimumInvoiceAmount even when no single product's leftover did.
      if (fallbackCustomerId) {
        let currentInv: any = null;
        const flushInv = () => {
          if (currentInv && currentInv.products.length > 0) {
            invoices.push(currentInv);
          }
          currentInv = null;
        };
        for (const [productId, entry] of remaining.entries()) {
          const pConfig = productConfigs.find(
            (p: any) => p.product_id === productId,
          );
          let qtyLeft = entry.qty;
          let guard = 1000;
          while (qtyLeft > 0.001 && guard-- > 0) {
            if (!currentInv) {
              currentInv = {
                invoice_date: dateStr,
                customer_id: fallbackCustomerId,
                products: [],
                total_amount: 0,
              };
            }
            const currentTotal = Number(currentInv.total_amount || 0);
            const roomLeft = maximumInvoiceAmount
              ? maximumInvoiceAmount - currentTotal
              : Infinity;
            if (roomLeft <= 0.001) {
              flushInv();
              continue;
            }
            const qtyThis = Math.min(qtyLeft, roomLeft / entry.rate);
            if (qtyThis <= 0) {
              flushInv();
              continue;
            }
            currentInv.products.push({
              product_id: productId,
              product_name: pConfig?.product_name || "Unknown Product",
              hsn_code: pConfig?.hsn_code || "",
              unit_of_measure: pConfig?.unit_of_measure || "kg",
              category: pConfig?.category || category,
              quantity: Math.round(qtyThis * 100) / 100,
              rate: entry.rate,
              amount: Math.round(qtyThis * entry.rate * 100) / 100,
              customer_id: fallbackCustomerId,
            });
            currentInv.total_amount = Math.round(
              currentInv.products.reduce(
                (s: number, p: any) => s + p.amount,
                0,
              ) * 100,
            ) / 100;
            qtyLeft = Math.round((qtyLeft - qtyThis) * 100) / 100;
            entry.qty = qtyLeft;
          }
        }
        flushInv();
      }

      // 3. Absolute last resort: a residual too small to reach
      // minimumInvoiceAmount even pooled across every product on this
      // date+category (or no fallback customer at all) — force it onto
      // whichever same-date/category invoice has the LEAST amount so far
      // (spreading the distortion as thin as possible), exceeding
      // maximumInvoiceAmount if truly necessary. Null mode's whole point
      // — sell 100% of available stock — outranks the amount-range
      // preference for this genuinely rare sliver. Always logged, never
      // silently dropped.
      for (const [productId, entry] of remaining.entries()) {
        if (entry.qty <= 0.001) continue;
        const pConfig = productConfigs.find(
          (p: any) => p.product_id === productId,
        );
        const candidateInvoices = groupDateInvoices.filter((inv: any) => {
          const invCategory = inv.products[0]?.category
            ? String(inv.products[0].category).toUpperCase()
            : null;
          return !invCategory || invCategory === category;
        });
        const target = [...candidateInvoices].sort(
          (a: any, b: any) =>
            Number(a.total_amount || 0) - Number(b.total_amount || 0),
        )[0];
        if (!target) {
          console.warn(
            `[reconcileInvoicesToTargets] ${entry.qty} of product ${productId} on ${dateStr} could not be placed anywhere — no same-date/category invoice exists and no fallback customer is configured. Left unresolved (should be extremely rare).`,
          );
          continue;
        }
        console.warn(
          `[reconcileInvoicesToTargets] ${entry.qty} of product ${productId} on ${dateStr} is a residual too small to form its own invoice even pooled with every other product on that date+category — forcing it onto invoice ${target.invoice_number || target.id || "(unsaved)"} as an absolute last resort so Null mode still sells 100% of available stock.`,
        );
        const prodObj = target.products.find(
          (p: any) => p.product_id === productId,
        );
        if (prodObj) {
          prodObj.quantity =
            Math.round((prodObj.quantity + entry.qty) * 100) / 100;
          prodObj.amount =
            Math.round(prodObj.quantity * prodObj.rate * 100) / 100;
        } else {
          target.products.push({
            product_id: productId,
            product_name: pConfig?.product_name || "Unknown Product",
            hsn_code: pConfig?.hsn_code || "",
            unit_of_measure: pConfig?.unit_of_measure || "kg",
            category: pConfig?.category || category,
            quantity: Math.round(entry.qty * 100) / 100,
            rate: entry.rate,
            amount: Math.round(entry.qty * entry.rate * 100) / 100,
            customer_id: target.products[0]?.customer_id || fallbackCustomerId || null,
          });
        }
        target.total_amount = target.products.reduce(
          (s: number, p: any) => s + p.amount,
          0,
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
 * Given a set of invoices whose QUANTITIES are already final (decided by
 * Null mode "sell everything" or Auto Allocate's leftover pacing — this
 * function never touches quantity), solves a single price per product,
 * within that product's configured [rate_min, rate_max] Product Rule, so
 * the batch's total value matches `targetTotal` as closely as that rate
 * flexibility allows. Mirrors the "Target Closing Stock Value" price-solve
 * pass already used in the Daily Stock Review modal for retained stock —
 * same technique, aimed at the SOLD total instead.
 *
 * `invoices` should already exclude Major Customer invoices (those have
 * their own separately-configured amount, untouched here) and
 * `targetTotal` should already have the Major Customer total subtracted
 * out of the batch's overall Total Amount.
 */
export function solveRatesToHitTotal(
  invoices: any[],
  productConfigs: any[],
  targetTotal: number,
  maximumInvoiceAmount?: number,
  fallbackCustomerId?: string | null,
): any[] {
  if (!targetTotal || targetTotal <= 0 || invoices.length === 0) {
    return invoices;
  }

  const rangeByProduct = new Map<string, { min: number; max: number }>();
  for (const pc of productConfigs) {
    const min = parseFloat(pc.perDayRateMin) || 0;
    const max = parseFloat(pc.perDayRateMax) || 0;
    if (max > 0 && max >= min) {
      rangeByProduct.set(pc.product_id, { min, max });
    }
  }

  const qtyByProduct = new Map<string, number>();
  for (const inv of invoices) {
    for (const p of inv.products || []) {
      qtyByProduct.set(
        p.product_id,
        (qtyByProduct.get(p.product_id) || 0) + Number(p.quantity || 0),
      );
    }
  }

  const productIds = Array.from(qtyByProduct.keys()).filter(
    (pid) => (qtyByProduct.get(pid) || 0) > 0 && rangeByProduct.has(pid),
  );
  if (productIds.length === 0) return invoices;

  // 1. Continuous price-solve pass, starting every product at its rate
  // range's midpoint, then moving price (never quantity) within
  // [rate_min, rate_max] toward the target, largest headroom first.
  const priceByProduct = new Map<string, number>();
  for (const pid of productIds) {
    const r = rangeByProduct.get(pid)!;
    priceByProduct.set(pid, (r.min + r.max) / 2);
  }
  const computeSum = () => {
    let sum = 0;
    for (const pid of productIds) {
      sum += (qtyByProduct.get(pid) || 0) * (priceByProduct.get(pid) || 0);
    }
    return sum;
  };
  const headroom = (pid: string, dir: number) => {
    const qty = qtyByProduct.get(pid) || 0;
    const price = priceByProduct.get(pid) || 0;
    const r = rangeByProduct.get(pid);
    if (!r || qty <= 0) return 0;
    const priceRoom = dir > 0 ? r.max - price : price - r.min;
    return Math.max(0, priceRoom * qty);
  };

  let remaining = targetTotal - computeSum();
  let guard = productIds.length + 1;
  while (Math.abs(remaining) > 0.5 && guard-- > 0) {
    const dir = remaining > 0 ? 1 : -1;
    const sorted = [...productIds].sort(
      (a, b) => headroom(b, dir) - headroom(a, dir),
    );
    const pid = sorted[0];
    if (!pid || headroom(pid, dir) <= 0.001) break;
    const qty = qtyByProduct.get(pid) || 0;
    const price = priceByProduct.get(pid) || 0;
    const r = rangeByProduct.get(pid)!;
    const delta = remaining / qty;
    const clamped = Math.min(r.max, Math.max(r.min, price + delta));
    const achieved = (clamped - price) * qty;
    priceByProduct.set(pid, clamped);
    remaining -= achieved;
  }

  // 2. The server re-rounds every line's rate to a whole rupee on save
  // regardless of what's sent — round here too so this function's math
  // matches what actually gets persisted, then apply one price per
  // product uniformly to every line of that product across every invoice.
  for (const [pid, price] of priceByProduct.entries()) {
    priceByProduct.set(pid, Math.round(price));
  }
  for (const inv of invoices) {
    let total = 0;
    for (const p of inv.products || []) {
      const rate = priceByProduct.has(p.product_id)
        ? priceByProduct.get(p.product_id)!
        : Math.round(Number(p.rate) || 0);
      p.rate = rate;
      p.amount = Math.round(Number(p.quantity || 0) * rate * 100) / 100;
      total += p.amount;
    }
    inv.total_amount = Math.round(total * 100) / 100;
  }

  // 2b. Applying one uniform price per product can push some invoices
  // over maximumInvoiceAmount, even though the invoice's ORIGINAL packing
  // (built around each line's old, different rate) fit fine — the
  // packing has no idea prices are about to move. Bring any now-over-max
  // invoice back under the cap by moving whichever of its lines is
  // over-contributing to another invoice (same date, same category, no
  // duplicate product, with headroom) rather than leaving an invoice that
  // violates the configured maximum.
  if (maximumInvoiceAmount) {
    const getCategory = (inv: any): string =>
      inv.products?.[0]?.category || inv.category_key || "Meat";

    for (const inv of invoices) {
      let guard = (inv.products || []).length + 1;
      while (
        Number(inv.total_amount || 0) > maximumInvoiceAmount + 0.01 &&
        guard-- > 0
      ) {
        const overshoot = Number(inv.total_amount) - maximumInvoiceAmount;
        const invCategory = getCategory(inv);
        const invProductIds = new Set(
          (inv.products || []).map((p: any) => p.product_id),
        );

        // Largest-amount line first — fewest moves to close the overshoot.
        const sortedLines = [...(inv.products || [])].sort(
          (a: any, b: any) => (b.amount || 0) - (a.amount || 0),
        );
        const line = sortedLines[0];
        if (!line) break;

        const target = invoices.find(
          (other: any) =>
            other !== inv &&
            other.invoice_date === inv.invoice_date &&
            getCategory(other) === invCategory &&
            !(other.products || []).some(
              (p: any) => p.product_id === line.product_id,
            ) &&
            Number(other.total_amount || 0) < maximumInvoiceAmount - 0.01,
        );

        if (!target) {
          // No existing invoice has room. Quantity must never be shed here
          // — Null mode/Auto Allocate already decided exactly how much
          // stock gets sold, and that must be sold in full; the only lever
          // left is WHERE it goes. Open a brand-new invoice for the
          // overflowing line instead, same as reconcileInvoicesToTargets's
          // own last resort.
          if (!fallbackCustomerId) {
            console.warn(
              `[solveRatesToHitTotal] Invoice ${inv.invoice_number || inv.id || "(unsaved)"} is ₹${overshoot.toFixed(2)} over maximumInvoiceAmount and no other same-date/same-category invoice had room — no fallback customer available to open a new invoice, so the cap is left violated rather than shedding sold quantity.`,
            );
            break;
          }
          const rate = Number(line.rate) || 1;
          const qtyToMoveOut = Math.min(
            Number(line.quantity || 0),
            Math.ceil(overshoot / rate / 0.25) * 0.25,
          );
          if (qtyToMoveOut <= 0) break;

          line.quantity =
            Math.round((Number(line.quantity) - qtyToMoveOut) * 100) / 100;
          line.amount = Math.round(line.quantity * rate * 100) / 100;
          if (line.quantity <= 0.001) {
            inv.products = inv.products.filter((p: any) => p !== line);
          }
          inv.total_amount = Math.round(
            (inv.products || []).reduce(
              (s: number, p: any) => s + (p.amount || 0),
              0,
            ) * 100,
          ) / 100;

          invoices.push({
            invoice_date: inv.invoice_date,
            customer_id: fallbackCustomerId,
            products: [
              {
                ...line,
                quantity: qtyToMoveOut,
                amount: Math.round(qtyToMoveOut * rate * 100) / 100,
                customer_id: fallbackCustomerId,
              },
            ],
            total_amount: Math.round(qtyToMoveOut * rate * 100) / 100,
          });
          console.warn(
            `[solveRatesToHitTotal] Opened a new invoice for ${qtyToMoveOut} of product ${line.product_id} — no existing same-date/same-category invoice had room under maximumInvoiceAmount.`,
          );
          continue;
        }

        const targetHeadroom =
          maximumInvoiceAmount - Number(target.total_amount || 0);
        const rate = Number(line.rate) || 1;
        const maxQtyByHeadroom = Math.floor((targetHeadroom / rate) * 4) / 4;
        const maxQtyByOvershoot = Math.ceil((overshoot / rate) * 4) / 4;
        const qtyToMove = Math.max(
          0,
          Math.min(
            Number(line.quantity || 0),
            maxQtyByHeadroom,
            maxQtyByOvershoot,
          ),
        );
        if (qtyToMove <= 0) break;

        line.quantity =
          Math.round((Number(line.quantity) - qtyToMove) * 100) / 100;
        line.amount = Math.round(line.quantity * rate * 100) / 100;
        if (line.quantity <= 0.001) {
          inv.products = inv.products.filter((p: any) => p !== line);
        }

        target.products = target.products || [];
        target.products.push({
          ...line,
          quantity: qtyToMove,
          amount: Math.round(qtyToMove * rate * 100) / 100,
        });

        inv.total_amount = Math.round(
          (inv.products || []).reduce(
            (s: number, p: any) => s + (p.amount || 0),
            0,
          ) * 100,
        ) / 100;
        target.total_amount = Math.round(
          (target.products || []).reduce(
            (s: number, p: any) => s + (p.amount || 0),
            0,
          ) * 100,
        ) / 100;
        invProductIds.add(line.product_id);
      }
    }
  }

  // 3. Whole-rupee rounding across a large per-product quantity can leave
  // a residual of more than a trivial amount (confirmed on a real batch:
  // a ₹44,591/0.6% drift across 403 invoices/48 products — rounding a
  // product's rate to the nearest whole rupee, then multiplying by its
  // ENTIRE aggregate quantity across the batch, turns a sub-rupee
  // per-unit rounding difference into real money). Close it by nudging
  // individual lines' rates, never quantity — the ledger-approved sold
  // quantity must never change, only where the money lands.
  //
  // Hotfix — the previous version picked the single largest-quantity line
  // and jumped it by `ceil(|diff| / qty)` whole-rupee steps in one go.
  // Whenever a line's quantity exceeded the remaining diff (the exact
  // "large aggregate quantity" shape that causes this bug in the first
  // place), that single jump overshot PAST zero, and the next line's jump
  // overshot back the other way — an oscillation that could burn through
  // every line without ever converging, confirmed by a real repro landing
  // on ₹650 unclosed instead of the ₹350 that was actually achievable.
  // Fixed by re-deciding, every single round, which ONE line's ±1-rupee
  // nudge gets the total closest to the target — never accepting a move
  // that makes the residual worse than leaving it alone — so it always
  // converges to the best achievable point instead of oscillating.
  let batchDiff =
    Math.round((targetTotal -
      invoices.reduce((s, inv) => s + Number(inv.total_amount || 0), 0)) *
      100) / 100;

  if (Math.abs(batchDiff) > 0.5) {
    const allLines: { inv: any; line: any }[] = [];
    for (const inv of invoices) {
      for (const line of inv.products || []) allLines.push({ inv, line });
    }

    let guard = allLines.length + 1;
    while (Math.abs(batchDiff) > 0.5 && guard-- > 0) {
      const dir = batchDiff > 0 ? 1 : -1;
      let bestIdx = -1;
      let bestAbsResult = Math.abs(batchDiff);

      for (let i = 0; i < allLines.length; i++) {
        const { inv, line } = allLines[i];
        const range = rangeByProduct.get(line.product_id);
        const qty = Number(line.quantity || 0);
        if (!range || qty <= 0) continue;
        const candidateRate = (Number(line.rate) || 0) + dir;
        if (candidateRate < range.min || candidateRate > range.max) continue;
        if (dir > 0 && maximumInvoiceAmount) {
          const newInvTotal = Number(inv.total_amount || 0) + qty * dir;
          if (newInvTotal > maximumInvoiceAmount + 0.01) continue;
        }
        const resultingDiff = batchDiff - qty * dir;
        if (Math.abs(resultingDiff) < bestAbsResult) {
          bestAbsResult = Math.abs(resultingDiff);
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const { inv, line } = allLines[bestIdx];
      const qty = Number(line.quantity || 0);
      const candidateRate = (Number(line.rate) || 0) + dir;
      const oldAmount = line.amount || 0;
      line.rate = candidateRate;
      line.amount = Math.round(qty * candidateRate * 100) / 100;
      const delta = line.amount - oldAmount;
      inv.total_amount =
        Math.round((Number(inv.total_amount || 0) + delta) * 100) / 100;
      batchDiff = Math.round((batchDiff - delta) * 100) / 100;
    }

    if (Math.abs(batchDiff) > 0.5) {
      console.warn(
        `[solveRatesToHitTotal] ₹${batchDiff} of the requested Total Amount could not be closed within configured Product Rule rate ranges / maximum invoice amount — left as a residual.`,
      );
    }
  }

  return invoices;
}

/**
 * Final self-correcting pass, run immediately before persistence: brings
 * every non-major invoice inside [minimumAmount, maximumAmount] instead of
 * just detecting violations and rejecting the whole batch.
 *
 * Earlier reconciliation steps (reconcileInvoicesToTargets,
 * enforceMinimumInvoiceAmount, solveRatesToHitTotal) each have documented
 * "last resort" escape hatches that can leave a violation behind when no
 * compatible same-date/category invoice has room to absorb the difference.
 * This function is the actual fix, not just a check:
 *
 * 1. Shed excess from any invoice above maximumAmount — move its largest
 *    line to a same-date/same-category peer with headroom, or open a new
 *    invoice for the overflow if no peer has room. Never destroys quantity,
 *    only moves which invoice a given quantity lands on.
 * 2. Merge any invoice below minimumAmount into a same-date/same-category
 *    peer with room (reuses enforceMinimumInvoiceAmount).
 * 3. Anything still below minimumAmount (no peer existed at all — the rare
 *    case of a single invoice for its date+category) gets topped up by
 *    GROWING its existing lines within real remaining stock
 *    (`remainingStockByDateProduct`, already net of everything this batch
 *    itself allocates) and each product's configured [rate, quantity]
 *    range — never past real stock, so this can never oversell.
 *
 * Returns the repaired invoice list plus whatever still couldn't be fixed
 * (should be rare — e.g. real stock genuinely exhausted) so the caller can
 * decide whether to still reject those specific cases.
 */
export function repairInvoiceAmountRange(
  invoices: any[],
  minimumAmount: number,
  maximumAmount: number,
  productConfigs: any[],
  remainingStockByDateProduct: Map<string, number>,
  fallbackCustomerId?: string | null,
  majorCustomerIds?: Set<string>,
): { invoices: any[]; stillViolating: any[] } {
  const getCategory = (inv: any): string =>
    inv.products?.[0]?.category || inv.category_key || "Meat";
  const isMajorInvoice = (inv: any): boolean =>
    !!majorCustomerIds &&
    (majorCustomerIds.has(inv.customer_id) ||
      majorCustomerIds.has(inv.products?.[0]?.customer_id));
  const configById = new Map<string, any>(
    productConfigs.map((p: any) => [p.product_id, p]),
  );

  console.warn(
    `[repairInvoiceAmountRange] DIAG start: ${invoices.length} invoices, min=${minimumAmount}, max=${maximumAmount}, fallbackCustomerId=${JSON.stringify(fallbackCustomerId)}, majorCustomerIds.size=${majorCustomerIds?.size || 0}, remainingStockByDateProduct.size=${remainingStockByDateProduct.size}`,
  );

  // ── Step 1: shed excess from over-maximum invoices ──────────────────
  if (maximumAmount) {
    for (const inv of invoices) {
      if (isMajorInvoice(inv)) continue;
      // Was `products.length + 1` — sized for "one full line moves per
      // iteration," but a same-date/category peer usually only has a
      // sliver of headroom (most invoices sit close to maximumAmount by
      // design), so a large overshoot often needs MANY small moves across
      // different peers to close. That undersized guard was cutting the
      // loop off mid-progress, not because shedding was impossible — see
      // the 7-invoice regression this caused in production. The loop's own
      // condition (overshoot strictly shrinks every successful iteration,
      // and the unconditional "open a new invoice" fallback always
      // eventually fires once no peer has room) already guarantees
      // termination; this generous bound just stops it from giving up
      // early on a real, convergent case.
      let guard = (inv.products || []).length * 50 + 50;
      while (
        Number(inv.total_amount || 0) > maximumAmount + 0.01 &&
        guard-- > 0
      ) {
        const overshoot = Number(inv.total_amount) - maximumAmount;
        const invCategory = getCategory(inv);
        const sortedLines = [...(inv.products || [])].sort(
          (a: any, b: any) => (b.amount || 0) - (a.amount || 0),
        );
        const line = sortedLines[0];
        if (!line) break;
        const rate = Number(line.rate) || 1;

        // Pick the peer with the MOST headroom, not just the first match —
        // `.find()`'s first hit could have as little as ₹0.02 of room,
        // which rounds a 0.25kg-step qtyToMove down to 0 and used to just
        // give up outright (`break`) instead of trying a better candidate.
        const eligibleTargets = invoices.filter(
          (other: any) =>
            other !== inv &&
            !isMajorInvoice(other) &&
            other.invoice_date === inv.invoice_date &&
            getCategory(other) === invCategory &&
            !(other.products || []).some(
              (p: any) => p.product_id === line.product_id,
            ) &&
            Number(other.total_amount || 0) < maximumAmount - 0.01,
        );
        const target = eligibleTargets.reduce(
          (best: any, cand: any) =>
            !best ||
            Number(cand.total_amount || 0) < Number(best.total_amount || 0)
              ? cand
              : best,
          null as any,
        );

        let qtyToMove = 0;
        if (target) {
          const targetHeadroom =
            maximumAmount - Number(target.total_amount || 0);
          const maxQtyByHeadroom = Math.floor((targetHeadroom / rate) * 4) / 4;
          const maxQtyByOvershoot = Math.ceil((overshoot / rate) * 4) / 4;
          qtyToMove = Math.max(
            0,
            Math.min(
              Number(line.quantity || 0),
              maxQtyByHeadroom,
              maxQtyByOvershoot,
            ),
          );
        }

        if (target && qtyToMove > 0) {
          line.quantity = Math.round((Number(line.quantity) - qtyToMove) * 100) / 100;
          line.amount = Math.round(line.quantity * rate * 100) / 100;
          if (line.quantity <= 0.001) {
            inv.products = inv.products.filter((p: any) => p !== line);
          }
          target.products = target.products || [];
          target.products.push({
            ...line,
            quantity: qtyToMove,
            amount: Math.round(qtyToMove * rate * 100) / 100,
          });
          target.total_amount = Math.round(
            (target.products || []).reduce(
              (s: number, p: any) => s + (p.amount || 0),
              0,
            ) * 100,
          ) / 100;
        } else if (fallbackCustomerId) {
          const qtyToMoveOut = Math.min(
            Number(line.quantity || 0),
            Math.ceil((overshoot / rate) * 4) / 4,
          );
          if (qtyToMoveOut <= 0) {
            console.warn(
              `[repairInvoiceAmountRange] Step1 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} — qtyToMoveOut computed as ${qtyToMoveOut} (line.quantity=${line.quantity}, overshoot=${overshoot}, rate=${rate}) — breaking with invoice still over max.`,
            );
            break;
          }
          line.quantity = Math.round((Number(line.quantity) - qtyToMoveOut) * 100) / 100;
          line.amount = Math.round(line.quantity * rate * 100) / 100;
          if (line.quantity <= 0.001) {
            inv.products = inv.products.filter((p: any) => p !== line);
          }
          invoices.push({
            invoice_date: inv.invoice_date,
            customer_id: fallbackCustomerId,
            products: [
              {
                ...line,
                quantity: qtyToMoveOut,
                amount: Math.round(qtyToMoveOut * rate * 100) / 100,
                customer_id: fallbackCustomerId,
              },
            ],
            total_amount: Math.round(qtyToMoveOut * rate * 100) / 100,
          });
        } else {
          console.warn(
            `[repairInvoiceAmountRange] Step1 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} is ₹${overshoot.toFixed(2)} over max, category="${invCategory}", date=${inv.invoice_date} — no same-date/category peer with headroom AND fallbackCustomerId is falsy (value=${JSON.stringify(fallbackCustomerId)}) — breaking with invoice still over max.`,
          );
          break;
        }

        inv.total_amount = Math.round(
          (inv.products || []).reduce(
            (s: number, p: any) => s + (p.amount || 0),
            0,
          ) * 100,
        ) / 100;
      }
      if (Number(inv.total_amount || 0) > maximumAmount + 0.01) {
        console.warn(
          `[repairInvoiceAmountRange] Step1 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} exited the while loop STILL over max (₹${inv.total_amount} > ₹${maximumAmount}), guard=${(inv.products || []).length + 1}, lines=${(inv.products || []).length} — either guard ran out or a break fired above.`,
        );
      }
    }
  }

  // ── Step 2: merge below-minimum invoices into peers ─────────────────
  invoices = enforceMinimumInvoiceAmount(
    invoices,
    minimumAmount,
    maximumAmount,
    majorCustomerIds,
  );

  // ── Step 3: grow whatever's still below minimum, within real stock ──
  const stillViolating: any[] = [];
  if (minimumAmount) {
    for (const inv of invoices) {
      if (isMajorInvoice(inv)) continue;
      let guard = 20;
      while (
        Number(inv.total_amount || 0) < minimumAmount - 0.01 &&
        guard-- > 0
      ) {
        const shortfall = minimumAmount - Number(inv.total_amount || 0);
        // Largest headroom-by-real-stock line first.
        let bestLine: any = null;
        let bestRoom = 0;
        for (const p of inv.products || []) {
          const cfg = configById.get(p.product_id);
          const maxQty = cfg ? parseFloat(cfg.perDayQtyMax) || 0 : 0;
          const key = `${inv.invoice_date}_${p.product_id}`;
          const stockRoom = remainingStockByDateProduct.get(key) || 0;
          const room = Math.max(
            0,
            Math.min(maxQty - Number(p.quantity || 0), stockRoom),
          );
          if (room > bestRoom) {
            bestRoom = room;
            bestLine = p;
          }
        }
        if (!bestLine || bestRoom < 0.25) {
          // No real stock left to grow an existing line with. Before
          // reaching for a whole new product (below) or giving up, try the
          // cheapest, least invasive lever first: push existing lines'
          // RATE toward each product's configured maximum — never touches
          // quantity/stock at all, so it's always available as long as
          // some line isn't already at its rate ceiling. Confirmed as the
          // preferred fix for a pre-made/fixed-stock batch where adding
          // more stock isn't an option.
          let priceOnlyRemaining = shortfall;
          const rateRoomLines = (inv.products || [])
            .map((p: any) => {
              const cfg = configById.get(p.product_id);
              const rateMax = cfg ? parseFloat(cfg.perDayRateMax) || 0 : 0;
              const curRate = Number(p.rate) || 0;
              const qty = Number(p.quantity) || 0;
              return {
                p,
                rateMax,
                room: Math.max(0, (rateMax - curRate) * qty),
              };
            })
            .filter((x: any) => x.room > 0.001)
            .sort((a: any, b: any) => b.room - a.room);

          for (const { p, rateMax } of rateRoomLines) {
            if (priceOnlyRemaining <= 0.01) break;
            const qty = Number(p.quantity) || 0;
            if (qty <= 0) continue;
            const curRate = Number(p.rate) || 0;
            // Rates are always whole rupees (see isValidWholeNumber) —
            // round the needed bump up so this line alone can't
            // under-shoot the shortfall by a fraction of a rupee.
            const neededBump = Math.ceil(priceOnlyRemaining / qty);
            const newRate = Math.min(rateMax, curRate + neededBump);
            if (newRate <= curRate) continue;
            const oldAmount = Number(p.amount) || 0;
            p.rate = newRate;
            p.amount = Math.round(qty * newRate * 100) / 100;
            priceOnlyRemaining = Math.round(
              (priceOnlyRemaining - (p.amount - oldAmount)) * 100,
            ) / 100;
          }

          if (priceOnlyRemaining < shortfall - 0.001) {
            inv.total_amount = Math.round(
              (inv.products || []).reduce(
                (s: number, p: any) => s + (p.amount || 0),
                0,
              ) * 100,
            ) / 100;
            console.warn(
              `[repairInvoiceAmountRange] Step3 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} — no stock room, closed ₹${(shortfall - priceOnlyRemaining).toFixed(2)} of the ₹${shortfall.toFixed(2)} shortfall via rate-only bump toward configured rateMax (new total ₹${inv.total_amount}).`,
            );
            continue;
          }

          // Hotfix — this used to give up here even when the invoice's
          // EXISTING products were simply stock-maxed for this date while
          // some OTHER product (same category, not yet on this invoice)
          // still had real room to spare. The engine could shed excess
          // across invoices (Step 1) but couldn't reach for a new product
          // to close a shortfall — a real gap, not a genuine "out of
          // stock" business situation. Mirrors the exact same new-line
          // convention already used elsewhere in this file (category
          // purity enforced, rate at the configured range's midpoint).
          const invCategory = String(
            inv.products?.[0]?.category || "Meat",
          ).toUpperCase();
          const existingProductIds = new Set(
            (inv.products || []).map((p: any) => p.product_id),
          );
          let bestNewProduct: any = null;
          let bestNewRoom = 0;
          for (const cfg of productConfigs) {
            if (existingProductIds.has(cfg.product_id)) continue;
            if (
              String(cfg.category || "Meat").toUpperCase() !== invCategory
            ) {
              continue;
            }
            const newKey = `${inv.invoice_date}_${cfg.product_id}`;
            const stockRoom = remainingStockByDateProduct.get(newKey) || 0;
            const maxQty = parseFloat(cfg.perDayQtyMax) || 0;
            const room = Math.max(0, Math.min(maxQty, stockRoom));
            if (room > bestNewRoom) {
              bestNewRoom = room;
              bestNewProduct = cfg;
            }
          }
          if (!bestNewProduct || bestNewRoom < 0.25) {
            // Absolute last resort — confirmed with the user: stock is
            // fixed/pre-made (never adjustable) and the minimum invoice
            // amount is also fixed, so once neither real stock (existing
            // line or a new product) NOR the configured rate_max range
            // can close the rest, the only lever left is to push price
            // PAST the configured ceiling by exactly enough to clear the
            // minimum — never more, and never before every real-stock
            // option above has already been tried and failed. Applied to
            // the single largest-quantity line (the smallest per-rupee
            // rate increase needed).
            if (priceOnlyRemaining > 0.01 && (inv.products || []).length > 0) {
              const largestLine = [...(inv.products || [])].sort(
                (a: any, b: any) =>
                  (Number(b.quantity) || 0) - (Number(a.quantity) || 0),
              )[0];
              const qty = Number(largestLine.quantity) || 0;
              if (qty > 0) {
                const curRate = Number(largestLine.rate) || 0;
                const neededBump = Math.ceil(priceOnlyRemaining / qty);
                const newRate = curRate + neededBump;
                const oldAmount = Number(largestLine.amount) || 0;
                largestLine.rate = newRate;
                largestLine.amount = Math.round(qty * newRate * 100) / 100;
                priceOnlyRemaining = Math.round(
                  (priceOnlyRemaining - (largestLine.amount - oldAmount)) *
                    100,
                ) / 100;
                inv.total_amount = Math.round(
                  (inv.products || []).reduce(
                    (s: number, p: any) => s + (p.amount || 0),
                    0,
                  ) * 100,
                ) / 100;
                console.warn(
                  `[repairInvoiceAmountRange] Step3 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} — exhausted real stock AND configured rate_max on every line; pushed ${largestLine.product_name || largestLine.product_id} to ₹${newRate}/unit (above the configured maximum) as the absolute last resort to clear the minimum invoice amount (new total ₹${inv.total_amount}).`,
                );
                if (priceOnlyRemaining < 0.01) continue;
              }
            }

            console.warn(
              `[repairInvoiceAmountRange] Step3 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} (date=${inv.invoice_date}, category=${invCategory}) is ₹${shortfall.toFixed(2)} short of minimum — no existing line had stock room (bestRoom=${bestRoom}), and no other same-category product had room either (bestNewProduct=${bestNewProduct?.product_id || "none"}, bestNewRoom=${bestNewRoom}) — breaking with invoice still under minimum.`,
            );
            break;
          }

          const minRate = parseFloat(bestNewProduct.perDayRateMin) || 0;
          const maxRate = parseFloat(bestNewProduct.perDayRateMax) || 0;
          const newRate = Math.round((minRate + maxRate) / 2) || 1;
          const newQtyNeeded = Math.ceil((shortfall / newRate) * 4) / 4;
          const newQtyToAdd = Math.min(newQtyNeeded, bestNewRoom);
          if (newQtyToAdd < 0.25) {
            console.warn(
              `[repairInvoiceAmountRange] Step3 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} — newQtyToAdd computed as ${newQtyToAdd} (newQtyNeeded=${newQtyNeeded}, bestNewRoom=${bestNewRoom}) — breaking with invoice still under minimum.`,
            );
            break;
          }

          inv.products = inv.products || [];
          inv.products.push({
            product_id: bestNewProduct.product_id,
            product_name: bestNewProduct.product_name || "Unknown Product",
            hsn_code: bestNewProduct.hsn_code || "",
            unit_of_measure: bestNewProduct.unit_of_measure || "kg",
            category: bestNewProduct.category || "Meat",
            quantity: Math.round(newQtyToAdd * 100) / 100,
            rate: newRate,
            amount: Math.round(newQtyToAdd * newRate * 100) / 100,
            customer_id:
              inv.products[0]?.customer_id || inv.customer_id || null,
          });
          const newKey = `${inv.invoice_date}_${bestNewProduct.product_id}`;
          remainingStockByDateProduct.set(
            newKey,
            Math.max(
              0,
              (remainingStockByDateProduct.get(newKey) || 0) - newQtyToAdd,
            ),
          );
          inv.total_amount = Math.round(
            (inv.products || []).reduce(
              (s: number, p: any) => s + (p.amount || 0),
              0,
            ) * 100,
          ) / 100;
          continue;
        }

        const rate = Number(bestLine.rate) || 1;
        const qtyNeeded = Math.ceil((shortfall / rate) * 4) / 4;
        const qtyToAdd = Math.min(qtyNeeded, bestRoom);
        if (qtyToAdd < 0.25) {
          console.warn(
            `[repairInvoiceAmountRange] Step3 DIAG: invoice ${inv.invoice_number || inv.id || "(unsaved)"} — qtyToAdd computed as ${qtyToAdd} (qtyNeeded=${qtyNeeded}, bestRoom=${bestRoom}) on bestLine=${bestLine?.product_id} — breaking with invoice still under minimum.`,
          );
          break;
        }

        bestLine.quantity = Math.round((Number(bestLine.quantity) + qtyToAdd) * 100) / 100;
        bestLine.amount = Math.round(bestLine.quantity * rate * 100) / 100;
        const key = `${inv.invoice_date}_${bestLine.product_id}`;
        remainingStockByDateProduct.set(
          key,
          Math.max(0, (remainingStockByDateProduct.get(key) || 0) - qtyToAdd),
        );
        inv.total_amount = Math.round(
          (inv.products || []).reduce(
            (s: number, p: any) => s + (p.amount || 0),
            0,
          ) * 100,
        ) / 100;
      }
      if (Number(inv.total_amount || 0) < minimumAmount - 0.01) {
        stillViolating.push(inv);
      }
    }
  }

  if (maximumAmount) {
    for (const inv of invoices) {
      if (
        !isMajorInvoice(inv) &&
        Number(inv.total_amount || 0) > maximumAmount + 0.01 &&
        !stillViolating.includes(inv)
      ) {
        stillViolating.push(inv);
      }
    }
  }

  return { invoices, stillViolating };
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
  majorCustomerIds?: Set<string>,
): any[] {
  if (!minimumAmount || minimumAmount <= 0) return invoices;

  const getCategory = (inv: any): string =>
    inv.products?.[0]?.category || inv.category_key || "Meat";
  const isMajorInvoice = (inv: any): boolean =>
    !!majorCustomerIds &&
    (majorCustomerIds.has(inv.customer_id) ||
      majorCustomerIds.has(inv.products?.[0]?.customer_id));

  const unfixable = new Set<any>();
  let mergedSomething = true;

  while (mergedSomething) {
    mergedSomething = false;

    // Major Customer invoices already carry their own exact,
    // separately-configured amount/category — never merge one away as
    // "below minimum" (it's supposed to be a large custom amount) and
    // never merge something else INTO one either.
    const belowMinIdx = invoices.findIndex(
      (inv) =>
        Number(inv.total_amount || 0) < minimumAmount &&
        !unfixable.has(inv) &&
        !isMajorInvoice(inv),
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
        !isMajorInvoice(inv) &&
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
