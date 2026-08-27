import { CandidateGenerator } from "./CandidateGenerator";
import { CandidateScorer } from "./CandidateScorer";
import { ResidualRepair } from "./ResidualRepair";
import {
  BALANCE_LIMITS,
  InvoiceCandidate,
  LineCandidate,
  MONEY_TOLERANCE,
  normaliseCategory,
  ProductConstraint,
  PurchaseInvoice,
  PurchaseLine,
  roundMoney,
  SolverResult,
} from "./types";

// Internal DP transition state: `chain` links back to the parent state
// instead of eagerly cloning a full chosenCandidates Map on every single
// (state x candidate) transition. That clone — `new Map(state.chosenCandidates)`
// — used to run up to (dpMap.size * candidatesPerInvoice) times per balancing
// invoice, and its cost grows with how many invoices have been folded in so
// far, making the whole DP loop scale quadratically with invoice count. The
// real Map is now built only once, for the single winning state at the end.
type DPChainNode = {
  invoiceId: string;
  candidate: InvoiceCandidate;
  parent: DPChainNode | null;
};

type DPTransitionState = {
  totalCost: number;
  chain: DPChainNode | null;
};

function buildChosenCandidatesMap(
  chain: DPChainNode | null,
): Map<string, InvoiceCandidate> {
  const map = new Map<string, InvoiceCandidate>();
  for (let node = chain; node; node = node.parent) {
    map.set(node.invoiceId, node.candidate);
  }
  return map;
}

export class CandidateSolver {
  // Bounds the invoice-level DP's width after every fold — see the pruning
  // comment at its call site for why this is needed regardless of batch size.
  private static readonly DP_BEAM_WIDTH = 5_000;

  /**
   * Solves a purchase batch balance plan deterministically within frozen limits.
   */
  public static solveBatchBalance(
    editedInvoice: PurchaseInvoice,
    allBatchInvoices: PurchaseInvoice[],
    batchTotal: number,
    constraints: Map<string, ProductConstraint>,
    majorCustomerIds: Set<string> = new Set(),
    supplierCategory?: string,
    // Hotfix — defense in depth (see CandidateGenerator's matching
    // comment): threaded through so the candidate search itself avoids
    // pushing a balancing invoice over the batch's own configured max,
    // instead of relying solely on FinalValidator's final, after-the-fact
    // rejection. Optional — omitting it (every pre-existing caller/test)
    // is byte-identical to before.
    thresholdMax?: number,
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

    const normalisedSupplierCategory = supplierCategory
      ? normaliseCategory(supplierCategory)
      : undefined;

    const balancingInvoices = sortedInvoices.filter((inv) => {
      if (inv.id === editedInvoice.id) return false;
      const partyId = (inv.products?.[0] as any)?.customer_id;
      if (partyId && majorCustomerIds.has(partyId)) return false;
      // Invoices whose products don't actually match the supplier's
      // category are pre-existing bad data (e.g. a MEAT product sitting in
      // a FRUITS-only batch) — excluding them here means the search never
      // wastes time building a plan around an invoice final validation
      // will always reject, and never fails a save just because it tried.
      if (normalisedSupplierCategory) {
        for (const line of inv.products || []) {
          const constraint = constraints.get(line.product_id);
          if (
            constraint &&
            normaliseCategory(constraint.category) !== normalisedSupplierCategory
          ) {
            return false;
          }
        }
      }
      return true;
    });

    // Calculate required adjustment. This must be based on ALL other
    // invoices in the batch (everything except the one being edited), not
    // just the filtered/touchable balancingInvoices — major-customer and
    // category-mismatched invoices are excluded from being *touched*, but
    // their existing totals still count toward the batch total, so leaving
    // them out here would make the computed gap wrong by exactly their sum.
    const allOtherInvoicesTotal = roundMoney(
      sortedInvoices.reduce(
        (sum, inv) =>
          inv.id === editedInvoice.id ? sum : sum + Number(inv.total_amount),
        0,
      ),
    );
    const targetOtherTotal = roundMoney(
      batchTotal - editedInvoice.total_amount,
    );
    const targetAdjustmentNeeded = roundMoney(
      targetOtherTotal - allOtherInvoicesTotal,
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

    // 3 & 4. Generate candidates and run the DP fold together, one invoice
    // at a time, instead of generating candidates for the entire batch up
    // front. A batch can have thousands of invoices, but closing a rupee
    // delta almost never needs more than a handful of them — so as soon as
    // the running DP map contains an exact match for the target adjustment,
    // we stop. This bounds typical-case cost to "however many invoices it
    // actually took to find a solution," not the size of the whole batch.
    // Candidates are still cached per invoice (candidatesPerInvoice) so
    // ResidualRepair, which only ever looks at the last few invoices, can
    // reuse them without regenerating.
    console.log(
      `[CandidateSolver] balancingInvoices=${balancingInvoices.length}, editedInvoiceLines=${editedInvoice.products?.length || 0}, targetAdjustmentNeeded=${targetAdjustmentNeeded}`,
    );
    const candidatesPerInvoice = new Map<string, InvoiceCandidate[]>();

    let dpMap = new Map<number, DPTransitionState>();
    dpMap.set(0, { totalCost: 0, chain: null });

    let dpInvoiceIndex = 0;
    let foundExactMatchEarly = false;
    for (const inv of balancingInvoices) {
      dpInvoiceIndex++;
      const elapsedMs = Date.now() - startTimeMs;
      if (elapsedMs > BALANCE_LIMITS.plannerTimeMs) {
        console.log(
          `[CandidateSolver] TIMEOUT at ${elapsedMs}ms, invoice ${dpInvoiceIndex}/${balancingInvoices.length}, dpMap.size=${dpMap.size}`,
        );
        return {
          outcome: "search_capacity_exceeded",
          reason: `Planner time budget exceeded (${BALANCE_LIMITS.plannerTimeMs}ms)`,
          statesExplored,
          executionTimeMs: elapsedMs,
        };
      }

      const invCandidates = this.generateAndScoreInvoiceCandidates(
        inv,
        constraints,
        thresholdMax,
      );
      candidatesPerInvoice.set(inv.id, invCandidates);

      const nextDpMap = new Map<number, DPTransitionState>();

      for (const [currentDelta, state] of dpMap.entries()) {
        for (const candidate of invCandidates) {
          const newDelta = roundMoney(currentDelta + candidate.delta);
          const newCost = state.totalCost + candidate.cost;

          const existingState = nextDpMap.get(newDelta);
          if (!existingState || newCost < existingState.totalCost) {
            nextDpMap.set(newDelta, {
              totalCost: newCost,
              chain: { invoiceId: inv.id, candidate, parent: state.chain },
            });
          }
        }
      }

      dpMap = nextDpMap;

      // The number of reachable delta buckets grows combinatorially with
      // each invoice folded in (up to candidatesPerInvoice^invoiceIndex,
      // deduped only by exact rounded delta) — with a rich candidate space
      // this can blow past any fixed cap within the first handful of
      // invoices, long before a batch with thousands of invoices has had a
      // chance to find a match. Prune to a bounded beam after every fold,
      // same philosophy as the per-invoice candidate beam search: keep the
      // states closest to the still-needed adjustment (ties broken by
      // lowest cost) so the search keeps converging toward an exact match
      // instead of exploring the whole reachable delta space.
      if (dpMap.size > CandidateSolver.DP_BEAM_WIDTH) {
        const entries = Array.from(dpMap.entries());
        entries.sort((a, b) => {
          const distA = Math.abs(a[0] - targetAdjustmentNeeded);
          const distB = Math.abs(b[0] - targetAdjustmentNeeded);
          if (distA !== distB) return distA - distB;
          return a[1].totalCost - b[1].totalCost;
        });
        dpMap = new Map(entries.slice(0, CandidateSolver.DP_BEAM_WIDTH));
      }
      statesExplored += dpMap.size;

      if (dpInvoiceIndex % 50 === 0 || dpInvoiceIndex === balancingInvoices.length) {
        console.log(
          `[CandidateSolver] DP invoice ${dpInvoiceIndex}/${balancingInvoices.length}: dpMap.size=${dpMap.size}, elapsed=${Date.now() - startTimeMs}ms`,
        );
      }

      if (dpMap.size > BALANCE_LIMITS.maxSolverStates) {
        return {
          outcome: "search_capacity_exceeded",
          reason: `Maximum dynamic programming states exceeded (${dpMap.size} > ${BALANCE_LIMITS.maxSolverStates})`,
          statesExplored,
          executionTimeMs: Date.now() - startTimeMs,
        };
      }

      for (const delta of dpMap.keys()) {
        if (Math.abs(delta - targetAdjustmentNeeded) <= MONEY_TOLERANCE) {
          foundExactMatchEarly = true;
          break;
        }
      }
      if (foundExactMatchEarly) {
        console.log(
          `[CandidateSolver] exact match found early at invoice ${dpInvoiceIndex}/${balancingInvoices.length}, elapsed=${Date.now() - startTimeMs}ms`,
        );
        break;
      }
    }

    // Check exact match in DP Map
    let exactState: DPTransitionState | undefined;

    for (const [delta, state] of dpMap.entries()) {
      if (Math.abs(delta - targetAdjustmentNeeded) <= MONEY_TOLERANCE) {
        if (!exactState || state.totalCost < exactState.totalCost) {
          exactState = state;
        }
      }
    }

    let chosenCandidates: Map<string, InvoiceCandidate> | undefined =
      exactState ? buildChosenCandidatesMap(exactState.chain) : undefined;

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
        exactState = { totalCost: repairResult.totalCost, chain: null };
        chosenCandidates = repairResult.chosenCandidates;
        statesExplored += repairResult.combinationsExplored;
      }
    }

    if (!exactState || !chosenCandidates) {
      return {
        outcome: "no_valid_solution",
        reason: "No valid rebalance plan exists within business rules.",
        statesExplored,
        executionTimeMs: Date.now() - startTimeMs,
      };
    }

    // 6. Build final solution plan. Only report invoices that were actually
    // changed (chosenCandidate.cost > 0 — scoreInvoiceCandidate only ever
    // returns cost 0 when no line differs from the original). With batches
    // of thousands of invoices, returning the whole batch as
    // "balancingInvoices" — mostly unchanged pass-throughs — would force
    // every downstream consumer (DB persistence, impact summary) to
    // process and rewrite thousands of untouched rows on every single edit.
    // Start from the full baseline (every other invoice at its original
    // total, including ones excluded from touching) and only apply deltas
    // for invoices actually changed — mirrors targetAdjustmentNeeded above,
    // which is computed the same way for the same reason.
    let calculatedOtherTotal = allOtherInvoicesTotal;
    const finalBalancingInvoices: PurchaseInvoice[] = [];
    for (const origInv of balancingInvoices) {
      const chosenCandidate = chosenCandidates?.get(origInv.id);
      if (!chosenCandidate || chosenCandidate.cost === 0) {
        continue;
      }
      calculatedOtherTotal = roundMoney(
        calculatedOtherTotal - origInv.total_amount + chosenCandidate.totalAmount,
      );
      finalBalancingInvoices.push({
        ...origInv,
        products: chosenCandidate.products.map((p) => ({ ...p })),
        total_amount: chosenCandidate.totalAmount,
      });
    }

    const totalCost = scoredEditedInvoice.cost + (exactState.totalCost || 0);

    const calculatedBatchTotal = roundMoney(
      editedInvoice.total_amount + calculatedOtherTotal,
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
    thresholdMax?: number,
  ): InvoiceCandidate[] {
    const rawLineCandidatesPerLine =
      CandidateGenerator.generateInvoiceLineCandidates(
        invoice,
        constraints,
        thresholdMax,
      );

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

    // Combine line candidates to build invoice candidates via bounded beam
    // search (NOT a full cartesian product — with up to maxLineCandidates
    // per line and maxInvoiceLines lines, an exhaustive cartesian product
    // can reach billions of combinations and exhaust process memory).
    const rawInvoiceCandidates = this.combineLinesWithBeamSearch(
      scoredLineCandidatesPerLine,
      invoice,
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
   * Combines per-line candidates into invoice candidates using bounded beam
   * search instead of a full cartesian product. At each line, only the
   * BEAM_WIDTH lowest-cumulative-cost partial combinations are kept before
   * folding in the next line's candidates — this bounds memory to
   * O(lines * BEAM_WIDTH * candidatesPerLine) regardless of how many lines
   * or candidates-per-line exist, instead of growing exponentially.
   * Only the top maxInvoiceCandidates (16) ever survive past this method
   * (see the final .slice below), so a wide beam buys diversity nothing
   * downstream uses — kept small to bound cost across many balancing
   * invoices in one batch.
   */
  private static readonly BEAM_WIDTH = 48;

  private static combineLinesWithBeamSearch(
    linesCandidates: LineCandidate[][],
    originalInvoice: PurchaseInvoice,
  ): InvoiceCandidate[] {
    if (linesCandidates.length === 0) return [];

    // Each beam entry links to its parent instead of copying the whole
    // choice array on every push — spreading `[...state.choice, option]`
    // here costs O(lineIndex) per candidate, which made this step scale
    // quadratically with the number of lines and, multiplied across every
    // balancing invoice in a batch, was enough to blow the 2s planner
    // budget on batches with many invoices. Full arrays are reconstructed
    // only once, for the final surviving beam.
    type BeamNode = {
      option: LineCandidate;
      parent: BeamNode | null;
      cumulativeCost: number;
    };

    const root: BeamNode = { option: null as any, parent: null, cumulativeCost: 0 };
    let beam: BeamNode[] = [root];

    for (const lineOptions of linesCandidates) {
      const next: BeamNode[] = [];
      for (const state of beam) {
        for (const option of lineOptions) {
          next.push({
            option,
            parent: state,
            cumulativeCost: state.cumulativeCost + option.cost,
          });
        }
      }
      next.sort((a, b) => a.cumulativeCost - b.cumulativeCost);
      beam = next.slice(0, this.BEAM_WIDTH);
    }

    return beam.map((leaf) => {
      const choice: LineCandidate[] = [];
      for (let node: BeamNode | null = leaf; node && node.option; node = node.parent) {
        choice.push(node.option);
      }
      choice.reverse();
      return CandidateScorer.scoreInvoiceCandidate(choice, originalInvoice);
    });
  }
}
