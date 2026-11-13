import { MoneyError, assertSafeInteger, type Paise } from "./money";

/**
 * Split a total across weighted lines without losing or inventing a paise.
 *
 * Used for: distributing a document-level discount, splitting one payment
 * across several bills, and per-invoice tax rounding attribution.
 *
 * Largest-remainder method, computed with BigInt so large totals cannot drift.
 * Invariants: result.length === weights.length, every result >= 0,
 * sum(result) === total, and order is stable for equal remainders.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  assertSafeInteger(total, "total");
  if (total < 0) {
    throw new MoneyError("allocate() expects a non-negative total; split negative amounts by allocating the absolute value and negating each part");
  }
  if (weights.length === 0) {
    if (total !== 0) {
      throw new MoneyError("cannot allocate a non-zero total across zero weights");
    }
    return [];
  }
  for (const weight of weights) {
    assertSafeInteger(weight, "weight");
    if (weight < 0) {
      throw new MoneyError("allocate() weights cannot be negative");
    }
  }

  const totalBig = BigInt(total);
  const weightBig = weights.map((weight) => BigInt(weight));
  const sumWeight = weightBig.reduce((acc, weight) => acc + weight, 0n);

  if (sumWeight === 0n) {
    if (total === 0) {
      return weights.map(() => 0 as Paise);
    }
    throw new MoneyError("cannot allocate a non-zero total across zero weights");
  }

  const shares: Paise[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0;

  for (let index = 0; index < weights.length; index += 1) {
    const numerator = totalBig * (weightBig[index] as bigint);
    const share = numerator / sumWeight;
    const remainder = numerator % sumWeight;
    shares.push(Number(share) as Paise);
    distributed += Number(share);
    remainders.push({ index, remainder });
  }

  let leftover = total - distributed;
  // Highest remainder first; ties resolved by original order for determinism.
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (let cursor = 0; leftover > 0; cursor += 1) {
    const target = remainders[cursor % remainders.length];
    if (!target) break;
    shares[target.index] = ((shares[target.index] as number) + 1) as Paise;
    leftover -= 1;
  }

  return shares;
}
