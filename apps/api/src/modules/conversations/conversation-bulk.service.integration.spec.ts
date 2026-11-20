import { Permissions } from '@platform/core/auth'
import { BulkActions, PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import type { ConversationsService, Viewer } from '@platform/core/messaging'

import type { Actor } from '../tenancy'

import { ConversationBulkService } from './conversation-bulk.service'

const viewer = { userId: 'user-1', held: [Permissions.CONVERSATIONS_RESOLVE] } as unknown as Viewer
const actor = { userId: 'user-1' } as unknown as Actor

const closed = Object.assign(new Error('transaction closed'), { code: 'P2028' })

const queueForMany = jest.fn()
const notifyMany = jest.fn()
const BEGAN = new Date('2026-11-20T10:00:00Z')

beforeEach(() => {
  queueForMany.mockReset()
  notifyMany.mockReset()
})

function build(markRead: jest.Mock, hasContext: boolean): ConversationBulkService {
  const logger = { setContext: jest.fn(), error: jest.fn() }
  return new ConversationBulkService(
    { markRead } as unknown as ConversationsService,
    {} as never,
    {} as never,
    { queueForMany } as never,
    { notifyMany } as never,
    {} as never,
    { log: jest.fn() } as never,
    logger as never,
    {
      hasTenantContext: () => hasContext,
      client: { $queryRaw: () => Promise.resolve([{ now: BEGAN }]) }
    } as never
  )
}

const run = (service: ConversationBulkService) =>
  service.run(
    'store-1',
    { action: BulkActions.MARK_READ, conversationIds: ['a', 'b', 'c'] },
    viewer,
    actor
  )

// An .integration spec because the service reaches the env module through its imports (the unit job has no environment)
// With no transaction open (RLS_CONTEXT off) the savepoint has nothing to protect: each change runs as it did, and the answer keeps
// its contract, one entry per conversation, even when one of them fails because its own transaction closed
describe('ConversationBulkService without an open transaction', () => {
  it('tells which conversations changed and which did not, and keeps going after a failure', async () => {
    const markRead = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({})

    const result = await run(build(markRead, false))

    expect(result.succeeded).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ id: 'b', code: ErrorCodes.INTERNAL_ERROR }])
    expect(markRead).toHaveBeenCalledTimes(3)
    // The receipts are asked once, for the ones that went through, with the clock of the start of the batch
    expect(queueForMany).toHaveBeenCalledTimes(1)
    expect(queueForMany).toHaveBeenCalledWith('store-1', ['a', 'c'], BEGAN)
    expect(notifyMany).toHaveBeenCalledWith('store-1', ['a', 'c'], BEGAN)
  })

  it('tells no customer when a plugin reads', async () => {
    const markRead = jest.fn().mockResolvedValue({})
    const service = build(markRead, false)

    await service.run(
      'store-1',
      { action: BulkActions.MARK_READ, conversationIds: ['a'] },
      { ...viewer, userId: `${PLUGIN_ACTOR_PREFIX}x` },
      actor
    )

    expect(queueForMany).not.toHaveBeenCalled()
    expect(notifyMany).not.toHaveBeenCalled()
  })

  it('does not stop the others when the transaction of one item closed', async () => {
    const markRead = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(closed)
      .mockResolvedValueOnce({})

    const result = await run(build(markRead, false))

    expect(result.succeeded).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ id: 'b', code: ErrorCodes.INTERNAL_ERROR }])
  })
})

describe('ConversationBulkService inside the transaction of the request', () => {
  // Three shapes of "the transaction is no longer usable": closed (Prisma), aborted (Postgres, direct) and aborted (inside a raw query error)
  it.each([
    ['closed', { code: 'P2028' }],
    ['aborted', { code: '25P02' }],
    ['aborted in a raw query error', { code: 'P2010', meta: { code: '25P02' } }]
  ])('fails the request, and stops, when the transaction is %s', async (_name, broken) => {
    const markRead = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(broken)

    await expect(run(build(markRead, true))).rejects.toBe(broken)
    expect(markRead).toHaveBeenCalledTimes(2)
  })

  it('keeps going after an ordinary failure of one item', async () => {
    const markRead = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({})

    const result = await run(build(markRead, true))

    expect(result.succeeded).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ id: 'b', code: ErrorCodes.INTERNAL_ERROR }])
    expect(markRead).toHaveBeenCalledTimes(3)
  })
})
