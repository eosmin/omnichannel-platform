import { randomUUID } from 'node:crypto'

import { LegalBookField, LegalBookLimits } from '@platform/core/domain'

import {
  bookLayoutBodySchema,
  bookQuerySchema,
  frozenBooksQuerySchema,
  legalBookKindSchema
} from './finance-books.schemas'

const body = {
  columns: [
    { field: LegalBookField.CORRELATIVE, label: null },
    { field: LegalBookField.TOTAL, label: 'Total venta' }
  ],
  sort: 'date',
  correlativeStart: 1,
  correlativeRestart: 'month',
  unissuedSales: 'consumers',
  accountantConfirmed: false
}

describe('the layout of a book', () => {
  it('takes the fields of the catalog and nothing else', () => {
    expect(bookLayoutBodySchema.safeParse(body).success).toBe(true)
    expect(bookLayoutBodySchema.safeParse({ ...body, extra: 1 }).success).toBe(false)
    expect(
      bookLayoutBodySchema.safeParse({
        ...body,
        columns: [{ field: 'customer_name', label: null }]
      }).success
    ).toBe(false)
  })

  it('bounds the columns, the label and the start of the correlative', () => {
    expect(bookLayoutBodySchema.safeParse({ ...body, columns: [] }).success).toBe(false)
    const many = Array.from({ length: LegalBookLimits.MAX_COLUMNS + 1 }, () => ({
      field: LegalBookField.TOTAL,
      label: null
    }))
    expect(bookLayoutBodySchema.safeParse({ ...body, columns: many }).success).toBe(false)
    expect(
      bookLayoutBodySchema.safeParse({
        ...body,
        columns: [{ field: LegalBookField.TOTAL, label: 'a\nb' }]
      }).success
    ).toBe(false)
    expect(bookLayoutBodySchema.safeParse({ ...body, correlativeStart: 0 }).success).toBe(false)
    expect(bookLayoutBodySchema.safeParse({ ...body, correlativeStart: 1.5 }).success).toBe(false)
  })

  it('refuses a sort, a restart and a rule for unissued sales that are not in the lists', () => {
    expect(bookLayoutBodySchema.safeParse({ ...body, sort: 'name' }).success).toBe(false)
    expect(bookLayoutBodySchema.safeParse({ ...body, correlativeRestart: 'day' }).success).toBe(
      false
    )
    expect(bookLayoutBodySchema.safeParse({ ...body, unissuedSales: 'taxpayers' }).success).toBe(
      false
    )
  })
})

describe('reading a book', () => {
  it('asks for a period and may name the version of the layout (0 is the proposal)', () => {
    const periodId = randomUUID()
    expect(bookQuerySchema.safeParse({ periodId }).success).toBe(true)
    expect(bookQuerySchema.safeParse({ periodId, layoutVersion: '0' }).success).toBe(true)
    expect(bookQuerySchema.safeParse({ periodId, layoutVersion: '-1' }).success).toBe(false)
    // An empty value is no value: it must not read as 0, the proposal
    const empty = bookQuerySchema.safeParse({ periodId, layoutVersion: '' })
    expect(empty.success && empty.data.layoutVersion).toBeUndefined()
    expect(bookQuerySchema.safeParse({}).success).toBe(false)
    expect(bookQuerySchema.safeParse({ periodId, storeId: randomUUID() }).success).toBe(false)
  })

  it('knows three kinds of book', () => {
    for (const kind of ['sales_taxpayers', 'sales_consumers', 'purchases']) {
      expect(legalBookKindSchema.safeParse(kind).success).toBe(true)
    }
    expect(legalBookKindSchema.safeParse('journal').success).toBe(false)
  })

  it('lists the frozen books at most a hundred at a time', () => {
    expect(frozenBooksQuerySchema.safeParse({ limit: '100' }).success).toBe(true)
    expect(frozenBooksQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
  })
})
