import { CandidateGenerator } from "./CandidateGenerator";
import { CandidateScorer } from "./CandidateScorer";
import { ResidualRepair } from "./ResidualRepair";
import {
  BALANCE_LIMITS,
  InvoiceCandidate,
  LineCandidate,
  MONEY_TOLERANCE,
  ProductConstraint,
  PurchaseInvoice,
  PurchaseLine,
  roundMoney,
  SolverResult,
} from "./types";

export type SolverDPState = {
  totalCost: number;
  chosenCandidates: Map<string, InvoiceCandidate>;
};

export class CandidateSolver {
  /**
   * Solves a purchase batch balance plan deterministically within frozen limits.
   */
  public static solveBatchBalance(
    editedInvoice: PurchaseInvoice,
    allBatchInvoices: PurchaseInvoice[],
    batchTotal: number,
    constraints: Map<string, ProductConstraint>,
  ): SolverResult {
    const startTimeMs = Date.now();
    let statesExplored = 0;

    // 1. Sort all batch invoices deterministically:
    // 1. invoice_date asc
    // 2. invoice_number asc
    // 3. id asc
    const sortedInvoices = [...allBatchInvoices].sort((a, b) => {
      const dateCmp = (a.invoice_date || "").localeCompare(
        b.invoice_date || "",
      );
      if (dateCmp !== 0) return dateCmp;
      const numCmp = (a.invoice_number || "").localeCompare(
        b.invoice_number || "",
      );
      if (numCmp !== 0) return numCmp;
      return a.id.localeCompare(b.id);
    });

    const balancingInvoices = sortedInvoices.filter(
      (inv) => inv.id !== editedInvoice.id,
    );

    // Calculate required adjustment across balancing invoices
    const currentOtherTotal = roundMoney(
      balancingInvoices.reduce((sum, inv) => sum + Number(inv.total_amount), 0),
    );
    const targetOtherTotal = roundMoney(
      batchTotal - editedInvoice.total_amount,
    );
    const targetAdjustmentNeeded = roundMoney(
      targetOtherTotal - currentOtherTotal,
    );

    // 2. Score edited invoice itself
    const editedLineCandidates: LineCandidate[] = (
      editedInvoice.products || []
    ).map((line) => {
      const constraint = constraints.get(line.product_id);
      if (!constraint) {
        throw new Error(
          `Missing constraint for product ${line.product_name || line.product_id}`,
        );
      }
      return CandidateScorer.scoreLineCandidate(
        {
          line,
          delta: 0,
          quantity: line.quantity,
          rate: line.rate,
          amount: line.amount,
        },
        line,
        constraint,
      );
    });
    const scoredEditedInvoice = CandidateScorer.scoreInvoiceCandidate(
      editedLineCandidates,
      editedInvoice,
    );

    // If batch has no balancing invoices, check if edited invoice alone satisfies batch total
    if (balancingInvoices.length === 0) {
      if (
        Math.abs(editedInvoice.total_amount - batchTotal) <= MONEY_TOLERANCE
      ) {
        return {
          outcome: "solution_found",
          plan: {
            editedInvoice: { ...editedInvoice },
            balancingInvoices: [],
            totalCost: scoredEditedInvoice.cost,
            batchDelta: 0,
          },
          statesExplored: 1,
          executionTimeMs: Date.now() - startTimeMs,
        };
      }
      return {
        outcome: "no_valid_solution",
        reason:
          "No balancing invoices exist and edited invoice does not match batch total.",
        statesExplored: 1,
        executionTimeMs: Date.now() - startTimeMs,
      };
    }

    // 3. Generate and score candidates for each balancing invoice
    const candidatesPerInvoice = new Map<string, InvoiceCandidate[]>();

    for (const inv of balancingInvoices) {
      const invoiceCandidates = this.generateAndScoreInvoiceCandidates(
        inv,
        constraints,
      );
      candidatesPerInvoice.set(inv.id, invoiceCandidates);
    }

    // 4. Run Dynamic Programming map search: amount delta -> lowest-cost plan
    let dpMap = new Map<number, SolverDPState>();
    dpMap.set(0, { totalCost: 0, chosenCandidates: new Map() });

    for (const inv of balancingInvoices) {
      const elapsedMs = Date.now() - startTimeMs;
      if (elapsedMs > BALANCE_LIMITS.plannerTimeMs) {
        return {
          outcome: "search_capacity_exceeded",
          reason: "Planner time budget exceeded (2 seconds)",
          statesExplored,
          executionTimeMs: elapsedMs,
        };
      }

      const invCandidates = candidatesPerInvoice.get(inv.id) || [];
      const nextDpMap = new Map<number, SolverDPState>();

      for (const [currentDelta, state] of dpMap.entries()) {
        for (const candidate of invCandidates) {
          const newDelta = roundMoney(currentDelta + candidate.delta);
          const newCost = state.totalCost + candidate.cost;

          const existingState = nextDpMap.get(newDelta);
          if (!existingState || newCost < existingState.totalCost) {
            const nextChosen = new Map(state.chosenCandidates);
            nextChosen.set(inv.id, candidate);
            nextDpMap.set(newDelta, {
              totalCost: newCost,
              chosenCandidates: nextChosen,
            });
          }
        }
      }

      dpMap = nextDpMap;
      statesExplored += dpMap.size;

      if (dpMap.size > BALANCE_LIMITS.maxSolverStates) {
        return {
          outcome: "search_capacity_exceeded",
          reason: `Maximum dynamic programming states exceeded (${dpMap.size} > ${BALANCE_LIMITS.maxSolverStates})`,
          statesExplored,
          executionTimeMs: Date.now() - startTimeMs,
        };
      }
    }

    // Check exact match in DP Map
    let exactState: SolverDPState | undefined;

    for (const [delta, state] of dpMap.entries()) {
      if (Math.abs(delta - targetAdjustmentNeeded) <= MONEY_TOLERANCE) {
        if (!exactState || state.totalCost < exactState.totalCost) {
          exactState = state;
        }
      }
    }

    // 5. Residual Repair check if exact solution not yet found
    if (!exactState && balancingInvoices.length > 0) {
      const repairResult = ResidualRepair.repairResidual(
        targetAdjustmentNeeded,
        balancingInvoices,
        candidatesPerInvoice,
        constraints,
        startTimeMs,
      );

      if (repairResult.status === "failure") {
        if (repairResult.reason === "search_capacity_exceeded") {
          return {
            outcome: "search_capacity_exceeded",
            reason: repairResult.message,
            statesExplored: statesExplored + repairResult.combinationsExplored,
            executionTimeMs: Date.now() - startTimeMs,
          };
        }
      } else if (repairResult.status === "success") {
        exactState = {
          totalCost: repairResult.totalCost,
          chosenCandidates: repairResult.chosenCandidates,
        };
        statesExplored += repairResult.combinationsExplored;
      }
    }

    if (!exactState) {
      return {
        outcome: "no_valid_solution",
        reason: "No valid rebalance plan exists within business rules.",
        statesExplored,
        executionTimeMs: Date.now() - startTimeMs,
      };
    }

    // 6. Build final solution plan
    const finalBalancingInvoices: PurchaseInvoice[] = balancingInvoices.map(
      (origInv) => {
        const chosenCandidate = exactState?.chosenCandidates.get(origInv.id);
        if (!chosenCandidate) return { ...origInv };
        return {
          ...origInv,
          products: chosenCandidate.products.map((p) => ({ ...p })),
          total_amount: chosenCandidate.totalAmount,
        };
      },
    );

    const totalCost = scoredEditedInvoice.cost + (exactState.totalCost || 0);

    const calculatedBatchTotal = roundMoney(
      editedInvoice.total_amount +
        finalBalancingInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );
    const batchDelta = roundMoney(calculatedBatchTotal - batchTotal);

    return {
      outcome: "solution_found",
      plan: {
        editedInvoice: { ...editedInvoice },
        balancingInvoices: finalBalancingInvoices,
        totalCost,
        batchDelta,
      },
      statesExplored,
      executionTimeMs: Date.now() - startTimeMs,
    };
  }

  /**
   * Generates, scores, and filters candidates for a single balancing invoice.
   * Retains up to maxInvoiceCandidates (16).
   */
  private static generateAndScoreInvoiceCandidates(
    invoice: PurchaseInvoice,
    constraints: Map<string, ProductConstraint>,
  ): InvoiceCandidate[] {
    const rawLineCandidatesPerLine =
      CandidateGenerator.generateInvoiceLineCandidates(invoice, constraints);

    // Score and retain top maxLineCandidates (24) per product line
    const scoredLineCandidatesPerLine: LineCandidate[][] =
      rawLineCandidatesPerLine.map((lineInfo) => {
        const constraint = constraints.get(lineInfo.productId);
        if (!constraint) {
          throw new Error(
            `Missing constraint for product ${lineInfo.productId}`,
          );
        }

        const scored = lineInfo.candidates.map((cand) =>
          CandidateScorer.scoreLineCandidate(
            cand,
            lineInfo.originalLine,
            constraint,
          ),
        );

        scored.sort((a, b) => {
          if (a.cost !== b.cost) return a.cost - b.cost;
          const absDeltaA = Math.abs(a.delta);
          const absDeltaB = Math.abs(b.delta);
          if (Math.abs(absDeltaA - absDeltaB) > MONEY_TOLERANCE)
            return absDeltaA - absDeltaB;
          if (Math.abs(a.line.quantity - b.line.quantity) > MONEY_TOLERANCE)
            return a.line.quantity - b.line.quantity;
          return a.line.rate - b.line.rate;
        });

        return scored.slice(0, BALANCE_LIMITS.maxLineCandidates);
      });

    // Combine line candidates to build invoice candidates
    const rawInvoiceCandidates: InvoiceCandidate[] = [];
    this.cartesianCombineLines(
      scoredLineCandidatesPerLine,
      0,
      [],
      invoice,
      rawInvoiceCandidates,
    );

    // Sort invoice candidates deterministically:
    // 1. cost asc
    // 2. absolute delta asc
    // 3. invoiceId asc
    rawInvoiceCandidates.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;
      const absDeltaA = Math.abs(a.delta);
      const absDeltaB = Math.abs(b.delta);
      if (Math.abs(absDeltaA - absDeltaB) > MONEY_TOLERANCE)
        return absDeltaA - absDeltaB;
      return a.invoiceId.localeCompare(b.invoiceId);
    });

    return rawInvoiceCandidates.slice(0, BALANCE_LIMITS.maxInvoiceCandidates);
  }

  /**
   * Helper for cartesian combination of line candidates into invoice candidates.
   */
  private static cartesianCombineLines(
    linesCandidates: LineCandidate[][],
    index: number,
    currentChoice: LineCandidate[],
    originalInvoice: PurchaseInvoice,
    result: InvoiceCandidate[],
  ) {
    if (index === linesCandidates.length) {
      const invoiceCandidate = CandidateScorer.scoreInvoiceCandidate(
        currentChoice,
        originalInvoice,
      );
      result.push(invoiceCandidate);
      return;
    }

    for (const lineCandidate of linesCandidates[index]) {
      currentChoice.push(lineCandidate);
      this.cartesianCombineLines(
        linesCandidates,
        index + 1,
        currentChoice,
        originalInvoice,
        result,
      );
      currentChoice.pop();
    }
  }
}
