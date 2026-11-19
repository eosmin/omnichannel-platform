import { ChannelConnectionStatus } from '@platform/core/domain'

import { AgentTypingRelay } from './agent-typing-relay.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'

// A client that answers only inside a store context, as the database does with row level security on
function build(options: { mayStart?: boolean; found?: boolean; status?: string } = {}) {
  let open: string | null = null
  const opened: string[] = []
  const conversation = {
    channelConnection: {
      pluginId: 'p',
      connectionId: 'site',
      status: options.status ?? ChannelConnectionStatus.ACTIVE
    },
    customerIdentity: { channelIdentity: 'visitor' }
  }
  const prisma = {
    inStoreContext: jest.fn(async (storeId: string, work: () => Promise<unknown>) => {
      opened.push(storeId)
      open = storeId
      try {
        return await work()
      } finally {
        open = null
      }
    }),
    client: {
      conversation: {
        findFirst: jest.fn((args: { where: { storeId: string } }) => {
          if (open === null || open !== args.where.storeId) {
            return Promise.reject(new Error('queried with no tenant context'))
          }
          return Promise.resolve(options.found === false ? null : conversation)
        })
      }
    }
  }
  const registry = { hasCapability: jest.fn(() => true) }
  // Nothing is queued while the lookup still holds the connection
  const outbound = {
    enqueueTyping: jest.fn(() => {
      expect(open).toBeNull()
      return Promise.resolve()
    })
  }
  // The permission look of the agent runs in its own context: it must not find this one still open
  const mayStart = jest.fn(() => {
    expect(open).toBeNull()
    return Promise.resolve(options.mayStart ?? true)
  })
  const relay = new AgentTypingRelay(prisma as never, registry as never, outbound as never, [])
  return { relay, prisma, outbound, mayStart, opened }
}

describe('AgentTypingRelay under row level security', () => {
  it('reads the conversation inside the context of the store of the socket, and of that store alone', async () => {
    const { relay, outbound, opened } = build()
    await relay.relay(STORE, CONVERSATION, true)
    expect(opened).toEqual([STORE])
    expect(outbound.enqueueTyping).toHaveBeenCalledTimes(1)
  })

  it('closes the context before it asks whether the agent may start, and before it queues', async () => {
    const { relay, outbound, mayStart } = build()
    await relay.relay(STORE, CONVERSATION, true, mayStart)
    expect(mayStart).toHaveBeenCalledTimes(1)
    expect(outbound.enqueueTyping).toHaveBeenCalledTimes(1)
  })

  it('queues nothing when the agent may not start', async () => {
    const { relay, outbound, mayStart } = build({ mayStart: false })
    await relay.relay(STORE, CONVERSATION, true, mayStart)
    expect(outbound.enqueueTyping).not.toHaveBeenCalled()
  })

  it('tells nothing for a conversation the store does not hold, or a channel that is not active', async () => {
    for (const options of [{ found: false }, { status: 'DISCONNECTED' }]) {
      const { relay, outbound } = build(options)
      await relay.relay(STORE, CONVERSATION, true)
      expect(outbound.enqueueTyping).not.toHaveBeenCalled()
    }
  })

  it('refuses the work, and queues nothing, when the context cannot be opened', async () => {
    const { relay, prisma, outbound } = build()
    prisma.inStoreContext.mockRejectedValueOnce(new Error('pool exhausted'))
    await expect(relay.relay(STORE, CONVERSATION, true)).rejects.toThrow('pool exhausted')
    expect(outbound.enqueueTyping).not.toHaveBeenCalled()
  })

  it('sends the stop that follows a start, in the same store', async () => {
    const { relay, outbound, opened } = build()
    await relay.relay(STORE, CONVERSATION, true)
    await relay.relay(STORE, CONVERSATION, false)
    expect(opened).toEqual([STORE, STORE])
    expect(outbound.enqueueTyping).toHaveBeenCalledTimes(2)
  })
})
