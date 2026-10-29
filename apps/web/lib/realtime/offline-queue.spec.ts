import { z } from 'zod'

import { ApiError, type SendMessageInput, StorageKeys } from '@platform/api-client'
import { MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { OfflineQueue } from './offline-queue'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { raw: () => string | null } {
  const data = new Map<string, string>()
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    raw: () => data.get(StorageKeys.PENDING_MESSAGES) ?? null
  }
}

function setup(storage: Pick<Storage, 'getItem' | 'setItem'> = memoryStorage()) {
  let counter = 0
  const send = jest.fn<Promise<unknown>, [string, SendMessageInput]>()
  const queue = new OfflineQueue({
    storage,
    send,
    newId: () => `id-${++counter}`,
    now: () => new Date('2026-10-30T10:00:00.000Z')
  })
  return { queue, send, storage }
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  userId: 'u1',
  storeId: 's1',
  conversationId: 'c1',
  type: MessageType.TEXT as MessageType.TEXT,
  content: 'hola',
  ...overrides
})

describe('OfflineQueue', () => {
  it('keeps what was written and sends it with its id as the idempotency key', async () => {
    const { queue, send } = setup()
    send.mockResolvedValue({})
    const pending = queue.enqueue(draft())
    expect(pending).toMatchObject({
      id: 'id-1',
      lastError: null,
      createdAt: '2026-10-30T10:00:00.000Z'
    })

    await queue.flush('u1')

    expect(send).toHaveBeenCalledWith('s1', {
      type: MessageType.TEXT,
      conversationId: 'c1',
      content: 'hola',
      idempotencyKey: 'id-1'
    })
    expect(queue.waiting('u1')).toEqual([])
  })

  it('sends the mentions of a note and none for a reply', async () => {
    const { queue, send } = setup()
    send.mockResolvedValue({})
    queue.enqueue(draft({ type: MessageType.INTERNAL_NOTE, mentions: ['u2'] }))
    await queue.flush('u1')
    expect(send.mock.calls[0]?.[1]).toMatchObject({ type: 'INTERNAL_NOTE', mentions: ['u2'] })
  })

  it('sends in the order they were written', async () => {
    const { queue, send } = setup()
    send.mockResolvedValue({})
    queue.enqueue(draft({ content: 'one' }))
    queue.enqueue(draft({ content: 'two' }))
    await queue.flush('u1')
    expect(send.mock.calls.map(call => call[1].content)).toEqual(['one', 'two'])
  })

  it('stops at a transient failure and leaves everything for the next connection', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft({ content: 'one' }))
    queue.enqueue(draft({ content: 'two' }))
    send.mockRejectedValueOnce(new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'offline'))

    await queue.flush('u1')

    expect(send).toHaveBeenCalledTimes(1)
    expect(queue.waiting('u1').map(m => m.content)).toEqual(['one', 'two'])

    send.mockResolvedValue({})
    await queue.flush('u1')
    expect(queue.waiting('u1')).toEqual([])
  })

  it('marks a message that can never succeed and goes on with the next', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft({ content: 'one' }))
    queue.enqueue(draft({ content: 'two' }))
    send.mockRejectedValueOnce(new ApiError(409, ErrorCodes.CHANNEL_WINDOW_EXPIRED, 'closed'))
    send.mockResolvedValueOnce({})

    await queue.flush('u1')

    expect(queue.failed('u1')).toMatchObject([
      { content: 'one', lastError: ErrorCodes.CHANNEL_WINDOW_EXPIRED }
    ])
    expect(queue.waiting('u1')).toEqual([])
    // A message that failed for good is not sent again
    await queue.flush('u1')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('marks any refusal of the request, whatever its code, so it does not block the ones behind', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft({ content: 'one' }))
    queue.enqueue(draft({ content: 'two' }))
    send.mockRejectedValueOnce(new ApiError(413, 'SOME_NEW_CODE', 'too big'))
    send.mockResolvedValueOnce({})

    await queue.flush('u1')

    expect(queue.failed('u1')).toMatchObject([{ content: 'one', lastError: 'SOME_NEW_CODE' }])
    expect(queue.waiting('u1')).toEqual([])
  })

  it.each([401, 408, 429, 500, 502, 0])(
    'keeps the message and stops the pass on a %i',
    async status => {
      const { queue, send } = setup()
      queue.enqueue(draft())
      send.mockRejectedValueOnce(new ApiError(status, ErrorCodes.INTERNAL_ERROR, 'try later'))
      await queue.flush('u1')
      expect(queue.waiting('u1')).toHaveLength(1)
      expect(queue.failed('u1')).toEqual([])
    }
  )

  it('takes an answer it cannot read as a message that was sent', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft())
    send.mockRejectedValueOnce(new z.ZodError([]))
    await queue.flush('u1')
    expect(queue.waiting('u1')).toEqual([])
    expect(queue.failed('u1')).toEqual([])
  })

  it('lets the agent discard a message that failed', async () => {
    const { queue, send } = setup()
    const pending = queue.enqueue(draft())
    send.mockRejectedValueOnce(new ApiError(404, ErrorCodes.RESOURCE_NOT_FOUND, 'gone'))
    await queue.flush('u1')
    queue.discard(pending.id)
    expect(queue.failed('u1')).toEqual([])
  })

  it('does not send a message that was discarded while the pass was running', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft({ content: 'one' }))
    const second = queue.enqueue(draft({ content: 'two' }))
    send.mockImplementationOnce(() => {
      queue.discard(second.id)
      return Promise.resolve({})
    })

    await queue.flush('u1')

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('never sends what another person on this browser wrote', async () => {
    const { queue, send } = setup()
    send.mockResolvedValue({})
    queue.enqueue(draft({ userId: 'u1' }))
    await queue.flush('u2')
    expect(send).not.toHaveBeenCalled()
    expect(queue.waiting('u1')).toHaveLength(1)
  })

  it('does not run two passes at once', async () => {
    const { queue, send } = setup()
    queue.enqueue(draft())
    let release: () => void = () => undefined
    send.mockImplementation(() => new Promise(resolve => (release = () => resolve({}))))

    const first = queue.flush('u1')
    const second = queue.flush('u1')
    release()
    await Promise.all([first, second])

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reads the storage on every change, so a second tab is not overwritten', () => {
    const storage = memoryStorage()
    const tabA = setup(storage).queue
    const tabB = setup(storage).queue
    tabA.enqueue(draft({ content: 'from A' }))
    tabB.enqueue(draft({ content: 'from B' }))
    expect(tabA.waiting('u1').map(m => m.content)).toEqual(['from A', 'from B'])
  })

  it('starts empty when the storage holds something that is not a queue', () => {
    const storage = memoryStorage()
    storage.setItem(StorageKeys.PENDING_MESSAGES, '{"not":"a queue"}')
    expect(setup(storage).queue.waiting('u1')).toEqual([])
  })

  it('keeps the queue in memory when the storage refuses to write', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    }
    const { queue, send } = setup(storage)
    send.mockResolvedValue({})
    queue.enqueue(draft())
    expect(queue.waiting('u1')).toHaveLength(1)
    await queue.flush('u1')
    expect(queue.waiting('u1')).toEqual([])
  })
})
