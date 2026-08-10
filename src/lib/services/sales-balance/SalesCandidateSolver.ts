import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import { SalesCandidateGenerator } from "./SalesCandidateGenerator";
import { SalesCandidateScorer } from "./SalesCandidateScorer";
import {
  buildProductTemplates,
  diffEditedProductIds,
  SalesAllocationTracker,
} from "./SalesLineCapacity";
import {
  roundMoney,
  SALES_BALANCE_LIMITS,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesSolverPlan,
  SalesSolverResult,
} from "./types";

// `chosen` links back to the parent state instead of eagerly spreading a new
// array on every push (`[...current.chosenInvoices, nextInvoice]`) — that
// copy is O(invoiceIndex) and ran on every single state expansion, which
// made the whole search scale quadratically with the number of balancing
// invoices in a batch. The real array is built only when a state actually
// reaches the terminal depth and needs to be reported as a plan.
type ChosenChainNode = {
  invoice: SalesInvoice;
  parent: ChosenChainNode | null;
};

function buildChosenInvoices(chain: ChosenChainNode | null): SalesInvoice[] {
  const invoices: SalesInvoice[] = [];
  for (let node = chain; node; node = node.parent) {
    invoices.push(node.invoice);
  }
  invoices.reverse();
  return invoices;
}

interface SearchState {
  invoiceIndex: number;
  productTotals: Map<string, number>;
  tracker: SalesAllocationTracker;
  accumulatedAmount: number;
  accumulatedCost: number;
  chosenChain: ChosenChainNode | null;
}

// Sorting the entire frontier array on every single pop (as this search
// used to) costs O(n log n) per pop — with up to maxSearchStates (20,000)
// pops, that is effectively O(n^2 log n) overall. A binary min-heap keeps
// both push and pop at O(log n).
class SearchQueue {
  private heap: SearchState[] = [];

  get length(): number {
    return this.heap.length;
  }

  push(state: SearchState): void {
    this.heap.push(state);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): SearchState | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop() as SearchState;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      const n = this.heap.length;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0)
          smallest = left;
        if (
          right < n &&
          this.compare(this.heap[right], this.heap[smallest]) < 0
        )
          smallest = right;
        if (smallest === i) break;
        [this.heap[i], this.heap[smallest]] = [
          this.heap[smallest],
          this.heap[i],
        ];
        i = smallest;
      }
    }
    return top;
  }

  // Pop state with deepest invoiceIndex first, then lowest accumulated cost.
  private compare(a: SearchState, b: SearchState): number {
    if (a.invoiceIndex !== b.invoiceIndex) return b.invoiceIndex - a.invoiceIndex;
    return a.accumulatedCost - b.accumulatedCost;
  }
}

export class SalesCandidateSolver {
  /**
   * Performs bounded deterministic search to balance a Sales batch.
   */
  public static solveBatchBalance(
    context: SalesBalanceContext,
    editedInvoice: SalesInvoice,
  ): SalesSolverResult {
    const startTime = Date.now();

    // 1. Determine edited products (product IDs whose quantity, rate, or amount changed)
    const origEditedInv = context.invoices.find(
      (i) => i.id === editedInvoice.id,
    );
    const editedProductIds = diffEditedProductIds(
      origEditedInv?.products,
      editedInvoice.products,
    );

    // 2. Build balancingInvoices from ANY invoice in the batch — balancing
    // is not restricted to invoices that already carry the edited product;
    // an invoice with no existing line for it is still eligible to have
    // that product added as a brand-new line (see productTemplates below).
    // Only exclusion: the edited invoice itself, and any invoice belonging
    // to a major customer (never touched by rebalancing).
    const balancingInvoices = context.invoices
      .filter((inv) => {
        if (inv.id === editedInvoice.id) return false;
        const partyId = inv.products?.[0]?.customer_id;
        if (partyId && context.majorCustomerIds.has(partyId)) return false;
        return true;
      })
      .sort((a, b) => {
        const dateCmp = a.invoice_date.localeCompare(b.invoice_date);
        if (dateCmp !== 0) return dateCmp;
        const numCmp = a.invoice_number.localeCompare(
          b.invoice_number,
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          },
        );
        if (numCmp !== 0) return numCmp;
        return a.id.localeCompare(b.id);
      });

    console.log("[SalesCandidateSolver] Scope Filtering Report:", {
      originalBatchInvoiceCount: context.invoices.length,
      filteredBalancingInvoiceCount: balancingInvoices.length,
      editedProductsCount: editedProductIds.size,
      editedProductsList: Array.from(editedProductIds),
    });

    // 2. Compute target balancing total amount & target product quantities.
    // `balancingInvoices` is only the small subset of the batch that
    // actually holds an edited product — every other invoice in the batch
    // is untouched and contributes a fixed, unchanging amount to
    // context.batchTotal. The subset must therefore sum to whatever it
    // originally summed to, adjusted by however much the edited invoice's
    // own total changed — NOT to "the whole batch total minus the edited
    // invoice," which conflates the untouched invoices' total in as if it
    // still needed to be accounted for here.
    const originalEditedTotal = origEditedInv ? origEditedInv.total_amount : 0;
    const originalSubsetTotal = balancingInvoices.reduce(
      (sum, inv) => sum + inv.total_amount,
      0,
    );
    const targetBalancingAmount = roundMoney(
      originalEditedTotal + originalSubsetTotal - editedInvoice.total_amount,
    );

    // Only edited products need a balancing target at all — every other
    // product is locked to its original quantity by generateInvoiceLineCandidates
    // and therefore trivially conserved. Scoring ALL batch products here
    // used to compare each one's batch-WIDE total against a sum accumulated
    // only across `balancingInvoices` (the invoices actually holding an
    // edited product, a small subset of the whole batch) — a scope
    // mismatch that made nearly every product look like it had a huge
    // "delta" even though nothing about it had changed, and made an exact
    // match essentially unreachable.
    const targetProductTotals = new Map<string, number>();
    for (const pid of editedProductIds) {
      const origTotal = context.originalProductTotals.get(pid) || 0;
      const editedQty =
        editedInvoice.products.find((p) => p.product_id === pid)?.quantity || 0;
      targetProductTotals.set(
        pid,
        roundToQuarterIncrement(origTotal - editedQty),
      );
    }

    if (balancingInvoices.length === 0) {
      // No other invoice to redistribute money with — the only way the
      // batch total can stay exact is if the edited invoice's own total
      // didn't actually change at all.
      if (
        Math.abs(editedInvoice.total_amount - originalEditedTotal) < 0.01 &&
        Array.from(targetProductTotals.values()).every(
          (q) => Math.abs(q) < 0.001,
        )
      ) {
        return {
          outcome: "solution_found",
          plan: {
            editedInvoice,
            balancingInvoices: [],
            totalCost: 0,
            batchDelta: 0,
            productDeltas: new Map(),
          },
        };
      }
      return {
        outcome: "no_solution",
        message: "No balancing invoices available in batch.",
      };
    }

    // Only the products actually edited may vary at all — reusing
    // editedProductIds here (computed above) rather than every product in
    // the batch is what keeps redistribution same-product-only AND keeps
    // the search space tractable. Locking every unaffected product to its
    // original line was the whole point of passing affectedProductIds into
    // generateInvoiceLineCandidates below; populating it with ALL products
    // (as this used to do) made every single line on every balancing
    // invoice free to vary, which both violates "never touch a different
    // product" and blows the search space up so badly that batches with
    // many invoices never converge before hitting maxSearchStates.
    const affectedProductIds = editedProductIds;

    const originalTotalBalancingMap = new Map<string, number>();
    for (const inv of balancingInvoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          originalTotalBalancingMap.set(
            p.product_id,
            roundToQuarterIncrement(
              (originalTotalBalancingMap.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
      }
    }

    // Per-line candidate generation only caps a SINGLE line against the
    // date/product's shared stock ceiling — it has no visibility into other
    // balancing invoices on the same date also being free to grow the same
    // product. Two invoices can each individually stay under the ceiling
    // while their combined total exceeds it, which previously only got
    // caught (rejecting the whole plan) by SalesFinalValidator's Rule 8,
    // after the search had already committed to that combination. One
    // shared tracker (also used by SalesCandidateGenerator's candidate
    // ceilings, SalesResidualRepair, and SalesNewInvoiceCreator) records a
    // running per-date/product total as invoices are chosen during the
    // search itself, so an over-allocating combination is never selected.
    const touchedOriginalInvoices = origEditedInv
      ? [origEditedInv, ...balancingInvoices]
      : balancingInvoices;
    const rootTracker = SalesAllocationTracker.build(
      context,
      touchedOriginalInvoices,
      editedProductIds,
    );
    for (const p of editedInvoice.products) {
      if (editedProductIds.has(p.product_id)) {
        rootTracker.record(editedInvoice.invoice_date, p.product_id, p.quantity);
      }
    }

    // Template lines for synthesizing a brand-new product line on a
    // balancing invoice that doesn't currently carry an edited product at
    // all — needed now that balancingInvoices is the whole batch, not just
    // invoices that already hold the product.
    const productTemplates = buildProductTemplates(
      context,
      editedInvoice,
      origEditedInv,
      editedProductIds,
    );

    // 3. Pre-generate invoice line candidates for each balancing invoice
    const candidatesPerInvoice: {
      invoice: SalesInvoice;
      candidates: {
        products: SalesLine[];
        totalAmount: number;
        cost: number;
      }[];
    }[] = [];

    for (const inv of balancingInvoices) {
      const lineCandidates =
        SalesCandidateGenerator.generateInvoiceLineCandidates(
          inv,
          context.constraints,
          rootTracker,
          targetProductTotals,
          affectedProductIds,
          originalTotalBalancingMap,
          context.thresholdMax,
          productTemplates,
        );

      // Cartesian product of line candidates for this invoice
      const invoiceCombinations = this.generateInvoiceCombinations(
        inv,
        lineCandidates,
        context,
        targetProductTotals,
        balancingInvoices.length,
      );

      candidatesPerInvoice.push({
        invoice: inv,
        candidates: invoiceCombinations,
      });

      console.log(
        `[SalesCandidateSolver] Candidate Invoice #${candidatesPerInvoice.length} (${inv.invoice_number}): generated ${invoiceCombinations.length} candidate combinations.`,
      );
    }

    console.log(
      `[SalesCandidateSolver] Total Balancing Candidate Invoices: ${balancingInvoices.length}. Total candidatesPerInvoice entries: ${candidatesPerInvoice.length}.`,
    );

    // 4. State space exploration using priority queue (lowest cost state first)
    let statesExplored = 0;
    let completeStatesReached = 0;
    let bestPlan: SalesSolverPlan | null = null;

    const initialProductTotals = new Map<string, number>();
    for (const pid of targetProductTotals.keys()) {
      initialProductTotals.set(pid, 0);
    }

    const initialQueue = new SearchQueue();
    initialQueue.push({
      invoiceIndex: 0,
      productTotals: initialProductTotals,
      tracker: rootTracker,
      accumulatedAmount: 0,
      accumulatedCost: 0,
      chosenChain: null,
    });

    let closestPlan: SalesSolverPlan | null = null;
    let minStateDiff = Number.POSITIVE_INFINITY;

    while (initialQueue.length > 0) {
      statesExplored++;

      if (statesExplored > SALES_BALANCE_LIMITS.maxSearchStates) {
        if (closestPlan) {
          return {
            outcome: "solution_found",
            plan: closestPlan,
          };
        }
        return {
          outcome: "limits_exceeded",
          message: `Search state limit of ${SALES_BALANCE_LIMITS.maxSearchStates} exceeded.`,
        };
      }

      if (Date.now() - startTime > SALES_BALANCE_LIMITS.searchTimeoutMs) {
        if (closestPlan) {
          return {
            outcome: "solution_found",
            plan: closestPlan,
          };
        }
        return {
          outcome: "limits_exceeded",
          message: `Search timeout of ${SALES_BALANCE_LIMITS.searchTimeoutMs}ms exceeded.`,
        };
      }

      // Pop state with deepest index and lowest accumulated cost
      const current = initialQueue.pop() as SearchState;

      if (current.invoiceIndex === balancingInvoices.length) {
        completeStatesReached++;
        // Evaluate complete plan
        const batchDelta = roundMoney(
          targetBalancingAmount - current.accumulatedAmount,
        );
        const amountDiff = Math.abs(batchDelta);
        const isAmountMatched = amountDiff < 0.01;

        let isProductsMatched = true;
        const productDeltas = new Map<string, number>();

        for (const [pid, targetQty] of targetProductTotals.entries()) {
          const currentQty = current.productTotals.get(pid) || 0;
          const diff = roundToQuarterIncrement(targetQty - currentQty);
          productDeltas.set(pid, diff);
          if (Math.abs(diff) > 0.001) {
            isProductsMatched = false;
          }
        }

        // Quantity conservation is a hard invariant with no fallback (money
        // residuals get one more chance via the rate-nudge safety net
        // downstream; a real KG conservation gap does not). Summing raw KG
        // and raw ₹ together used to let the search prefer a candidate that
        // closed money tightly while letting quantity drift by hundreds of
        // KG, since rupee figures are numerically much larger than kilogram
        // figures — the "closest" plan was optimizing the wrong thing.
        // Weighting KG heavily makes any nonzero product-quantity diff
        // dominate the score over a realistic money residual, so "closest"
        // actually means closest to true product conservation first.
        const KG_DOMINANCE_WEIGHT = 100000;
        const productDiffSum = Array.from(productDeltas.values()).reduce(
          (sum, d) => sum + Math.abs(d),
          0,
        );
        const stateDiff = productDiffSum * KG_DOMINANCE_WEIGHT + amountDiff;

        console.log(
          `[SalesCandidateSolver] Reached Complete State #${completeStatesReached} (Explored #${statesExplored}):`,
          {
            isAmountMatched,
            isProductsMatched,
            batchDelta,
            productDeltas: Object.fromEntries(productDeltas.entries()),
            stateDiff,
            rejectionReason:
              !isAmountMatched && !isProductsMatched
                ? `Amount diff (₹${amountDiff}) & Product diffs non-zero`
                : !isAmountMatched
                  ? `Amount diff (₹${amountDiff}) non-zero`
                  : !isProductsMatched
                    ? `Product diffs non-zero`
                    : "None (Exact Match)",
          },
        );

        if (stateDiff < minStateDiff) {
          minStateDiff = stateDiff;
          closestPlan = {
            editedInvoice,
            balancingInvoices: buildChosenInvoices(current.chosenChain),
            totalCost: current.accumulatedCost,
            batchDelta,
            productDeltas,
          };
          console.log(
            `[SalesCandidateSolver] Updated closestPlan at complete state #${completeStatesReached}. minStateDiff=${minStateDiff}`,
          );
        }

        if (isAmountMatched && isProductsMatched) {
          bestPlan = {
            editedInvoice,
            balancingInvoices: buildChosenInvoices(current.chosenChain),
            totalCost: current.accumulatedCost,
            batchDelta: 0,
            productDeltas,
          };
          break;
        }
        continue;
      }

      const { invoice, candidates } =
        candidatesPerInvoice[current.invoiceIndex];

      if (!candidates || candidates.length === 0) {
        console.log(
          `[SalesCandidateSolver] DISCARDED SEARCH BRANCH at invoiceIndex=${current.invoiceIndex} (${invoice.invoice_number}):`,
          {
            reason: "0 candidate combinations generated for this invoice",
            candidateRejected: invoice.invoice_number,
            currentAccumulatedAmount: current.accumulatedAmount,
            currentProductTotals: Object.fromEntries(
              current.productTotals.entries(),
            ),
          },
        );
        continue;
      }

      candidateLoop: for (const cand of candidates) {
        // Reject this candidate outright if it would push the running
        // per-date/product total (across every invoice the search has
        // chosen so far, plus the edited invoice's own fixed contribution)
        // past the real shared ceiling for that date/product.
        const nextTracker = current.tracker.fork();
        for (const p of cand.products) {
          if (!editedProductIds.has(p.product_id)) continue;
          const ceiling = nextTracker.ceilingFor(
            invoice.invoice_date,
            p.product_id,
          );
          if (ceiling === Number.POSITIVE_INFINITY) continue;
          const used = nextTracker.usedFor(invoice.invoice_date, p.product_id);
          if (roundToQuarterIncrement(used + p.quantity) > ceiling + 0.01) {
            continue candidateLoop;
          }
          nextTracker.record(invoice.invoice_date, p.product_id, p.quantity);
        }

        const nextInvoice: SalesInvoice = {
          ...invoice,
          products: cand.products,
          total_amount: cand.totalAmount,
        };

        const nextProductTotals = new Map(current.productTotals);
        for (const p of cand.products) {
          const prev = nextProductTotals.get(p.product_id) || 0;
          nextProductTotals.set(
            p.product_id,
            roundToQuarterIncrement(prev + p.quantity),
          );
        }

        initialQueue.push({
          invoiceIndex: current.invoiceIndex + 1,
          productTotals: nextProductTotals,
          tracker: nextTracker,
          accumulatedAmount: roundMoney(
            current.accumulatedAmount + cand.totalAmount,
          ),
          accumulatedCost: current.accumulatedCost + cand.cost,
          chosenChain: { invoice: nextInvoice, parent: current.chosenChain },
        });
      }
    }

    const targetPlan = bestPlan || closestPlan;

    console.log("[SalesCandidateSolver] Execution Search Report:", {
      totalBalancingInvoices: balancingInvoices.length,
      statesExplored,
      completeStatesReached,
      reachedTargetIndex: completeStatesReached > 0,
      closestPlanExists: !!closestPlan,
      bestPlanExists: !!bestPlan,
      reasonClosestPlanNotAssigned:
        completeStatesReached === 0
          ? "Search never reached current.invoiceIndex === balancingInvoices.length (complete candidate state was never formed)."
          : "N/A (closestPlan WAS assigned)",
      finalOutcome: targetPlan ? "solution_found" : "no_solution",
      finalBatchDelta: targetPlan?.batchDelta,
      finalProductDeltas: targetPlan
        ? Object.fromEntries(targetPlan.productDeltas.entries())
        : null,
    });

    if (targetPlan) {
      return {
        outcome: "solution_found",
        plan: targetPlan,
      };
    }

    return {
      outcome: "no_solution",
      message:
        "No valid combination of balancing candidates satisfied batch total and product quantity invariants.",
    };
  }

  /**
   * Generates combinations of line candidates for an invoice.
   */
  private static generateInvoiceCombinations(
    invoice: SalesInvoice,
    lineCandidates: {
      productId: string;
      originalLine: SalesLine;
      candidates: any[];
    }[],
    context: SalesBalanceContext,
    targetProductTotals?: Map<string, number>,
    balancingInvoiceCount = 1,
  ): { products: SalesLine[]; totalAmount: number; cost: number }[] {
    // Combine per-line candidates using bounded beam search instead of a
    // full cartesian product. With up to maxLineCandidates per line and
    // maxInvoiceLines lines on an invoice, an exhaustive cartesian product
    // can reach billions of combinations and exhaust process memory — this
    // caps memory to O(lines * BEAM_WIDTH * candidatesPerLine). The true
    // per-invoice cost (SalesCandidateScorer) requires the complete active
    // line set, so during the beam we prune using the cheap, additive
    // |delta| sum as a proxy, then compute the real cost only for the
    // bounded set of survivors.
    // Only a small, bounded slice of these survivors is ever used downstream
    // (generateInvoiceCombinations further dedupes/sorts to top ~64+64), so
    // a wide beam buys diversity nothing downstream uses — kept small to
    // bound cost across many balancing invoices in one batch.
    const BEAM_WIDTH = 48;
    // Beam entries link to their parent instead of copying the whole
    // `lines` array on every push (`[...state.lines, cand.line]` costs
    // O(lineIndex) per candidate) — that made this step scale quadratically
    // with line count and, multiplied across every balancing invoice in a
    // batch, was enough to blow the solver's time budget on batches with
    // many invoices. Full arrays are reconstructed once, for survivors only.
    type BeamNode = {
      line: SalesLine | null;
      parent: BeamNode | null;
      deltaCostSum: number;
    };
    const root: BeamNode = { line: null, parent: null, deltaCostSum: 0 };
    let beam: BeamNode[] = [root];

    for (const { candidates } of lineCandidates) {
      const next: BeamNode[] = [];
      for (const state of beam) {
        for (const cand of candidates) {
          next.push({
            line: cand.line,
            parent: state,
            deltaCostSum: state.deltaCostSum + Math.abs(cand.delta),
          });
        }
      }
      next.sort((a, b) => a.deltaCostSum - b.deltaCostSum);
      beam = next.slice(0, BEAM_WIDTH);
    }

    const results: {
      products: SalesLine[];
      totalAmount: number;
      cost: number;
    }[] = [];

    for (const leaf of beam) {
      const lines: SalesLine[] = [];
      for (let node: BeamNode | null = leaf; node && node.line; node = node.parent) {
        lines.push(node.line);
      }
      lines.reverse();
      const activeLines = lines.filter((l) => l.quantity > 0);
      if (activeLines.length === 0) continue; // Do not generate empty invoice candidates

      const totalAmount = roundMoney(
        activeLines.reduce((sum, l) => sum + l.amount, 0),
      );
      const cost = SalesCandidateScorer.scoreInvoiceCandidate(
        invoice.products,
        activeLines,
        context.constraints,
      );

      results.push({
        products: activeLines,
        totalAmount,
        cost,
      });
    }

    const uniqueCombos = new Map<
      string,
      { products: SalesLine[]; totalAmount: number; cost: number }
    >();

    // 1. Sort by lowest cost (preserves minimal movement variations including original state)
    const byCost = [...results].sort((a, b) => a.cost - b.cost);

    // 2. Sort by target matching
    const byTarget = [...results].sort((a, b) => {
      const targetDiffA = a.products.reduce((sum, p) => {
        const hint = targetProductTotals?.get(p.product_id);
        if (hint === undefined) return sum;
        const targetPerInv = hint / balancingInvoiceCount;
        return sum + Math.abs(p.quantity - targetPerInv);
      }, 0);

      const targetDiffB = b.products.reduce((sum, p) => {
        const hint = targetProductTotals?.get(p.product_id);
        if (hint === undefined) return sum;
        const targetPerInv = hint / balancingInvoiceCount;
        return sum + Math.abs(p.quantity - targetPerInv);
      }, 0);

      if (Math.abs(targetDiffA - targetDiffB) > 0.001) {
        return targetDiffA - targetDiffB;
      }
      return a.cost - b.cost;
    });

    const combinedPool = [...byCost.slice(0, 64), ...byTarget.slice(0, 64)];

    for (const res of combinedPool) {
      const qtyKey = res.products
        .map((p) => `${p.product_id}:${p.quantity}`)
        .join(";");
      if (!uniqueCombos.has(qtyKey)) {
        uniqueCombos.set(qtyKey, res);
      }
    }

    return Array.from(uniqueCombos.values()).slice(
      0,
      SALES_BALANCE_LIMITS.maxInvoiceCandidates,
    );
  }
}
