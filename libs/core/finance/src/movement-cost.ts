// What a stock movement cost, for the books (TDD_18 §4.2): the value the movement moved in or out of its level, which is the one figure the
// stock and the books share. A row written before the value was recorded has none (`null` or absent), and is valued the way its entry was
// posted: the units times the unit cost it carries. Whole USD cents; a value that does not fit a safe integer is a corrupt row and throws.
export function movementCostCents(
  quantity: number,
  unitCostCents: number,
  valueCents?: bigint | null
): number {
  if (valueCents === null || valueCents === undefined) return quantity * unitCostCents
  const cents = Number(valueCents)
  if (!Number.isSafeInteger(cents)) throw new RangeError('the value of a movement is out of range')
  return cents
}
