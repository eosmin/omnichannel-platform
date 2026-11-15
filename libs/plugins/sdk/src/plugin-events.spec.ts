import { WebhookEvents } from '@platform/core/domain'
import { Events } from '@platform/core/events'

import { PluginEventScopes, redactForScopes } from './plugin-events'
import { PluginScopes } from './plugin-scopes'

const messageReceived = {
  storeId: 's-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  customerId: 'u-1',
  channelType: 'whatsapp',
  authorType: 'customer',
  contentPreview: 'hola, mi telefono es 555',
  receivedAt: '2026-11-15T10:00:00.000Z',
  visibility: { hidden: false, assignedTo: 'agent-1' }
}

describe('redactForScopes', () => {
  it('sends a plugin with only messages:read no customer id, no text and no staff id', () => {
    const data = redactForScopes(Events.MESSAGE_RECEIVED, messageReceived, [
      PluginScopes.MESSAGES_READ
    ])
    expect(data).toEqual({
      storeId: 's-1',
      conversationId: 'c-1',
      messageId: 'm-1',
      channelType: 'whatsapp',
      authorType: 'customer',
      receivedAt: '2026-11-15T10:00:00.000Z'
    })
    expect(data).not.toHaveProperty('customerId')
    expect(JSON.stringify(data)).not.toContain('555')
    expect(JSON.stringify(data)).not.toContain('agent-1')
  })

  it('adds the customer id only when customers:read is granted, and never the text', () => {
    const data = redactForScopes(Events.MESSAGE_RECEIVED, messageReceived, [
      PluginScopes.MESSAGES_READ,
      PluginScopes.CUSTOMERS_READ
    ])
    expect(data).toMatchObject({ customerId: 'u-1' })
    expect(data).not.toHaveProperty('contentPreview')
    expect(data).not.toHaveProperty('visibility')
  })

  it('tells nothing of an event whose scope was not granted', () => {
    expect(
      redactForScopes(Events.MESSAGE_RECEIVED, messageReceived, [PluginScopes.ORDERS_READ])
    ).toBeNull()
    expect(redactForScopes(Events.MESSAGE_RECEIVED, messageReceived, [])).toBeNull()
  })

  it('tells nothing of an event that is not in the webhook catalog', () => {
    expect(
      redactForScopes(Events.CONVERSATION_READ, { storeId: 's-1' }, Object.values(PluginScopes))
    ).toBeNull()
    expect(
      redactForScopes('not.an.event', { storeId: 's-1' }, Object.values(PluginScopes))
    ).toBeNull()
  })

  it('holds back a key nobody decided on, and anything that is not a plain value', () => {
    const data = redactForScopes(
      Events.ORDER_STATUS_CHANGED,
      {
        storeId: 's-1',
        orderId: 'o-1',
        orderNumber: '1001',
        from: 'pending_confirmation',
        to: 'confirmed',
        notifyCustomer: true,
        actor: { type: 'user', id: 'agent-1' },
        customerPhone: '+503 5555 5555',
        items: [{ sku: 'a' }]
      },
      [PluginScopes.ORDERS_READ]
    )
    expect(data).toEqual({
      storeId: 's-1',
      orderId: 'o-1',
      orderNumber: '1001',
      from: 'pending_confirmation',
      to: 'confirmed'
    })
  })

  it('does not read a key from the prototype', () => {
    const payload = Object.create({ customerId: 'u-1' }) as Record<string, unknown>
    payload['storeId'] = 's-1'
    const data = redactForScopes(Events.CUSTOMER_UPDATED, payload, [PluginScopes.CUSTOMERS_READ])
    expect(data).toEqual({ storeId: 's-1' })
  })
})

describe('PluginEventScopes', () => {
  it('names only events a store can follow, and a scope that exists', () => {
    const catalog: readonly string[] = WebhookEvents
    const scopes: readonly string[] = Object.values(PluginScopes)
    for (const [event, scope] of Object.entries(PluginEventScopes)) {
      expect(catalog).toContain(event)
      expect(scopes).toContain(scope)
    }
  })

  it('leaves out no event of the catalog: every one a store can follow has the scope its plugin needs', () => {
    const left = WebhookEvents.filter(event => PluginEventScopes[event] === undefined)
    expect(left).toEqual([])
  })

  it('opens the four events of a return with returns:read', () => {
    for (const event of [
      Events.RETURN_REQUESTED,
      Events.RETURN_APPROVED,
      Events.RETURN_IN_TRANSIT,
      Events.RETURN_RECEIVED
    ]) {
      expect(PluginEventScopes[event]).toBe(PluginScopes.RETURNS_READ)
    }
  })

  it('tells a plugin of a return the ids it can read, and never who did it', () => {
    const payload = {
      storeId: 's-1',
      orderId: 'o-1',
      orderNumber: '00041',
      returnId: 'r-1',
      actor: { id: 'agent-1' },
      customerId: 'u-1'
    }
    const data = redactForScopes(Events.RETURN_REQUESTED, payload, [PluginScopes.RETURNS_READ])
    expect(data).toEqual({ storeId: 's-1', orderId: 'o-1', orderNumber: '00041', returnId: 'r-1' })
    // The event is told only to an installation that holds returns:read: orders:read alone is not enough
    expect(redactForScopes(Events.RETURN_REQUESTED, payload, [PluginScopes.ORDERS_READ])).toBeNull()
  })
})
