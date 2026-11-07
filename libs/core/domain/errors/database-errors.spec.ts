import { ApiLockTimeout, isLockTimeoutError } from './database-errors'

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
