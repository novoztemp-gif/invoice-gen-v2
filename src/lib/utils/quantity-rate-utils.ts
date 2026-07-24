/**
 * Utility functions for standardizing quantity (.00, .25, .50, .75 increments)
 * and rate (whole integer) generation & validation.
 */

/**
 * Rounds a quantity to the nearest 0.25 increment (.00, .25, .50, .75).
 */
export function roundToQuarterIncrement(qty: number): number {
  if (isNaN(qty)) return 0;
  return Math.round(qty * 4) / 4;
}

/**
 * Validates whether a quantity is in valid 0.25 increments (.00, .25, .50, .75).
 */
export function isValidQuarterIncrement(qty: number): boolean {
  if (isNaN(qty) || qty <= 0) return false;
  const remainder = Math.abs((qty * 100) % 25);
  return remainder < 0.001 || remainder > 24.999;
}

/**
 * Rounds a rate value to the nearest whole integer.
 */
export function roundToWholeInteger(rate: number): number {
  if (isNaN(rate)) return 0;
  return Math.round(rate);
}

/**
 * Validates whether a rate is a whole number (integer).
 */
export function isValidWholeNumber(rate: number): boolean {
  if (isNaN(rate) || rate <= 0) return false;
  return Math.abs(rate - Math.round(rate)) < 0.001;
}

/**
 * Computes line item amount (quantity * rate) rounded to 2 decimal places.
 */
export function computeLineAmount(qty: number, rate: number): number {
  return Math.round(qty * rate * 100) / 100;
}

/**
 * Standard commercial quantity steps used for realistic commercial invoice generation.
 */
const COMMERCIAL_QUANTITY_STEPS = [
  5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 100, 125,
  150, 200, 250, 300, 400, 500, 750, 1000,
];

export interface CommercialQuantityOptions {
  productName?: string;
  existingQuantities?: Set<number>;
  integerRatio?: number; // Default: 0.75 (75% integers, 25% decimals)
}

/**
 * Generates a realistic commercial quantity within [minQty, maxQty].
 * - Product-aware step selection
 * - 70–80% whole integer quantities, 20–30% quarter-decimals (.00, .25, .50, .75)
 * - Prevents duplicate line-item quantities within a single invoice
 * - Strictly respects minQty <= quantity <= maxQty
 */
export function generateCommercialQuantity(
  minQty: number,
  maxQty: number,
  options: CommercialQuantityOptions = {},
): number {
  const low = Math.max(0, Math.min(minQty, maxQty));
  const high = Math.max(low, maxQty);

  if (low === high) {
    return roundToQuarterIncrement(low);
  }

  const {
    productName = "",
    existingQuantities = new Set<number>(),
    integerRatio = 0.75,
  } = options;

  // Decide if this specific line item will be a whole integer (75% probability) or quarter-decimal (25%)
  const forceInteger = Math.random() < integerRatio;

  // Product-aware step filtering: smaller/lighter products like Clam prefer smaller steps
  const isSmallUnitProduct = /CLAM|SHRIMP|SPICE|SAFFRON|HERB/i.test(
    productName,
  );
  let relevantSteps = COMMERCIAL_QUANTITY_STEPS;
  if (isSmallUnitProduct && high <= 50) {
    relevantSteps = [5, 6, 8, 10, 12, 15, 20];
  }

  const integerCandidates: number[] = [];
  const decimalCandidates: number[] = [];

  for (const step of relevantSteps) {
    if (step >= low && step <= high) {
      integerCandidates.push(step);
      decimalCandidates.push(step + 0.25, step + 0.5, step + 0.75);
    }
  }

  // Include low boundary ONLY if high < 5 (e.g. maxQty = 4)
  if (high < 5 && low > 0) {
    const lowRounded = roundToQuarterIncrement(low);
    if (lowRounded === Math.floor(lowRounded)) {
      integerCandidates.push(lowRounded);
    } else {
      decimalCandidates.push(lowRounded);
    }
    if (low + 0.25 <= high)
      decimalCandidates.push(roundToQuarterIncrement(low + 0.25));
    if (low + 0.5 <= high)
      decimalCandidates.push(roundToQuarterIncrement(low + 0.5));
    if (low + 0.75 <= high)
      decimalCandidates.push(roundToQuarterIncrement(low + 0.75));
  }

  // Filter candidate pool according to integer preference and remove duplicates
  let pool = forceInteger ? integerCandidates : decimalCandidates;
  if (pool.length === 0) {
    pool = [...integerCandidates, ...decimalCandidates];
  }

  // Exclude duplicate quantities present in current invoice
  const nonDuplicatePool = pool.filter(
    (q) => q >= low && q <= high && !existingQuantities.has(q),
  );

  let chosen: number;
  if (nonDuplicatePool.length > 0) {
    chosen =
      nonDuplicatePool[Math.floor(Math.random() * nonDuplicatePool.length)];
  } else if (pool.length > 0) {
    chosen = pool[Math.floor(Math.random() * pool.length)];
  } else {
    chosen = low + Math.random() * (high - low);
  }

  chosen = roundToQuarterIncrement(Math.max(low, Math.min(high, chosen)));

  // If chosen is duplicate, attempt a small non-duplicate offset (+1 or +0.50) within bounds
  if (existingQuantities.has(chosen) && high - low >= 1) {
    const offsetCandidates = [
      chosen + 1,
      chosen - 1,
      chosen + 0.5,
      chosen - 0.5,
      chosen + 0.25,
      chosen - 0.25,
    ];
    for (const alt of offsetCandidates) {
      const altRounded = roundToQuarterIncrement(alt);
      if (
        altRounded >= low &&
        altRounded <= high &&
        !existingQuantities.has(altRounded)
      ) {
        chosen = altRounded;
        break;
      }
    }
  }

  return chosen;
}
