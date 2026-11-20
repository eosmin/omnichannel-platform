import { BulkActions } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import type { ConversationsService, Viewer } from '@platform/core/messaging'

import type { Actor } from '../tenancy'

import { ConversationBulkService } from './conversation-bulk.service'

const viewer = { userId: 'user-1', held: new Set<string>() } as unknown as Viewer
const actor = { userId: 'user-1' } as unknown as Actor

// With no transaction open (RLS_CONTEXT off) the savepoint has nothing to protect: each change runs as it did, and the answer keeps
// its contract, one entry per conversation
describe('ConversationBulkService without an open transaction', () => {
  it('tells which conversations changed and which did not, and keeps going after a failure', async () => {
    const markRead = jest
      .fn<Promise<unknown>, [string, string, Viewer]>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({})
    const logger = { setContext: jest.fn(), error: jest.fn() }
    const service = new ConversationBulkService(
      { markRead } as unknown as ConversationsService,
      {} as never,
      {} as never,
      { queueFor: jest.fn() } as never,
      { notify: jest.fn() } as never,
      {} as never,
      { log: jest.fn() } as never,
      logger as never
    )

    const result = await service.run(
      'store-1',
      { action: BulkActions.MARK_READ, conversationIds: ['a', 'b', 'c'] },
      viewer,
      actor
    )

    expect(result.succeeded).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ id: 'b', code: ErrorCodes.INTERNAL_ERROR }])
    expect(markRead).toHaveBeenCalledTimes(3)
  })
})
