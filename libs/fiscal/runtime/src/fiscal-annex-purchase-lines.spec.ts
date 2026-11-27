import { splitReceiptLines } from './fiscal-annex-purchase-lines'

describe('splitReceiptLines', () => {
  it('splits the money of a receipt by the tax of its lines', () => {
    expect(
      splitReceiptLines(
        [
          { subtotalCents: 5000, taxCents: 650 },
          { subtotalCents: 1000, taxCents: 0 },
          { subtotalCents: 200, taxCents: 26 }
        ],
        { subtotalCents: 6200, taxCents: 676 }
      )
    ).toEqual({ taxedBaseCents: 5200, taxedLines: 2, taxCents: 676, exemptBaseCents: 1000 })
  })

  it('reads a receipt of exempt lines alone, and one of taxed lines alone', () => {
    expect(
      splitReceiptLines([{ subtotalCents: 1000, taxCents: 0 }], {
        subtotalCents: 1000,
        taxCents: 0
      })
    ).toEqual({ taxedBaseCents: 0, taxedLines: 0, taxCents: 0, exemptBaseCents: 1000 })
    expect(
      splitReceiptLines([{ subtotalCents: 100, taxCents: 13 }], {
        subtotalCents: 100,
        taxCents: 13
      })
    ).toEqual({ taxedBaseCents: 100, taxedLines: 1, taxCents: 13, exemptBaseCents: 0 })
  })

  it('does not read a receipt whose taxed lines do not carry the tax of the receipt', () => {
    expect(
      splitReceiptLines([{ subtotalCents: 100, taxCents: 13 }], {
        subtotalCents: 100,
        taxCents: 14
      })
    ).toBeNull()
    expect(
      splitReceiptLines([{ subtotalCents: 100, taxCents: 13 }], {
        subtotalCents: 100,
        taxCents: 12
      })
    ).toBeNull()
  })

  it('does not read a receipt whose lines do not add up to its subtotal', () => {
    expect(
      splitReceiptLines([{ subtotalCents: 100, taxCents: 13 }], {
        subtotalCents: 101,
        taxCents: 13
      })
    ).toBeNull()
    expect(
      splitReceiptLines(
        [
          { subtotalCents: 100, taxCents: 13 },
          { subtotalCents: 50, taxCents: 0 }
        ],
        { subtotalCents: 100, taxCents: 13 }
      )
    ).toBeNull()
  })

  it('does not read a receipt with no lines but money', () => {
    expect(splitReceiptLines([], { subtotalCents: 100, taxCents: 0 })).toBeNull()
    expect(splitReceiptLines([], { subtotalCents: 0, taxCents: 0 })).toEqual({
      taxedBaseCents: 0,
      taxedLines: 0,
      taxCents: 0,
      exemptBaseCents: 0
    })
  })
})
