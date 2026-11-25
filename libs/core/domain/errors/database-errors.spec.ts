import {
  ApiLockTimeout,
  isLockTimeoutError,
  isRowLevelSecurityError,
  isTransactionConflictError,
  isTransactionWaitError
} from './database-errors'

// The shape Prisma gave for a raw query that hit lock_timeout, captured against a real PostgreSQL
const FROM_PRISMA_RAW = {
  name: 'PrismaClientKnownRequestError',
  code: 'P2010',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '55P03',
        originalMessage: 'canceling statement due to lock timeout',
        kind: 'postgres',
        code: '55P03'
      }
    }
  },
  message: 'Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`'
}

describe('isLockTimeoutError', () => {
  it.each([
    ['what Prisma gives for a raw query', FROM_PRISMA_RAW],
    ['the error of the driver itself', { code: '55P03' }],
    ['an error that wraps the driver error as its cause', { cause: { code: '55P03' } }],
    [
      'a model query: the code only in the cause of the adapter error',
      { code: 'P2034', meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } }
    ]
  ])('knows %s', (_name, error) => {
    expect(isLockTimeoutError(error)).toBe(true)
  })

  it.each([
    [
      'another database error',
      { code: '23505', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }
    ],
    ['a deadlock, which is not a lock timeout', { code: '40P01' }],
    ['an error with a message and nothing else', new Error('boom')],
    ['a string', '55P03'],
    ['nothing', undefined],
    ['null', null],
    [
      'a message that only says the code (text a user typed can say it)',
      { code: 'P2002', message: 'Unique constraint failed on the name "Code: `55P03`"' }
    ]
  ])('does not take %s for one', (_name, error) => {
    expect(isLockTimeoutError(error)).toBe(false)
  })

  it('stops on an error that points back at itself', () => {
    const loop: Record<string, unknown> = { code: 'X' }
    loop['cause'] = loop

    expect(isLockTimeoutError(loop)).toBe(false)
  })
})

describe('ApiLockTimeout', () => {
  it('tells the client to come back after the time the database waits', () => {
    expect(ApiLockTimeout.RETRY_AFTER_SECONDS * 1000).toBe(ApiLockTimeout.MS)
    expect(ApiLockTimeout.SQL).toBe(`${ApiLockTimeout.MS / 1000}s`)
  })
})

describe('isTransactionWaitError', () => {
  it.each([
    [
      'what Prisma gives when no connection came free in time',
      { code: 'P2028', message: 'Unable to start a transaction in the given time.' }
    ],
    ['the same wrapped as the cause of another error', { cause: { code: 'P2028' } }],
    [
      'an expired transaction',
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2028',
        meta: { error: 'Transaction already closed' }
      }
    ]
  ])('knows %s', (_name, error) => {
    expect(isTransactionWaitError(error)).toBe(true)
  })

  it.each([
    ['a lock timeout, which has its own check', { code: '55P03' }],
    ['a unique violation', { code: 'P2002' }],
    [
      'a message that only says the code (text a user typed can say it)',
      { message: 'Unique constraint failed on the name "P2028"' }
    ],
    ['a string', 'P2028'],
    ['nothing', undefined]
  ])('does not take %s for one', (_name, error) => {
    expect(isTransactionWaitError(error)).toBe(false)
  })

  it('stops on an error that points back at itself', () => {
    const loop: Record<string, unknown> = { code: 'X' }
    loop['cause'] = loop

    expect(isTransactionWaitError(loop)).toBe(false)
  })
})

describe('isRowLevelSecurityError', () => {
  it.each([
    ['the error of the driver itself', { code: '42501' }],
    [
      'what Prisma gives for a raw query',
      { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '42501' } } } }
    ],
    ['an error that wraps the driver error as its cause', { cause: { code: '42501' } }],
    [
      'a model query: the code only in the cause of the adapter error',
      { code: 'P2004', meta: { driverAdapterError: { cause: { originalCode: '42501' } } } }
    ]
  ])('knows %s', (_name, error) => {
    expect(isRowLevelSecurityError(error)).toBe(true)
  })

  it.each([
    ['a foreign key failure', { code: 'P2003' }],
    [
      'a foreign key failure of the driver',
      { code: '23503', meta: { driverAdapterError: { cause: { originalCode: '23503' } } } }
    ],
    ['a lock timeout', { code: '55P03' }],
    ['a message that only says it', new Error('new row violates row-level security policy 42501')],
    ['a string', '42501'],
    ['null', null]
  ])('does not take %s for one', (_name, error) => {
    expect(isRowLevelSecurityError(error)).toBe(false)
  })

  it('stops on an error that points back at itself', () => {
    const loop: Record<string, unknown> = { code: 'X' }
    loop['cause'] = loop

    expect(isRowLevelSecurityError(loop)).toBe(false)
  })
})

describe('isTransactionConflictError', () => {
  it.each([
    ['Prisma write conflict', { code: 'P2034' }],
    ['a serialization failure of the driver', { cause: { originalCode: '40001' } }],
    [
      'a deadlock behind Prisma P2010',
      { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }
    ]
  ])('finds %s', (_name, error) => {
    expect(isTransactionConflictError(error)).toBe(true)
  })

  it.each([
    [
      'a lock timeout',
      { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '55P03' } } } }
    ],
    ['a message that only says so', new Error('write conflict or a deadlock')],
    ['nothing', null],
    ['a string', 'P2034']
  ])('does not take %s for one', (_name, error) => {
    expect(isTransactionConflictError(error)).toBe(false)
  })
})
