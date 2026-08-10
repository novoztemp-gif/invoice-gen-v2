import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import {
  buildProductTemplates,
  computeAddRoom,
  diffEditedProductIds,
  resolveReduction,
  SalesAllocationTracker,
} from "./SalesLineCapacity";
import {
  roundMoney,
  SALES_BALANCE_LIMITS,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesSolverPlan,
} from "./types";

export class SalesResidualRepair {
  /**
   * Attempts exact residual repair to close remaining batch amount and product quantity deltas.
   */
  public static repairResidual(
    context: SalesBalanceContext,
    plan: SalesSolverPlan,
  ): SalesSolverPlan | null {
    // Balancing must only ever touch the product(s) actually edited — never
    // adjust an unrelated product on a balancing invoice to close a rupee
    // gap. Derived the same way SalesCandidateSolver does: diff the edited
    // invoice's products against its original (pre-edit) state.
    const origEditedInvoiceForDiff = context.invoices.find(
      (i) => i.id === plan.editedInvoice.id,
    );
    const editedProductIds = diffEditedProductIds(
      origEditedInvoiceForDiff?.products,
      plan.editedInvoice.products,
    );

    // plan.balancingInvoices is only the small subset of the batch that
    // holds an edited product — every other invoice is untouched and
    // contributes a fixed amount to context.batchTotal that has nothing to
    // do with this repair. What the edited invoice + this subset must sum
    // to is whatever they ORIGINALLY summed to (before this edit) — not
    // the whole batch total, which would incorrectly demand this small
    // subset absorb the entire rest of the batch's value.
    const origEditedAmt = origEditedInvoiceForDiff
      ? origEditedInvoiceForDiff.total_amount
      : 0;
    const originalSubsetTotal = plan.balancingInvoices.reduce((sum, inv) => {
      const orig = context.invoices.find((i) => i.id === inv.id);
      return sum + (orig ? orig.total_amount : 0);
    }, 0);
    const requiredCombinedTotal = origEditedAmt + originalSubsetTotal;

    // 1. Calculate remaining amount delta
    const currentTotalAmount = roundMoney(
      plan.editedInvoice.total_amount +
        plan.balancingInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );

    const amountResidual = roundMoney(
      requiredCombinedTotal - currentTotalAmount,
    );

    const editDelta = roundMoney(plan.editedInvoice.total_amount - origEditedAmt);

    const balancingProductIds = new Set<string>();
    let totalEditableQty = 0;
    let totalBalancingCapacity = 0;

    for (const inv of plan.balancingInvoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          balancingProductIds.add(p.product_id);
          totalEditableQty += p.quantity;
          const maxStock = context.originalProductTotals?.get(p.product_id) ?? p.quantity;
          const rate = p.rate || 1;
          totalBalancingCapacity += Math.max(0, maxStock - p.quantity) * rate;
        }
      }
    }

    console.log("[SalesResidualRepair] INPUT:", {
      inputBatchDelta: amountResidual,
      planBatchDelta: plan.batchDelta,
      productDeltas: Object.fromEntries(plan.productDeltas.entries()),
    });

    console.log("=== AUTO BALANCE ENGINE DIAGNOSTIC LOGS ===");
    console.log("1. Original Batch Total:                  ", context.batchTotal);
    console.log("2. Current Batch Total after edit:        ", currentTotalAmount);
    console.log("3. Edited Invoice Original Amount:        ", origEditedAmt);
    console.log("4. Edited Invoice New Amount:             ", plan.editedInvoice.total_amount);
    console.log("5. Calculated Edit Delta:                 ", editDelta);
    console.log("6. Total Remaining Balancing Capacity:    ", totalBalancingCapacity);
    console.log("7. Remaining Drift entering Repair:       ", amountResidual);
    console.log("9. Number of balancing invoices:          ", plan.balancingInvoices.length);
    console.log("10. Number of balancing products:         ", balancingProductIds.size);
    console.log("11. Total editable quantity available:    ", totalEditableQty);
    console.log("===========================================");

    // 2. Calculate remaining product quantity residuals — only for the
    // product(s) actually edited. context.originalProductTotals is a
    // batch-WIDE total, but plan.balancingInvoices is only the subset of
    // invoices that hold an edited product; comparing every other
    // product's batch-wide total against a sum accumulated from only that
    // subset would show a huge "residual" for products that were never
    // touched and never needed to be.
    const productResiduals = new Map<string, number>();
    let hasQuantityResidual = false;

    for (const pid of editedProductIds) {
      const targetQty = context.originalProductTotals.get(pid) || 0;
      let currentQty =
        plan.editedInvoice.products.find((p) => p.product_id === pid)
          ?.quantity || 0;
      for (const inv of plan.balancingInvoices) {
        currentQty +=
          inv.products.find((p) => p.product_id === pid)?.quantity || 0;
      }
      const qtyDiff = roundToQuarterIncrement(targetQty - currentQty);
      productResiduals.set(pid, qtyDiff);

      if (Math.abs(qtyDiff) > 0.001) {
        hasQuantityResidual = true;
      }
    }

    // If both amount and quantity residuals are already exact 0, return plan as-is
    if (Math.abs(amountResidual) < 0.01 && !hasQuantityResidual) {
      return plan;
    }

    if (plan.balancingInvoices.length === 0) {
      return null; // Cannot repair without balancing invoices
    }

    // Target candidate invoices for repair (up to last 3 invoices)
    const repairInvoices = plan.balancingInvoices.slice(
      -SALES_BALANCE_LIMITS.residualInvoiceCount,
    );
    const unmodifiedInvoices = plan.balancingInvoices.slice(
      0,
      plan.balancingInvoices.length - repairInvoices.length,
    );

    // Bounded search over repair invoices
    const repairedCandidates = this.searchResidualCombinations(
      repairInvoices,
      amountResidual,
      productResiduals,
      context,
      editedProductIds,
    );

    let updatedBalancing = plan.balancingInvoices;

    if (repairedCandidates) {
      updatedBalancing = [...unmodifiedInvoices, ...repairedCandidates];
    } else {
      // Deterministic direct rebalancing fallback: absorb the exact
      // monetary residual across the balancing invoices that actually
      // hold an edited product. Only those invoices have any editable
      // line at all — spreading the target across every balancing invoice
      // (most of which don't carry the edited product) used to leave the
      // vast majority of them untouched while still counting them toward
      // the target sum, producing a huge unresolved leftover dumped onto
      // a single invoice at the end.
      const adjustedBalancingInvoices = JSON.parse(
        JSON.stringify(plan.balancingInvoices),
      );

      // Close each edited product's QUANTITY residual directly — this is
      // what "same-product redistribution" actually means: move the
      // product's own quantity onto/off other invoices holding it, each at
      // its own existing rate. The previous version of this fallback
      // chased the MONEY residual instead (picking whichever quantity/rate
      // combo got an invoice's total closest to a target rupee figure) —
      // that's an indirect proxy for quantity conservation at best, and
      // once a same-product rate-only candidate was added as an option (to
      // close small money gaps precisely), the search could satisfy a tiny
      // money target with a rate tweak alone and never move any quantity
      // at all — closing the batch total exactly while leaving the actual
      // product-quantity delta completely unresolved. Money conservation
      // instead falls out as a side effect of moving quantity at each
      // line's own rate; whatever small rupee residue is left over after
      // quantity is exactly conserved gets closed by the rate-nudge pass
      // below, which only ever adjusts rate, never quantity.
      // Shared capacity tracker: this repair fallback previously had no
      // awareness of shared stock or the invoice ₹ cap at all, so an ADD
      // here could push a date/product over what's actually available, or
      // an invoice over its cap — caught only later (as a whole-plan
      // rejection) by SalesFinalValidator. Same tracker/ceiling logic used
      // by SalesCandidateSolver's search, so both stages agree on what's
      // actually allowed. Seeded from the ORIGINAL (pre-edit) state of only
      // the invoices this edit touches, then primed with everything the
      // solver's plan already committed (edited invoice + balancing
      // invoices as they stand entering repair) before any new deltas here
      // are recorded.
      const origEditedInvForTracker = origEditedInvoiceForDiff;
      const touchedOriginalInvoices = origEditedInvForTracker
        ? [
            origEditedInvForTracker,
            ...plan.balancingInvoices
              .map((inv) => context.invoices.find((i) => i.id === inv.id))
              .filter((inv): inv is SalesInvoice => !!inv),
          ]
        : plan.balancingInvoices
            .map((inv) => context.invoices.find((i) => i.id === inv.id))
            .filter((inv): inv is SalesInvoice => !!inv);
      const tracker = SalesAllocationTracker.build(
        context,
        touchedOriginalInvoices,
        editedProductIds,
      );
      for (const inv of adjustedBalancingInvoices) {
        for (const p of inv.products || []) {
          if (!editedProductIds.has(p.product_id)) continue;
          tracker.record(inv.invoice_date, p.product_id, p.quantity);
        }
      }
      for (const p of plan.editedInvoice.products) {
        if (!editedProductIds.has(p.product_id)) continue;
        tracker.record(plan.editedInvoice.invoice_date, p.product_id, p.quantity);
      }

      const productTemplates = buildProductTemplates(
        context,
        plan.editedInvoice,
        origEditedInvoiceForDiff,
        editedProductIds,
      );

      for (const pid of editedProductIds) {
        let qtyResidual = productResiduals.get(pid) || 0;
        if (Math.abs(qtyResidual) < 0.001) continue;

        // ADD can reach any balancing invoice — including one that doesn't
        // currently carry this product — by adding it as a new line.
        // REMOVE can only ever come off an invoice that already holds it.
        const candidateInvoices =
          qtyResidual > 0
            ? adjustedBalancingInvoices
            : adjustedBalancingInvoices.filter((inv: any) =>
                (inv.products || []).some((p: any) => p.product_id === pid),
              );
        if (candidateInvoices.length === 0) continue;

        const constraint = context.constraints.get(pid);
        const template = productTemplates.get(pid);

        for (const inv of candidateInvoices) {
          if (Math.abs(qtyResidual) < 0.001) break;
          let line = inv.products.find((p: any) => p.product_id === pid);
          const isNewLine = !line;
          if (!line) {
            if (!template) continue;
            line = { ...template, quantity: 0, amount: 0 };
          }

          let delta: number;
          if (qtyResidual > 0) {
            // Need to ADD this much — bounded by the line's own max qty, the
            // real remaining stock for this invoice's date/product (shared
            // across every invoice touching it), AND this invoice's own
            // headroom under the batch's maximum invoice amount (never push
            // an invoice further over the cap than it already was). Same
            // shared capacity calculation the primary solver uses.
            const { room } = computeAddRoom({
              currentQuantity: line.quantity,
              currentAmount: line.amount,
              invoiceTotalAmount: inv.total_amount,
              rate: line.rate,
              constraint,
              thresholdMax: context.thresholdMax,
              stockCeiling: tracker.ceilingFor(inv.invoice_date, pid),
              stockAlreadyUsed: tracker.usedFor(inv.invoice_date, pid),
            });
            delta = roundToQuarterIncrement(Math.min(qtyResidual, room));
            if (delta > 0) {
              tracker.record(inv.invoice_date, pid, delta);
            }
          } else {
            // Need to REMOVE this much — a line can go all the way to 0
            // (product removed from that invoice, same as the primary
            // solver's own candidate generation allows), but must never be
            // left stranded between 0 and its configured minimum quantity.
            delta = -resolveReduction(line.quantity, -qtyResidual, constraint);
          }
          if (Math.abs(delta) < 0.001) continue;

          line.quantity = roundToQuarterIncrement(line.quantity + delta);
          line.amount = Math.round(line.quantity * line.rate);
          if (isNewLine) {
            if (line.quantity > 0) {
              inv.products.push(line);
            }
          } else if (line.quantity <= 0.001) {
            // Draining an EXISTING line all the way to 0 (only possible now
            // that quantityMin isn't enforced during balancing) removes the
            // line entirely — a lingering quantity-0 line fails the
            // positive-quantity check at final validation.
            inv.products = inv.products.filter((p: any) => p !== line);
          }
          inv.total_amount = Math.round(
            inv.products.reduce(
              (s: number, p: any) => s + Math.round(p.amount || 0),
              0,
            ),
          );
          qtyResidual = roundToQuarterIncrement(qtyResidual - delta);
        }
      }

      updatedBalancing = adjustedBalancingInvoices;
    }

    const finalProductDeltas = new Map<string, number>();
    for (const pid of context.originalProductTotals.keys()) {
      finalProductDeltas.set(pid, 0);
    }

    let finalTotalAmt = roundMoney(
      plan.editedInvoice.total_amount +
        updatedBalancing.reduce((sum: number, inv: any) => sum + Math.round(inv.total_amount || 0), 0),
    );
    let amountResidualLeaving = roundMoney(
      requiredCombinedTotal - finalTotalAmt,
    );

    // Genuine last cent: quantity-only adjustment (quarter-kg steps) can't
    // always land on an exact whole-rupee target for a given rate. Nudge
    // one same-product line's RATE instead (quantity fixed) — a free
    // integer degree of freedom that can usually close a small residual
    // exactly, without touching a different product or a different line's
    // quantity.
    if (Math.abs(amountResidualLeaving) > 0.001) {
      console.log("[SalesResidualRepair] Rate-nudge starting:", {
        amountResidualLeaving,
        editedProductIds: Array.from(editedProductIds),
        constraintsForEditedProducts: Array.from(editedProductIds).map(
          (pid) => ({ pid, constraint: context.constraints.get(pid) }),
        ),
      });
      amountResidualLeaving = this.closeAmountResidual(
        updatedBalancing,
        editedProductIds,
        context,
        amountResidualLeaving,
      );
    }

    console.log("8. Remaining Drift leaving Repair:        ", amountResidualLeaving);

    const repairSuccess = amountResidualLeaving === 0;
    console.log("[SalesResidualRepair] OUTPUT:", {
      outputBatchDelta: amountResidualLeaving,
      repairSuccess,
      repairFailureReason: repairSuccess
        ? "None (Repair Succeeded)"
        : `Non-zero residual drift of ₹${amountResidualLeaving} remaining after repair`
    });

    return {
      editedInvoice: plan.editedInvoice,
      balancingInvoices: updatedBalancing,
      totalCost: plan.totalCost,
      batchDelta: amountResidualLeaving,
      productDeltas: finalProductDeltas,
    };
  }

  /**
   * Genuine last cent: quantity-only adjustment (quarter-kg steps) can't
   * always land on an exact whole-rupee target for a given rate. Nudges one
   * same-product line's RATE at a time (quantity fixed) — a free integer
   * degree of freedom that can usually close a small residual exactly,
   * without touching a different product or a different line's quantity.
   * Mutates `invoices` in place and returns whatever residual is left after
   * nudging (0 if fully closed). Never pushes an invoice further over the
   * batch's maximum invoice amount than it already was, and never accepts a
   * nudge that makes the residual bigger than it started.
   *
   * Reused both by `repairResidual` (closing what's left after quantity
   * redistribution) and by SalesAutoBalanceEngine (closing whatever residual
   * remains once brand-new invoices from SalesNewInvoiceCreator are folded
   * in — those add real new money that this same pass has to account for).
   */
  public static closeAmountResidual(
    invoices: SalesInvoice[],
    editedProductIds: Set<string>,
    context: SalesBalanceContext,
    targetResidual: number,
  ): number {
    let residual = targetResidual;
    if (Math.abs(residual) < 0.001) return residual;

    const thresholdMax = context.thresholdMax || 0;

    // Closing a money residual isn't restricted to the directly-edited
    // product — any product can lend rate/quantity headroom, as long as
    // ITS OWN batch-wide quantity total stays exactly conserved (every
    // move below is a net-zero transfer between two lines of the same
    // product, so that's automatic). editedProductIds go first — smallest
    // blast radius, most predictable — with every other product in the
    // batch as extra headroom once those are exhausted.
    const allProductIds = [
      ...editedProductIds,
      ...Array.from(context.constraints.keys()).filter(
        (id) => !editedProductIds.has(id),
      ),
    ];

    outerRateClose: for (const pid of allProductIds) {
      const constraint = context.constraints.get(pid);
      if (!constraint) continue;

      for (const inv of invoices as any[]) {
        const line = inv.products.find((p: any) => p.product_id === pid);
        if (!line || !(line.quantity > 0)) continue;
        const idealRate = roundToWholeInteger(
          (line.amount + residual) / line.quantity,
        );
        const boundedRate = Math.min(
          constraint.rateMax,
          Math.max(constraint.rateMin, idealRate),
        );
        const newAmount = computeLineAmount(line.quantity, boundedRate);
        const achievedDelta = newAmount - line.amount;
        if (Math.abs(achievedDelta) < 0.001) continue;

        // Never push this invoice further over the batch's maximum invoice
        // amount than it already was.
        if (thresholdMax > 0) {
          const otherLinesTotal = roundMoney(inv.total_amount - line.amount);
          const newInvoiceTotal = roundMoney(otherLinesTotal + newAmount);
          if (
            newInvoiceTotal > thresholdMax + 0.01 &&
            newInvoiceTotal > inv.total_amount + 0.01
          ) {
            continue;
          }
        }

        // Only ever commit this if it strictly improves things. A line
        // whose rate is already clamped near its bound (or whose quantity
        // is small enough that even a 1-rupee rate step swings the amount
        // by more than the whole residual) could otherwise overshoot past 0
        // and land further away than where it started — never accept a
        // "fix" that makes the residual bigger.
        const prospectiveResidual = roundMoney(residual - achievedDelta);
        if (Math.abs(prospectiveResidual) >= Math.abs(residual)) {
          continue;
        }

        line.rate = boundedRate;
        line.amount = newAmount;
        inv.total_amount = Math.round(
          inv.products.reduce(
            (s: number, p: any) => s + Math.round(p.amount || 0),
            0,
          ),
        );

        residual = prospectiveResidual;
        if (Math.abs(residual) < 0.001) break outerRateClose;
      }
    }

    // Large residuals (thousands of rupees) usually can't be closed in one
    // shot by any single donor/rate combination — the exact-divisor pass
    // below only commits when it finds one transfer that closes the WHOLE
    // remaining gap exactly, so on a big gap it can find nothing and do
    // nothing at all. Chip away at it first: repeatedly take the largest
    // available donor line of the edited product, push a NEW line elsewhere
    // to the most extreme rate the product's rules allow, and move as much
    // quantity as fits without overshooting the residual. Quantity is never
    // stranded below a minimum (that floor doesn't apply during balancing),
    // so a donor can be drained across several rounds. Whatever's left after
    // this — typically small, since rounding a quantity down to the nearest
    // 0.25 loses at most a sliver of leverage each round — gets closed
    // exactly by the divisor-based finisher further down.
    if (Math.abs(residual) > 0.001) {
      for (const pid of allProductIds) {
        const constraint = context.constraints.get(pid);
        if (!constraint) continue;

        let guard = 0;
        while (Math.abs(residual) > 0.001 && guard++ < 2000) {
          const sign = residual > 0 ? 1 : -1;
          const donors = (invoices as any[])
            .map((inv) => ({
              inv,
              line: inv.products.find((p: any) => p.product_id === pid),
            }))
            .filter((d) => d.line && d.line.quantity > 0)
            .sort((a, b) => b.line.quantity - a.line.quantity);

          let applied = false;
          for (const { inv: donorInv, line: donorLine } of donors) {
            const boundRate =
              sign > 0 ? constraint.rateMax : constraint.rateMin;
            const rateDelta = boundRate - donorLine.rate;
            // No room left to push this donor's rate further in the needed
            // direction — it's already at (or past) the bound.
            if (sign > 0 ? rateDelta <= 0 : rateDelta >= 0) continue;

            const neededQ = Math.abs(residual) / Math.abs(rateDelta);
            const q =
              Math.floor(Math.min(donorLine.quantity, neededQ) * 4) / 4;
            if (q < 0.25) continue;

            for (const hostInv of invoices as any[]) {
              if (hostInv === donorInv) continue;
              if (
                (hostInv.products || []).some(
                  (p: any) => p.product_id === pid,
                )
              ) {
                continue;
              }
              const newAmount = computeLineAmount(q, boundRate);
              if (thresholdMax > 0) {
                const prospectiveHostTotal = roundMoney(
                  hostInv.total_amount + newAmount,
                );
                if (
                  prospectiveHostTotal > thresholdMax + 0.01 &&
                  prospectiveHostTotal > hostInv.total_amount + 0.01
                ) {
                  continue;
                }
              }

              donorLine.quantity = roundToQuarterIncrement(
                donorLine.quantity - q,
              );
              donorLine.amount = computeLineAmount(
                donorLine.quantity,
                donorLine.rate,
              );
              if (donorLine.quantity <= 0.001) {
                donorInv.products = donorInv.products.filter(
                  (p: any) => p !== donorLine,
                );
              }
              donorInv.total_amount = Math.round(
                donorInv.products.reduce(
                  (s: number, p: any) => s + Math.round(p.amount || 0),
                  0,
                ),
              );

              hostInv.products.push({
                ...donorLine,
                quantity: q,
                rate: boundRate,
                amount: newAmount,
                customer_id:
                  hostInv.products[0]?.customer_id ?? donorLine.customer_id,
              });
              hostInv.total_amount = Math.round(
                hostInv.products.reduce(
                  (s: number, p: any) => s + Math.round(p.amount || 0),
                  0,
                ),
              );

              residual = roundMoney(residual - q * rateDelta);
              applied = true;
              break;
            }
            if (applied) break;
          }
          if (!applied) break;
        }
      }
    }

    // Whole-line rate nudging can get permanently stuck on a residual when
    // every candidate line's own rate is already clamped near its bound in
    // the needed direction (their combined headroom just isn't enough) — a
    // line with quantity 50 can also only move money in ₹50 multiples per
    // rate step, so even an unclamped small residual can be unreachable
    // through that line alone. Move a purpose-sized quantity `q` between a
    // donor line (an existing line of the same edited product, now free to
    // drain all the way to 0 — quantityMin is not enforced during
    // balancing) and a brand-new line elsewhere instead: since amounts are
    // whole rupees, choosing `q` as a divisor of `residual * 4` (quarter-kg
    // units) makes `residual / q` land on an exact integer rate step —
    // this works for a ₹23,000 gap exactly as well as a ₹23 one, as long as
    // some donor has enough quantity and some resulting rate fits within
    // [rateMin, rateMax]. Total quantity of the product is unaffected (q
    // moved off the donor line, q added elsewhere).
    if (Math.abs(residual) > 0.001) {
      // All divisors of N, used to find the exact quarter-kg transfer size
      // `q = k/4` that makes `residual / q` an integer.
      const divisorsOf = (n: number): number[] => {
        const divs: number[] = [];
        for (let k = 1; k * k <= n; k++) {
          if (n % k === 0) {
            divs.push(k);
            if (k !== n / k) divs.push(n / k);
          }
        }
        return divs.sort((a, b) => b - a); // largest first (smallest resulting rate delta)
      };

      outerFineClose: for (const pid of allProductIds) {
        const constraint = context.constraints.get(pid);
        if (!constraint) continue;

        const N = Math.round(Math.abs(residual) * 4);
        if (N === 0) continue;
        const sign = residual > 0 ? 1 : -1;
        const allDivisors = divisorsOf(N);

        // Prefer the biggest available donor line first — more available
        // quantity means more candidate k's (up to 4*quantity) fit, and a
        // bigger `q` means a smaller, more-likely-in-bounds rate delta.
        const donors = (invoices as any[])
          .map((inv) => ({
            inv,
            line: inv.products.find((p: any) => p.product_id === pid),
          }))
          .filter((d) => d.line && d.line.quantity > 0)
          .sort((a, b) => b.line.quantity - a.line.quantity);

        for (const { inv: donorInv, line: donorLine } of donors) {
          const maxK = Math.floor(donorLine.quantity * 4 + 0.001);
          if (maxK < 1) continue;

          let chosenK: number | null = null;
          let chosenRate: number | null = null;
          for (const k of allDivisors) {
            if (k > maxK) continue;
            const rateDelta = sign * (N / k);
            const candidateRate = donorLine.rate + rateDelta;
            if (
              candidateRate >= constraint.rateMin &&
              candidateRate <= constraint.rateMax &&
              candidateRate >= 1
            ) {
              chosenK = k;
              chosenRate = candidateRate;
              break;
            }
          }
          if (chosenK === null || chosenRate === null) continue;

          const q = roundToQuarterIncrement(chosenK / 4);
          const newLineAmount = computeLineAmount(q, chosenRate);

          // Host the new line on any OTHER invoice that doesn't already
          // carry this product — adding it alongside the donor's own
          // existing line would create a new duplicate line, which is
          // only ever grandfathered when it already existed.
          for (const hostInv of invoices as any[]) {
            if (hostInv === donorInv) continue;
            if (
              (hostInv.products || []).some(
                (p: any) => p.product_id === pid,
              )
            ) {
              continue;
            }
            if (thresholdMax > 0) {
              const prospectiveHostTotal = roundMoney(
                hostInv.total_amount + newLineAmount,
              );
              if (
                prospectiveHostTotal > thresholdMax + 0.01 &&
                prospectiveHostTotal > hostInv.total_amount + 0.01
              ) {
                continue;
              }
            }

            donorLine.quantity = roundToQuarterIncrement(
              donorLine.quantity - q,
            );
            donorLine.amount = computeLineAmount(
              donorLine.quantity,
              donorLine.rate,
            );
            if (donorLine.quantity <= 0.001) {
              donorInv.products = donorInv.products.filter(
                (p: any) => p !== donorLine,
              );
            }
            donorInv.total_amount = Math.round(
              donorInv.products.reduce(
                (s: number, p: any) => s + Math.round(p.amount || 0),
                0,
              ),
            );

            hostInv.products.push({
              ...donorLine,
              quantity: q,
              rate: chosenRate,
              amount: newLineAmount,
              customer_id:
                hostInv.products[0]?.customer_id ?? donorLine.customer_id,
            });
            hostInv.total_amount = Math.round(
              hostInv.products.reduce(
                (s: number, p: any) => s + Math.round(p.amount || 0),
                0,
              ),
            );

            residual = 0;
            break outerFineClose;
          }
        }
      }
    }

    return residual;
  }

  private static searchResidualCombinations(
    invoices: SalesInvoice[],
    targetAmountResidual: number,
    targetQtyResiduals: Map<string, number>,
    context: SalesBalanceContext,
    editedProductIds: Set<string>,
  ): SalesInvoice[] | null {
    let combinationsTried = 0;
    let solutionFound: SalesInvoice[] | null = null;

    const explore = (
      invoiceIdx: number,
      currentInvoices: SalesInvoice[],
    ): boolean => {
      if (invoiceIdx === invoices.length) {
        combinationsTried++;
        if (combinationsTried > SALES_BALANCE_LIMITS.maxResidualCombinations) {
          return false;
        }

        // Check if current combination closes all residuals
        const currentAmountSum = roundMoney(
          currentInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
        );
        const expectedAmountSum = roundMoney(
          invoices.reduce((sum, inv) => sum + inv.total_amount, 0) +
            targetAmountResidual,
        );

        if (Math.abs(currentAmountSum - expectedAmountSum) >= 0.01) {
          return false;
        }

        // Check quantity residuals
        for (const [pid, reqQtyDiff] of targetQtyResiduals.entries()) {
          let origSum = 0;
          let currentSum = 0;
          for (let k = 0; k < invoices.length; k++) {
            origSum +=
              invoices[k].products.find((p) => p.product_id === pid)
                ?.quantity || 0;
            currentSum +=
              currentInvoices[k].products.find((p) => p.product_id === pid)
                ?.quantity || 0;
          }
          const actualDiff = roundToQuarterIncrement(currentSum - origSum);
          if (Math.abs(actualDiff - reqQtyDiff) > 0.001) {
            return false;
          }
        }

        solutionFound = currentInvoices;
        return true;
      }

      const inv = invoices[invoiceIdx];
      // Generate small adjustments to lines in inv
      const adjustedInvoiceVariations = this.generateInvoiceVariations(
        inv,
        context,
        editedProductIds,
      );

      for (const varInv of adjustedInvoiceVariations) {
        if (explore(invoiceIdx + 1, [...currentInvoices, varInv])) {
          return true;
        }
      }

      return false;
    };

    explore(0, []);
    return solutionFound;
  }

  private static generateInvoiceVariations(
    invoice: SalesInvoice,
    context: SalesBalanceContext,
    editedProductIds: Set<string>,
  ): SalesInvoice[] {
    const variations: SalesInvoice[] = [invoice]; // Always include unchanged invoice

    for (const p of invoice.products) {
      // Balancing must only ever touch the product(s) actually edited.
      if (!editedProductIds.has(p.product_id)) continue;
      const uom = p.unit_of_measure || "kg";
      const isWeight =
        uom.toLowerCase().includes("kg") || uom.toLowerCase().includes("ton");
      const step = isWeight ? 0.25 : 1;

      // Small quantity variations
      const qtyOptions = [
        roundToQuarterIncrement(p.quantity - step),
        roundToQuarterIncrement(p.quantity + step),
      ].filter((q) => q >= 0);

      // Small rate variations
      const rateOptions = [p.rate - 1, p.rate + 1].filter((r) => r >= 1);

      for (const q of qtyOptions) {
        const newProducts = invoice.products.map((line) =>
          line.product_id === p.product_id
            ? { ...line, quantity: q, amount: computeLineAmount(q, line.rate) }
            : line,
        );
        const newTotal = roundMoney(
          newProducts.reduce((sum, l) => sum + l.amount, 0),
        );
        variations.push({
          ...invoice,
          products: newProducts,
          total_amount: newTotal,
        });
      }

      for (const r of rateOptions) {
        const newProducts = invoice.products.map((line) =>
          line.product_id === p.product_id
            ? { ...line, rate: r, amount: computeLineAmount(line.quantity, r) }
            : line,
        );
        const newTotal = roundMoney(
          newProducts.reduce((sum, l) => sum + l.amount, 0),
        );
        variations.push({
          ...invoice,
          products: newProducts,
          total_amount: newTotal,
        });
      }
    }

    return variations;
  }
}
