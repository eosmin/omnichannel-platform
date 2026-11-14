import { WebhookEvents, WebhookLimits } from '@platform/core/domain'

import { deliveryErrorCode } from './webhook-delivery'
import {
  eventGroups,
  setGroup,
  toggleEvent,
  webhookChanges,
  webhookDraftOf,
  webhookProblems
} from './webhook-form'
import type { WebhookView } from './webhooks-requests'

const webhook: WebhookView = {
  id: 'w1',
  url: 'https://example.com/hook',
  events: ['order.created', 'order.updated'],
  status: 'active',
  consecutiveFailures: 0,
  lastFailureAt: null,
  createdAt: '2026-11-15T10:00:00.000Z'
}

describe('webhookProblems', () => {
  const ok = { url: 'https://example.com/hook', events: ['order.created'] }

  it('accepts an https address and one event', () => {
    expect(webhookProblems(ok)).toEqual([])
    expect(webhookProblems({ ...ok, url: '  https://example.com/hook?x=1  ' })).toEqual([])
    expect(webhookProblems({ ...ok, url: 'https://example.com:443/hook' })).toEqual([])
  })

  it('asks for the address and the events', () => {
    expect(webhookProblems({ url: ' ', events: [] })).toEqual(['urlRequired', 'noEvents'])
  })

  it('refuses http, credentials and text that is not an address', () => {
    for (const url of [
      'http://example.com',
      'https://user:pw@example.com',
      'example.com',
      'ftp://x.io'
    ]) {
      expect(webhookProblems({ ...ok, url })).toEqual(['urlNotHttps'])
    }
  })

  it('refuses a fragment and a port other than the standard one', () => {
    expect(webhookProblems({ ...ok, url: 'https://example.com/a#b' })).toEqual(['urlFragment'])
    expect(webhookProblems({ ...ok, url: 'https://example.com:8443/a' })).toEqual(['urlPort'])
  })

  it('refuses an address longer than the api takes', () => {
    const url = `https://example.com/${'a'.repeat(WebhookLimits.URL_MAX_LENGTH)}`
    expect(webhookProblems({ ...ok, url })).toEqual(['urlTooLong'])
  })
})

describe('event groups', () => {
  it('lists every event of the platform once, grouped by what it is about', () => {
    const groups = eventGroups()
    expect(groups.flatMap(group => group.events)).toEqual([...WebhookEvents])
    expect(groups.map(group => group.group)).toEqual([
      'order',
      'customer',
      'conversation',
      'message',
      'shipment',
      'return',
      'product'
    ])
    for (const { group, events } of groups) {
      for (const event of events) expect(event.startsWith(`${group}.`)).toBe(true)
    }
  })

  it('toggles one event and a whole group', () => {
    expect(toggleEvent(['a.b'], 'c.d')).toEqual(['a.b', 'c.d'])
    expect(toggleEvent(['a.b', 'c.d'], 'a.b')).toEqual(['c.d'])
    const group = { group: 'order', events: ['order.created', 'order.updated'] }
    expect(setGroup(['customer.created', 'order.created'], group, true)).toEqual([
      'customer.created',
      'order.created',
      'order.updated'
    ])
    expect(setGroup(['customer.created', 'order.created'], group, false)).toEqual([
      'customer.created'
    ])
  })
})

describe('webhookChanges', () => {
  it('is empty when nothing changed, whatever the order of the events', () => {
    expect(webhookChanges(webhook, webhookDraftOf(webhook))).toEqual({})
    expect(
      webhookChanges(webhook, {
        url: ' https://example.com/hook ',
        events: ['order.updated', 'order.created']
      })
    ).toEqual({})
  })

  it('sends only the field that changed', () => {
    expect(
      webhookChanges(webhook, { url: 'https://example.org/h', events: webhook.events })
    ).toEqual({
      url: 'https://example.org/h'
    })
    expect(webhookChanges(webhook, { url: webhook.url, events: ['order.created'] })).toEqual({
      events: ['order.created']
    })
  })
})

describe('deliveryErrorCode', () => {
  it('splits the code from the detail of a network error', () => {
    expect(deliveryErrorCode('bad_status')).toEqual({ code: 'bad_status', detail: null })
    expect(deliveryErrorCode('no_answer:ECONNRESET')).toEqual({
      code: 'no_answer',
      detail: 'ECONNRESET'
    })
    expect(deliveryErrorCode('no_answer:')).toEqual({ code: 'no_answer', detail: null })
  })
})
