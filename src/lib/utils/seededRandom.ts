/**
 * Small deterministic PRNG (mulberry32) + string hash (FNV-1a), used to add
 * realistic-looking month-to-month variation to generated figures without
 * making them genuinely unpredictable: the same input file + same margin %
 * always produces the same "randomized" output, so re-generating or
 * re-downloading never silently changes the numbers.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
