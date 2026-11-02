import type { PushPayload } from '@platform/core/notifications'

import {
  type ClientsLike,
  openNotificationTarget,
  parsePushPayload,
  pushDisplayOf,
  targetPathOf,
  type WindowClientLike
} from './service-worker-push'

const ORIGIN = 'https://app.example.com'

const payload = {
  notificationId: 'n1',
  title: 'Assigned to you',
  body: 'Ana assigned you a conversation',
  tag: 'conversation.assigned:c1',
  severity: 'info',
  actionPath: '/s/store-1/inbox/c1'
}

function parsed(raw: unknown): PushPayload {
  const result = parsePushPayload(raw)
  if (result === null) throw new Error('the payload was not read')
  return result
}

describe('parsePushPayload', () => {
  it('reads what the worker of the server sends', () => {
    expect(parsePushPayload(payload)).toEqual(payload)
  })

  it('takes an action path of null', () => {
    expect(parsePushPayload({ ...payload, actionPath: null })?.actionPath).toBeNull()
  })

  it.each([
    null,
    undefined,
    'text',
    4,
    [],
    { ...payload, title: 3 },
    { ...payload, tag: undefined }
  ])('drops %p', value => {
    expect(parsePushPayload(value)).toBeNull()
  })

  it('draws a severity it does not know like an information', () => {
    expect(parsePushPayload({ ...payload, severity: 'catastrophe' })?.severity).toBe('info')
  })
})

describe('pushDisplayOf', () => {
  it('carries the tag, so the device replaces the notification of the same thing', () => {
    const { title, options } = pushDisplayOf(parsed(payload))
    expect(title).toBe('Assigned to you')
    expect(options.tag).toBe('conversation.assigned:c1')
    expect(options.data).toEqual({ actionPath: '/s/store-1/inbox/c1', notificationId: 'n1' })
    expect(options.requireInteraction).toBe(false)
  })

  it('keeps an error on screen until the person acts', () => {
    const { options } = pushDisplayOf(parsed({ ...payload, severity: 'error' }))
    expect(options.requireInteraction).toBe(true)
  })
})

describe('targetPathOf', () => {
  it('keeps a path of the app, with its query and hash', () => {
    expect(targetPathOf('/s/store-1/inbox/c1?tab=notes#m2', ORIGIN)).toBe(
      '/s/store-1/inbox/c1?tab=notes#m2'
    )
  })

  it.each([
    null,
    undefined,
    '',
    'inbox',
    '//evil.example.com/x',
    '/\\evil.example.com',
    'https://evil.example.com/x',
    'javascript:alert(1)',
    42
  ])('sends %p to the start page', value => {
    expect(targetPathOf(value, ORIGIN)).toBe('/')
  })
})

function windowAt(url: string): WindowClientLike & { focus: jest.Mock; navigate: jest.Mock } {
  return {
    url,
    focus: jest.fn().mockResolvedValue(undefined),
    navigate: jest.fn().mockResolvedValue(undefined)
  }
}

describe('openNotificationTarget', () => {
  it('sends a window of the app to the page and focuses it', async () => {
    const other = windowAt('https://other.example.com/')
    const own = windowAt(`${ORIGIN}/s/store-1/inbox`)
    const clients: ClientsLike = {
      matchAll: () => Promise.resolve([other, own]),
      openWindow: jest.fn()
    }
    await openNotificationTarget(clients, '/s/store-1/inbox/c1', ORIGIN)
    expect(own.navigate).toHaveBeenCalledWith('/s/store-1/inbox/c1')
    expect(own.focus).toHaveBeenCalled()
    expect(other.focus).not.toHaveBeenCalled()
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens a window when none of the app is open', async () => {
    const openWindow = jest.fn().mockResolvedValue(undefined)
    const clients: ClientsLike = { matchAll: () => Promise.resolve([]), openWindow }
    await openNotificationTarget(clients, '/s/store-1/exports', ORIGIN)
    expect(openWindow).toHaveBeenCalledWith('/s/store-1/exports')
  })

  it('opens a new window at the page when the window refuses to navigate', async () => {
    const own = windowAt(`${ORIGIN}/`)
    own.navigate.mockRejectedValue(new Error('not controlled'))
    const openWindow = jest.fn().mockResolvedValue(undefined)
    const clients: ClientsLike = { matchAll: () => Promise.resolve([own]), openWindow }
    await openNotificationTarget(clients, '/x', ORIGIN)
    expect(openWindow).toHaveBeenCalledWith('/x')
  })
})
