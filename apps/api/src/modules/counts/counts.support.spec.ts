import { CountStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { assertCounting, assertTransition, invalidTransition } from './counts.support'

const thrownBy = (action: () => void): PlatformException => {
  try {
    action()
  } catch (error) {
    if (error instanceof PlatformException) return error
  }
  throw new Error('nothing was thrown')
}

describe('assertTransition', () => {
  it('lets a count follow its states and refuses the rest, with the two states in the answer', () => {
    expect(() => assertTransition(CountStatus.DRAFT, CountStatus.COUNTING)).not.toThrow()
    expect(() => assertTransition(CountStatus.COUNTING, CountStatus.REVIEW)).not.toThrow()
    expect(() => assertTransition(CountStatus.REVIEW, CountStatus.APPLIED)).not.toThrow()
    for (const from of [CountStatus.DRAFT, CountStatus.COUNTING, CountStatus.REVIEW]) {
      expect(() => assertTransition(from, CountStatus.CANCELLED)).not.toThrow()
    }

    const refused = thrownBy(() => assertTransition(CountStatus.DRAFT, CountStatus.APPLIED))
    expect(refused.code).toBe(ErrorCodes.INVENTORY_COUNT_INVALID_STATUS_TRANSITION)
    expect(refused.statusCode).toBe(HttpStatusCodes.CONFLICT)
    expect(refused.metadata).toEqual({ from: CountStatus.DRAFT, to: CountStatus.APPLIED })
  })

  it('treats applied and cancelled as the end', () => {
    for (const end of [CountStatus.APPLIED, CountStatus.CANCELLED]) {
      for (const to of Object.values(CountStatus)) {
        expect(() => assertTransition(end, to)).toThrow(PlatformException)
      }
    }
  })
})

describe('invalidTransition', () => {
  it('is a 409 that names where the count is and where it was sent', () => {
    const error = invalidTransition(CountStatus.REVIEW, CountStatus.COUNTING)
    expect(error.statusCode).toBe(HttpStatusCodes.CONFLICT)
    expect(error.metadata).toEqual({ from: CountStatus.REVIEW, to: CountStatus.COUNTING })
  })
})

describe('assertCounting', () => {
  const count = (status: CountStatus) => ({
    id: 'c',
    organizationId: 'o',
    warehouseId: 'w',
    number: 'CT-0001',
    status,
    storeId: null
  })

  it('accepts quantities only while the count is being counted', () => {
    expect(() => assertCounting(count(CountStatus.COUNTING))).not.toThrow()
    for (const status of [
      CountStatus.DRAFT,
      CountStatus.REVIEW,
      CountStatus.APPLIED,
      CountStatus.CANCELLED
    ]) {
      expect(() => assertCounting(count(status))).toThrow(PlatformException)
    }
  })
})
