import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'

import type { OutboundQueue } from './outbound-queue'
import { ReadReceipts } from './read-receipts.service'

const STORE_ID = 'store-a'
const CONVERSATION_ID = 'conversation-a'
const MESSAGE_ID = 'message-a'

function build(over: {
  settings?: () => Promise<unknown>
  latest?: () => Promise<unknown>
  enqueue?: () => Promise<void>
}) {
  const findSettings = jest.fn(
    over.settings ?? (() => Promise.resolve({ preferences: { sendReadReceipts: true } }))
  )
  const findLatest = jest.fn<Promise<unknown>, [unknown]>(
    over.latest ?? (() => Promise.resolve({ id: MESSAGE_ID }))
  )
  const enqueueReadReceipt = jest.fn(over.enqueue ?? (() => Promise.resolve()))
  const warn = jest.fn()
  const afterCommit = jest.fn((_db: unknown, hook: () => void) => hook())
  const prisma = {
    client: { storeSettings: { findUnique: findSettings }, message: { findFirst: findLatest } },
    afterCommit
  } as unknown as PrismaService // the two reads the class makes
  const outbound = { enqueueReadReceipt } as unknown as OutboundQueue // the one call the class makes
  const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger
  return {
    afterCommit,
    receipts: new ReadReceipts(prisma, outbound, logger),
    findSettings,
    findLatest,
    enqueueReadReceipt,
    warn
  }
}

describe('ReadReceipts.queueFor', () => {
  it('does the reads before it resolves, and with the store it was given', async () => {
    const { receipts, findSettings, findLatest, enqueueReadReceipt } = build({})

    await receipts.queueFor(STORE_ID, CONVERSATION_ID)

    expect(findSettings).toHaveBeenCalledWith(
      expect.objectContaining({ where: { storeId: STORE_ID } })
    )
    expect(findLatest.mock.calls[0]?.[0]).toMatchObject({
      where: { storeId: STORE_ID, conversationId: CONVERSATION_ID }
    })
    expect(enqueueReadReceipt).toHaveBeenCalledWith({
      storeId: STORE_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID
    })
  })

  it('does not wait for the queueing, so a slow Redis does not hold the answer', async () => {
    const { receipts, enqueueReadReceipt } = build({
      enqueue: () => new Promise<void>(() => undefined) // never settles
    })

    await expect(receipts.queueFor(STORE_ID, CONVERSATION_ID)).resolves.toBeUndefined()

    expect(enqueueReadReceipt).toHaveBeenCalledTimes(1)
  })

  it('logs a failed queueing and does not reject', async () => {
    const { receipts, warn } = build({ enqueue: () => Promise.reject(new TypeError('redis down')) })

    await expect(receipts.queueFor(STORE_ID, CONVERSATION_ID)).resolves.toBeUndefined()
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(warn).toHaveBeenCalledWith(
      { conversationId: CONVERSATION_ID, errorName: 'TypeError' },
      'the read receipt could not be queued'
    )
  })

  it('logs a failed read and does not reject, and queues nothing', async () => {
    const { receipts, warn, enqueueReadReceipt } = build({
      latest: () => Promise.reject(new RangeError('read failed'))
    })

    await expect(receipts.queueFor(STORE_ID, CONVERSATION_ID)).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(enqueueReadReceipt).not.toHaveBeenCalled()
  })

  it('queues nothing when the store switched read receipts off', async () => {
    const { receipts, findLatest, enqueueReadReceipt } = build({
      settings: () => Promise.resolve({ preferences: { sendReadReceipts: false } })
    })

    await receipts.queueFor(STORE_ID, CONVERSATION_ID)

    expect(findLatest).not.toHaveBeenCalled()
    expect(enqueueReadReceipt).not.toHaveBeenCalled()
  })

  it('queues nothing when no message of the customer can be marked', async () => {
    const { receipts, enqueueReadReceipt } = build({ latest: () => Promise.resolve(null) })

    await receipts.queueFor(STORE_ID, CONVERSATION_ID)

    expect(enqueueReadReceipt).not.toHaveBeenCalled()
  })

  it('queues only once the transaction has committed', async () => {
    const { receipts, afterCommit, enqueueReadReceipt } = build({})
    afterCommit.mockImplementation(() => undefined) // the commit has not happened

    await receipts.queueFor(STORE_ID, CONVERSATION_ID)

    expect(enqueueReadReceipt).not.toHaveBeenCalled()
    const hook = afterCommit.mock.calls[0]?.[1]
    hook?.()
    expect(enqueueReadReceipt).toHaveBeenCalledTimes(1)
  })
})

describe('ReadReceipts.queueForMany', () => {
  const UP_TO = '2026-11-20 10:00:00.123456'

  function buildMany(over: { enabled?: boolean; rows?: () => Promise<unknown> }) {
    const findSettings = jest.fn(() =>
      Promise.resolve({ preferences: { sendReadReceipts: over.enabled ?? true } })
    )
    const queryRaw = jest.fn(
      over.rows ??
        (() =>
          Promise.resolve([
            { conversation_id: 'c1', id: 'm1' },
            { conversation_id: 'c2', id: 'm2' }
          ]))
    )
    const enqueueReadReceipt = jest.fn(() => Promise.resolve())
    const warn = jest.fn()
    const afterCommit = jest.fn((_db: unknown, hook: () => void) => hook())
    const prisma = {
      client: { storeSettings: { findUnique: findSettings }, $queryRaw: queryRaw },
      afterCommit
    } as unknown as PrismaService // the two reads the batch makes
    const outbound = { enqueueReadReceipt } as unknown as OutboundQueue
    const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger
    return {
      receipts: new ReadReceipts(prisma, outbound, logger),
      findSettings,
      queryRaw,
      enqueueReadReceipt,
      warn
    }
  }

  it('reads once for the whole batch and queues one job per conversation with a message', async () => {
    const { receipts, findSettings, queryRaw, enqueueReadReceipt } = buildMany({})

    await receipts.queueForMany(STORE_ID, ['c1', 'c2', 'c3'], UP_TO)

    expect(findSettings).toHaveBeenCalledTimes(1)
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(enqueueReadReceipt).toHaveBeenCalledTimes(2)
    expect(enqueueReadReceipt).toHaveBeenCalledWith({
      storeId: STORE_ID,
      conversationId: 'c1',
      messageId: 'm1'
    })
  })

  it('does not look for messages when the store switched receipts off', async () => {
    const { receipts, queryRaw, enqueueReadReceipt } = buildMany({ enabled: false })

    await receipts.queueForMany(STORE_ID, ['c1'], UP_TO)

    expect(queryRaw).not.toHaveBeenCalled()
    expect(enqueueReadReceipt).not.toHaveBeenCalled()
  })

  it('does nothing for an empty batch', async () => {
    const { receipts, findSettings } = buildMany({})

    await receipts.queueForMany(STORE_ID, [], UP_TO)

    expect(findSettings).not.toHaveBeenCalled()
  })

  it('makes the same number of calls to the database for 3 conversations as for 30', async () => {
    const callsFor = async (count: number): Promise<number> => {
      const { receipts, findSettings, queryRaw } = buildMany({})
      await receipts.queueForMany(
        STORE_ID,
        Array.from({ length: count }, (_, i) => `c${i}`),
        UP_TO
      )
      return findSettings.mock.calls.length + queryRaw.mock.calls.length
    }

    const small = await callsFor(3)
    const large = await callsFor(30)

    expect(small).toBe(2)
    expect(large).toBe(small)
  })

  it('logs the size of the batch when the lookup fails, and does not reject', async () => {
    const { receipts, warn, enqueueReadReceipt } = buildMany({
      rows: () => Promise.reject(new TypeError('boom'))
    })

    await expect(receipts.queueForMany(STORE_ID, ['c1', 'c2'], UP_TO)).resolves.toBeUndefined()

    expect(enqueueReadReceipt).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      { conversations: 2, errorName: 'TypeError' },
      'the read receipts of a batch could not be queued'
    )
  })
})
