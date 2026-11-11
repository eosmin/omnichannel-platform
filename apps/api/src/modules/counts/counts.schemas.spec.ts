import { randomUUID } from 'node:crypto'

import { CountLimits, PaginationLimits } from '@platform/core/domain'

import {
  countLinesQuerySchema,
  createCountSchema,
  listCountsQuerySchema,
  updateCountLinesSchema
} from './counts.schemas'

const id = () => randomUUID()

describe('createCountSchema', () => {
  it('takes a warehouse, and optionally a store and a note', () => {
    expect(createCountSchema.safeParse({ warehouseId: id() }).success).toBe(true)
    expect(
      createCountSchema.safeParse({ warehouseId: id(), storeId: id(), note: 'aisle 3' }).success
    ).toBe(true)
  })

  it('refuses a missing or malformed warehouse, an unknown field, and a note that is too long or has a line break', () => {
    expect(createCountSchema.safeParse({}).success).toBe(false)
    expect(createCountSchema.safeParse({ warehouseId: 'nope' }).success).toBe(false)
    expect(createCountSchema.safeParse({ warehouseId: id(), organizationId: id() }).success).toBe(
      false
    )
    expect(
      createCountSchema.safeParse({
        warehouseId: id(),
        note: 'x'.repeat(CountLimits.NOTE_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    expect(createCountSchema.safeParse({ warehouseId: id(), note: 'a\nb' }).success).toBe(false)
  })
})

describe('updateCountLinesSchema', () => {
  const line = (countedQuantity: number | null) => ({ lineId: id(), countedQuantity })

  it('takes counted quantities, zero included, and null to take a quantity back', () => {
    expect(
      updateCountLinesSchema.safeParse({ lines: [line(0), line(5), line(null)] }).success
    ).toBe(true)
  })

  it('refuses an empty list, too many lines, a line named twice, and quantities that are negative, fractional or too big', () => {
    expect(updateCountLinesSchema.safeParse({ lines: [] }).success).toBe(false)
    const many = Array.from({ length: CountLimits.MAX_LINES_PER_UPDATE + 1 }, () => line(1))
    expect(updateCountLinesSchema.safeParse({ lines: many }).success).toBe(false)
    const repeated = line(1)
    expect(updateCountLinesSchema.safeParse({ lines: [repeated, repeated] }).success).toBe(false)
    expect(updateCountLinesSchema.safeParse({ lines: [line(-1)] }).success).toBe(false)
    expect(updateCountLinesSchema.safeParse({ lines: [line(1.5)] }).success).toBe(false)
    expect(
      updateCountLinesSchema.safeParse({ lines: [line(CountLimits.MAX_COUNTED_QUANTITY + 1)] })
        .success
    ).toBe(false)
    expect(
      updateCountLinesSchema.safeParse({ lines: [{ ...line(1), storeId: id() }] }).success
    ).toBe(false)
  })
})

describe('the queries', () => {
  it('give the default page size, and refuse a size or a filter outside the lists', () => {
    expect(listCountsQuerySchema.parse({}).limit).toBe(PaginationLimits.DEFAULT)
    expect(countLinesQuerySchema.parse({}).limit).toBe(PaginationLimits.DEFAULT)
    expect(listCountsQuerySchema.safeParse({ limit: PaginationLimits.MAX + 1 }).success).toBe(false)
    expect(listCountsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false)
    expect(countLinesQuerySchema.safeParse({ filter: 'variance' }).success).toBe(true)
    expect(countLinesQuerySchema.safeParse({ filter: 'all' }).success).toBe(false)
    expect(countLinesQuerySchema.safeParse({ storeId: id() }).success).toBe(false)
  })
})
