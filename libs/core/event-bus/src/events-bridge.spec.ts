import type { EventEmitter2 } from '@nestjs/event-emitter'
import type { Redis } from 'ioredis'

import { ConversationStatus } from '@platform/core/domain'
import { Events, eventsBridgeChannel, EVENTS_BRIDGE_CHANNEL } from '@platform/core/events'

import { EventsBridge, EventsBridgeModes } from './events-bridge'

function build(mode: 'publish' | 'subscribe', prefix: string) {
  const publish = jest.fn(() => Promise.resolve(1))
  const subscriber: {
    on: jest.Mock
    subscribe: jest.Mock
  } = {
    on: jest.fn((event: string, handler: () => void) => {
      if (event === 'ready') handler()
      return subscriber
    }),
    subscribe: jest.fn(() => Promise.resolve(1))
  }
  const redis = { publish, duplicate: jest.fn(() => subscriber) } as unknown as Redis
  const bridge = new EventsBridge({ mode, prefix }, redis, {} as unknown as EventEmitter2)
  return { bridge, publish, subscriber }
}

describe('EventsBridge channel', () => {
  it('names the channel with the prefix, so stacks that share a Redis do not hear each other', () => {
    expect(eventsBridgeChannel('q-aaa')).toBe(`q-aaa:${EVENTS_BRIDGE_CHANNEL}`)
    expect(eventsBridgeChannel('q-aaa')).not.toBe(eventsBridgeChannel('q-bbb'))
  })

  it('publishes on the channel of its prefix, never on the bare one', () => {
    const { bridge, publish } = build(EventsBridgeModes.PUBLISH, 'q-aaa')
    bridge.publish(Events.CONVERSATION_STATUS_CHANGED, {
      storeId: '3f1b7a0e-6d3e-4b8e-9c1a-0e2f6a1b2c3d',
      conversationId: '4f1b7a0e-6d3e-4b8e-9c1a-0e2f6a1b2c3d',
      previousStatus: ConversationStatus.OPEN,
      status: ConversationStatus.RESOLVED,
      assignedTo: null,
      changedBy: { type: 'system', id: null }
    })
    expect(publish.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      eventsBridgeChannel('q-aaa')
    ])
  })

  it('subscribes to the channel of its prefix, never to the bare one', () => {
    const { bridge, subscriber } = build(EventsBridgeModes.SUBSCRIBE, 'q-bbb')
    bridge.onModuleInit()
    expect(subscriber.subscribe).toHaveBeenCalledWith(eventsBridgeChannel('q-bbb'))
    expect(subscriber.subscribe).not.toHaveBeenCalledWith(EVENTS_BRIDGE_CHANNEL)
  })
})
