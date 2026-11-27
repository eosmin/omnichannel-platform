// What the lines of a receipt say of its money, split by tax, for the annex of purchases. The lines are what the ledger posted, so they add up
// to the receipt: a receipt whose lines do not (the tax of the taxed lines is not the tax of the receipt, or the bases are not its subtotal) is
// not read, never adjusted. Pure: whole cents in, whole cents out.
export interface ReceiptMoneyLine {
  readonly subtotalCents: number
  readonly taxCents: number
}

export interface SplitReceipt {
  readonly taxedBaseCents: number
  readonly taxedLines: number
  readonly taxCents: number
  readonly exemptBaseCents: number
}

export function splitReceiptLines(
  lines: readonly ReceiptMoneyLine[],
  receipt: ReceiptMoneyLine
): SplitReceipt | null {
  const taxed = lines.filter(line => line.taxCents > 0)
  const exempt = lines.filter(line => line.taxCents === 0)
  const base = (items: readonly ReceiptMoneyLine[]): number =>
    items.reduce((total, item) => total + item.subtotalCents, 0)
  const taxCents = taxed.reduce((total, item) => total + item.taxCents, 0)
  const taxedBaseCents = base(taxed)
  const exemptBaseCents = base(exempt)
  if (taxCents !== receipt.taxCents || taxedBaseCents + exemptBaseCents !== receipt.subtotalCents) {
    return null
  }
  return { taxedBaseCents, taxedLines: taxed.length, taxCents, exemptBaseCents }
}
