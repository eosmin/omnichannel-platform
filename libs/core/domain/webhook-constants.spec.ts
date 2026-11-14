import { ApiKeyScopePrefixes, isApiKeyScope } from './api-key-constants'
import { Permissions } from './auth/permissions'
import { Events } from './events/event-names'
import { isWebhookEvent, WebhookEvents, WebhookLimits } from './webhook-constants'

describe('the events a webhook can follow', () => {
  it('names each event once, and only events that exist', () => {
    const all: string[] = Object.values(Events)
    expect(new Set(WebhookEvents).size).toBe(WebhookEvents.length)
    for (const event of WebhookEvents) expect(all).toContain(event)
  })

  it('knows which strings are in the catalog', () => {
    expect(isWebhookEvent(Events.ORDER_CREATED)).toBe(true)
    expect(isWebhookEvent(Events.CHANNEL_DISCONNECTED)).toBe(false)
    expect(isWebhookEvent('toString')).toBe(false)
    expect(isWebhookEvent('')).toBe(false)
  })

  it('keeps the text of the conversations out: the bus carries ids for these events', () => {
    // A webhook receives the payload as the bus has it (TDD_07 §2); the events that carry free text are not offered
    expect(isWebhookEvent(Events.MESSAGE_NOTE_ADDED)).toBe(false)
    expect(isWebhookEvent(Events.MESSAGE_MENTION)).toBe(false)
  })

  it('turns a webhook off only after a run of failures long enough to be an outage', () => {
    expect(WebhookLimits.MAX_CONSECUTIVE_FAILURES).toBe(20)
  })
})

describe('the scopes of an API key', () => {
  it('are permissions, but none that run the account', () => {
    expect(isApiKeyScope(Permissions.CUSTOMERS_VIEW)).toBe(true)
    expect(isApiKeyScope(Permissions.ORDERS_VIEW)).toBe(true)
    for (const permission of Object.values(Permissions)) {
      const allowed = ApiKeyScopePrefixes.some(prefix => permission.startsWith(prefix))
      expect(isApiKeyScope(permission)).toBe(allowed)
    }
    expect(isApiKeyScope(Permissions.SETTINGS_MANAGE_API_KEYS)).toBe(false)
    expect(isApiKeyScope(Permissions.TEAM_MANAGE_ROLES)).toBe(false)
    expect(isApiKeyScope(Permissions.ORG_MANAGE_STORES)).toBe(false)
    expect(isApiKeyScope(Permissions.ANALYTICS_MANAGE_REPORTS)).toBe(false)
  })

  it('are not anything that is not a permission', () => {
    expect(isApiKeyScope('customers:everything')).toBe(false)
    expect(isApiKeyScope('constructor')).toBe(false)
    expect(isApiKeyScope('')).toBe(false)
  })
})
