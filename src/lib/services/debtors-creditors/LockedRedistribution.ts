import { createSeededRandom, hashStringToSeed } from "@/lib/utils/seededRandom";
import { generateRealisticExactSplit } from "@/lib/utils/realisticSeries";

export interface LockedRedistributionItem {
  id: string;
  /** True once the user has pencil-edited this item — its `value` is then
   * authoritative and never recomputed by future calls. */
  locked: boolean;
  /** Authoritative for locked items; ignored (but still a valid, harmless
   * placeholder) for unlocked ones. */
  value: number;
}

export interface LockedRedistributionResult {
  /** Same order/length/ids as the input. */
  values: { id: string; value: number }[];
  feasible: boolean;
  lockedSum: number;
  /** newTotal - lockedSum. Not clamped, so infeasibility is visible to the
   * caller (e.g. to render "locked amounts already exceed the total by ₹X"). */
  unlockedTarget: number;
}

/**
 * Splits `newTotal` across `items`, leaving every locked item's value
 * completely untouched and only ever recomputing the still-unlocked ones —
 * so locking person B at a typed value, then later editing person C, can
 * never move B. This is the mechanic behind the pencil-edit "auto-adjust
 * the rest" behavior for both Debtor and Creditor person-amount editors.
 *
 * Deterministic: without an explicit `rng`, one is derived from a hash of
 * the locked set + values + total, so calling this again with the exact
 * same inputs reproduces the exact same unlocked split — it only changes
 * when the locked set, locked values, or total actually change.
 */
export function redistributeExcludingLocked(
  items: LockedRedistributionItem[],
  newTotal: number,
  options?: {
    rng?: () => number;
    precision?: number;
    variation?: number;
  },
): LockedRedistributionResult {
  const lockedSum = items
    .filter((i) => i.locked)
    .reduce((s, i) => s + i.value, 0);
  const unlockedItems = items.filter((i) => !i.locked);
  const unlockedTarget = newTotal - lockedSum;

  const feasible =
    unlockedItems.length === 0
      ? Math.abs(unlockedTarget) < 0.5
      : unlockedTarget >= -0.5;

  if (!feasible) {
    const values = items.map((i) => ({
      id: i.id,
      value: i.locked ? i.value : 0,
    }));
    return { values, feasible: false, lockedSum, unlockedTarget };
  }

  const rng =
    options?.rng ??
    createSeededRandom(
      hashStringToSeed(
        `${newTotal}|${items
          .map((i) => `${i.id}:${i.locked}:${i.locked ? i.value : ""}`)
          .join(",")}`,
      ),
    );

  const splits = generateRealisticExactSplit(
    Math.max(0, unlockedTarget),
    unlockedItems.length,
    rng,
    { precision: options?.precision, variation: options?.variation },
  );

  let splitIdx = 0;
  const values = items.map((i) => {
    if (i.locked) return { id: i.id, value: i.value };
    return { id: i.id, value: splits[splitIdx++] };
  });

  return { values, feasible: true, lockedSum, unlockedTarget };
}
