import { CountStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import {
  assertActorMayWrite,
  assertCounting,
  assertTransition,
  invalidTransition,
  reachableCount
} from './counts.support'

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

describe('reachableCount', () => {
  it('adds nothing for a person, who reads the counts of the whole organization', () => {
    expect(reachableCount({ storeId: 'store-a' })).toBeUndefined()
  })

  it('limits a plugin to the counts of its store and the ones of the warehouse that have a line of it', () => {
    expect(reachableCount({ storeId: 'store-a', pluginInstallationId: 'inst-1' })).toEqual({
      AND: [
        { OR: [{ storeId: 'store-a' }, { storeId: null, lines: { some: { storeId: 'store-a' } } }] }
      ]
    })
  })
})

describe('assertActorMayWrite', () => {
  const findFirst = jest.fn()
  const tx = { stockCountLine: { findFirst } } as unknown as Parameters<
    typeof assertActorMayWrite
  >[0]
  const person = { storeId: 'store-a' }
  const plugin = { storeId: 'store-a', pluginInstallationId: 'inst-1' }
  beforeEach(() => findFirst.mockReset())

  it('lets a person write any count and a plugin the count limited to its store, without a read', async () => {
    await expect(
      assertActorMayWrite(tx, { id: 'c', storeId: null }, person)
    ).resolves.toBeUndefined()
    await expect(
      assertActorMayWrite(tx, { id: 'c', storeId: 'store-b' }, person)
    ).resolves.toBeUndefined()
    await expect(
      assertActorMayWrite(tx, { id: 'c', storeId: 'store-a' }, plugin)
    ).resolves.toBeUndefined()
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('refuses a plugin (403) a count of the whole warehouse that has a line of its store', async () => {
    findFirst.mockResolvedValue({ id: 'line' })

    const refused = await assertActorMayWrite(tx, { id: 'c', storeId: null }, plugin).catch(
      (error: unknown) => error
    )

    expect(refused).toBeInstanceOf(PlatformException)
    expect((refused as PlatformException).code).toBe(ErrorCodes.INVENTORY_COUNT_STORES_NOT_ALLOWED)
    expect((refused as PlatformException).statusCode).toBe(HttpStatusCodes.FORBIDDEN)
    expect(findFirst).toHaveBeenCalledWith({
      where: { countId: 'c', storeId: 'store-a' },
      select: { id: true }
    })
  })

  it('says a count it cannot read does not exist (404): another store, or a warehouse with no line of its store', async () => {
    findFirst.mockResolvedValue(null)

    for (const storeId of ['store-b', null]) {
      const refused = await assertActorMayWrite(tx, { id: 'c', storeId }, plugin).catch(
        (error: unknown) => error
      )
      expect((refused as PlatformException).statusCode).toBe(HttpStatusCodes.NOT_FOUND)
    }
    // A count limited to another store is never looked up: it is not the key's whatever its lines say
    expect(findFirst).toHaveBeenCalledTimes(1)
  })
})
