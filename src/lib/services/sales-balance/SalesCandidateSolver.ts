import {
  computeLineAmount,
  roundToQuarterIncrement,
  roundToWholeInteger,
} from "@/lib/utils/quantity-rate-utils";
import { SalesCandidateGenerator } from "./SalesCandidateGenerator";
import { SalesCandidateScorer } from "./SalesCandidateScorer";
import {
  roundMoney,
  SALES_BALANCE_LIMITS,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesSolverPlan,
  SalesSolverResult,
} from "./types";

interface SearchState {
  invoiceIndex: number;
  productTotals: Map<string, number>;
  accumulatedAmount: number;
  accumulatedCost: number;
  chosenInvoices: SalesInvoice[];
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

    // 1. Identify balancing invoices (all invoices in batch except edited invoice)
    const balancingInvoices = context.invoices
      .filter((inv) => inv.id !== editedInvoice.id)
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

    // 2. Compute target balancing total amount & target product quantities
    const targetBalancingAmount = roundMoney(
      context.batchTotal - editedInvoice.total_amount,
    );

    const targetProductTotals = new Map<string, number>();
    for (const [pid, origTotal] of context.originalProductTotals.entries()) {
      const editedQty =
        editedInvoice.products.find((p) => p.product_id === pid)?.quantity || 0;
      targetProductTotals.set(
        pid,
        roundToQuarterIncrement(origTotal - editedQty),
      );
    }

    if (balancingInvoices.length === 0) {
      if (
        Math.abs(editedInvoice.total_amount - context.batchTotal) < 0.01 &&
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

    const origEditedInv = context.invoices.find(
      (i) => i.id === editedInvoice.id,
    );
    const affectedProductIds = new Set<string>();
    for (const [pid] of context.originalProductTotals.entries()) {
      affectedProductIds.add(pid);
    }

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
          context.availableStockMap,
          targetProductTotals,
          affectedProductIds,
          originalTotalBalancingMap,
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

    const initialQueue: SearchState[] = [
      {
        invoiceIndex: 0,
        productTotals: initialProductTotals,
        accumulatedAmount: 0,
        accumulatedCost: 0,
        chosenInvoices: [],
      },
    ];

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
      initialQueue.sort((a, b) => {
        if (a.invoiceIndex !== b.invoiceIndex) {
          return b.invoiceIndex - a.invoiceIndex;
        }
        return a.accumulatedCost - b.accumulatedCost;
      });
      const current = initialQueue.shift()!;

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

        const stateDiff =
          Array.from(productDeltas.values()).reduce(
            (sum, d) => sum + Math.abs(d),
            0,
          ) + amountDiff;

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
            balancingInvoices: current.chosenInvoices,
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
            balancingInvoices: current.chosenInvoices,
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

      for (const cand of candidates) {
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
          accumulatedAmount: roundMoney(
            current.accumulatedAmount + cand.totalAmount,
          ),
          accumulatedCost: current.accumulatedCost + cand.cost,
          chosenInvoices: [...current.chosenInvoices, nextInvoice],
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
    const results: {
      products: SalesLine[];
      totalAmount: number;
      cost: number;
    }[] = [];

    const generateCombo = (lineIndex: number, currentLines: SalesLine[]) => {
      if (lineIndex === lineCandidates.length) {
        const activeLines = currentLines.filter((l) => l.quantity > 0);
        if (activeLines.length === 0) return; // Do not generate empty invoice candidates

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
        return;
      }

      const { candidates } = lineCandidates[lineIndex];
      for (const cand of candidates) {
        generateCombo(lineIndex + 1, [...currentLines, cand.line]);
      }
    };

    generateCombo(0, []);

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
