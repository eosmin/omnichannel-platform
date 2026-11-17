// Exact arithmetic for the figures of a document. Money is held in cents (integers); the figures of an item go to eight decimals and
// those of the summary to two (Funcional §XXI), so the rounding is done here, in integers, and never with a float. Half rounds up.

export const SCALE_8 = 100_000_000n

// Round(n / d) with halves up, for a non-negative n and a positive d
export function roundDiv(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n)
    throw new RangeError('roundDiv takes a non-negative numerator and a positive divisor')
  return (2n * n + d) / (2n * d)
}

// A figure of cents as the number of dollars the JSON holds: the nearest double of the decimal, which prints with two decimals
export const dollars = (cents: number): number => cents / 100

// A figure scaled by 10^8 as dollars: the nearest double of the decimal, which prints with at most eight decimals
export const dollars8 = (scaled: bigint): number => Number(scaled) / 1e8

// Cents as the figure scaled by 10^8
export const toScaled8 = (cents: number): bigint => BigInt(cents) * 1_000_000n

// Splits `total` among the weights by the largest remainder: every part is an integer, they add up to `total`, and the same input always
// gives the same split (the ties go to the first). A split of something among nothing is refused.
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0)
    throw new RangeError('only a non-negative integer is split')
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  if (total === 0) return weights.map(() => 0)
  if (sum <= 0) throw new RangeError('nothing to split among')
  const exact = weights.map(weight => (BigInt(total) * BigInt(weight)) / BigInt(sum))
  const parts = exact.map(Number)
  const left = total - parts.reduce((acc, part) => acc + part, 0)
  const order = weights
    .map((weight, index) => ({
      index,
      remainder: (BigInt(total) * BigInt(weight)) % BigInt(sum)
    }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
    )
  for (let step = 0; step < left; step += 1)
    parts[order[step]?.index ?? 0] = (parts[order[step]?.index ?? 0] ?? 0) + 1
  return parts
}
