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
