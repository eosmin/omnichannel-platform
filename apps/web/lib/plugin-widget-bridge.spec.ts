import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

import {
  connectWidget,
  failureOf,
  type WidgetBridgeOptions,
  WidgetStatuses,
  widgetFrameUrl
} from './plugin-widget-bridge'

// A pair of ports as a test double: what the page posts on port1 is what the frame would hear, and `frameSays`
// is what the frame posts back to the page
function fakeChannel() {
  const toFrame: unknown[] = []
  const port1 = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    postMessage: (message: unknown) => toFrame.push(message),
    close: jest.fn()
  }
  const port2 = {}
  return {
    channel: { port1, port2 } as unknown as MessageChannel,
    toFrame,
    frameSays: (data: unknown) => port1.onmessage?.({ data } as MessageEvent<unknown>),
    port1,
    port2
  }
}

const REQUEST = { type: 'platform.widget.request', id: 'r1', operation: 'conversation.get' }
const flush = () => Promise.resolve().then(() => Promise.resolve())

function setup(overrides: Partial<WidgetBridgeOptions> = {}) {
  const fake = fakeChannel()
  const posted: { message: unknown; origin: string; transfer: unknown[] }[] = []
  const statuses: string[] = []
  const options: WidgetBridgeOptions = {
    frame: {
      contentWindow: {
        postMessage: ((message: unknown, origin: string, transfer: unknown[]) => {
          posted.push({ message, origin, transfer })
        }) as unknown as Window['postMessage']
      }
    },
    widgetOrigin: 'https://widgets.acme.example',
    widgetId: 'info',
    conversationId: 'conv-1',
    openSession: jest.fn().mockResolvedValue({ token: 'tok-1', expiresInSeconds: 300 }),
    call: jest.fn().mockResolvedValue({
      type: 'platform.widget.response',
      id: 'r1',
      ok: true,
      data: { id: 'conv-1' }
    }),
    onStatus: status => statuses.push(status),
    createChannel: () => fake.channel,
    ...overrides
  }
  return { ...fake, options, posted, statuses }
}

describe('widgetFrameUrl', () => {
  it('adds the conversation and the widget to the url, and nothing secret', () => {
    const url = new URL(widgetFrameUrl('https://widgets.acme.example/panel', 'info', 'conv-1'))
    expect(url.origin + url.pathname).toBe('https://widgets.acme.example/panel')
    expect(url.searchParams.get('conversationId')).toBe('conv-1')
    expect(url.searchParams.get('widgetId')).toBe('info')
    expect([...url.searchParams.keys()].sort()).toEqual(['conversationId', 'widgetId'])
  })
})

describe('failureOf', () => {
  it('words a failure as a code and never as the api text', () => {
    expect(failureOf(new ApiError(410, ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID, 'x'))).toBe(
      'session_invalid'
    )
    expect(failureOf(new ApiError(403, ErrorCodes.PLUGIN_SCOPE_DENIED, 'x'))).toBe('scope_denied')
    expect(failureOf(new ApiError(429, ErrorCodes.RATE_LIMIT_EXCEEDED, 'x'))).toBe('rate_limited')
    expect(failureOf(new ApiError(404, 'NOT_FOUND', 'x'))).toBe('not_found')
    expect(failureOf(new ApiError(500, 'INTERNAL', 'secret detail'))).toBe('failed')
    expect(failureOf(new Error('boom'))).toBe('failed')
  })
})

describe('connectWidget', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('offers the port to the origin of the widget only, with no token in the INIT', async () => {
    const { options, posted, port2 } = setup()
    connectWidget(options)
    await flush()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.origin).toBe('https://widgets.acme.example')
    expect(posted[0]?.message).toEqual({ type: 'platform.widget.init' })
    expect(posted[0]?.transfer).toEqual([port2])
  })

  it('sends the session over the port, naming the widget and the conversation', async () => {
    const { options, toFrame } = setup()
    connectWidget(options)
    await flush()
    expect(toFrame).toEqual([
      {
        type: 'platform.widget.session',
        token: 'tok-1',
        expiresInSeconds: 300,
        widgetId: 'info',
        conversationId: 'conv-1'
      }
    ])
  })

  it('becomes ready when the frame says so, and the notice timer is cancelled', async () => {
    const { options, frameSays, statuses } = setup()
    connectWidget(options)
    await flush()
    frameSays({ type: 'platform.widget.ready' })
    jest.advanceTimersByTime(60_000)
    expect(statuses).toEqual([WidgetStatuses.CONNECTING, WidgetStatuses.READY])
  })

  it('says unresponsive when the frame never answers the INIT', async () => {
    const { options, statuses } = setup()
    connectWidget(options)
    await flush()
    jest.advanceTimersByTime(10_000)
    expect(statuses.at(-1)).toBe(WidgetStatuses.UNRESPONSIVE)
  })

  it('forwards a valid request with the session token and answers over the port', async () => {
    const { options, frameSays, toFrame } = setup()
    connectWidget(options)
    await flush()
    frameSays(REQUEST)
    await flush()
    expect(options.call).toHaveBeenCalledWith('tok-1', REQUEST)
    expect(toFrame.at(-1)).toMatchObject({ type: 'platform.widget.response', id: 'r1', ok: true })
  })

  it.each([
    ['an unknown operation', { ...REQUEST, operation: 'orders.list' }],
    ['an extra key', { ...REQUEST, conversationId: 'another' }],
    ['a token of its own', { ...REQUEST, token: 'stolen' }],
    ['no id', { type: REQUEST.type, operation: REQUEST.operation }],
    ['a string', 'platform.widget.request'],
    ['null', null]
  ])('drops %s without calling the api or answering', async (_label, data) => {
    const { options, frameSays, toFrame } = setup()
    connectWidget(options)
    await flush()
    const before = toFrame.length
    frameSays(data)
    await flush()
    expect(options.call).not.toHaveBeenCalled()
    expect(toFrame).toHaveLength(before)
  })

  it('answers a failed call with a code, not with the api error', async () => {
    const { options, frameSays, toFrame } = setup({
      call: jest.fn().mockRejectedValue(new ApiError(403, ErrorCodes.PLUGIN_SCOPE_DENIED, 'detail'))
    })
    connectWidget(options)
    await flush()
    frameSays(REQUEST)
    await flush()
    expect(toFrame.at(-1)).toEqual({
      type: 'platform.widget.response',
      id: 'r1',
      ok: false,
      failure: 'scope_denied'
    })
  })

  it('renews the session before the five minutes end and tells the frame', async () => {
    const openSession = jest
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInSeconds: 300 })
      .mockResolvedValueOnce({ token: 'tok-2', expiresInSeconds: 300 })
    const { options, toFrame, frameSays } = setup({ openSession })
    connectWidget(options)
    await flush()
    jest.advanceTimersByTime(239_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(2)
    expect(toFrame.at(-1)).toMatchObject({ type: 'platform.widget.session', token: 'tok-2' })
    frameSays(REQUEST)
    await flush()
    expect(options.call).toHaveBeenCalledWith('tok-2', REQUEST)
  })

  it('keeps the old session and tries again soon when a renewal fails', async () => {
    const openSession = jest
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInSeconds: 300 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ token: 'tok-3', expiresInSeconds: 300 })
    const { options, statuses, toFrame } = setup({ openSession })
    connectWidget(options)
    await flush()
    jest.advanceTimersByTime(240_000)
    await flush()
    expect(statuses).not.toContain(WidgetStatuses.FAILED)
    jest.advanceTimersByTime(15_000)
    await flush()
    expect(toFrame.at(-1)).toMatchObject({ token: 'tok-3' })
  })

  it('says failed when the first session cannot be opened, and answers a request with session_invalid', async () => {
    const { options, statuses, frameSays, toFrame } = setup({
      openSession: jest.fn().mockRejectedValue(new Error('403'))
    })
    connectWidget(options)
    await flush()
    expect(statuses).toContain(WidgetStatuses.FAILED)
    frameSays(REQUEST)
    await flush()
    expect(options.call).not.toHaveBeenCalled()
    expect(toFrame.at(-1)).toMatchObject({ ok: false, failure: 'session_invalid' })
  })

  it('stops everything on close: no renewal, no answers, the port is closed', async () => {
    const openSession = jest.fn().mockResolvedValue({ token: 'tok-1', expiresInSeconds: 300 })
    const { options, frameSays, toFrame, port1 } = setup({ openSession })
    const bridge = connectWidget(options)
    await flush()
    bridge.close()
    jest.advanceTimersByTime(600_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(port1.close).toHaveBeenCalled()
    const before = toFrame.length
    frameSays(REQUEST)
    await flush()
    expect(toFrame).toHaveLength(before)
  })

  it('stops trying and says failed when the api no longer knows the widget', async () => {
    const openSession = jest
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInSeconds: 300 })
      .mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'))
    const { options, statuses, frameSays } = setup({
      openSession,
      call: jest
        .fn()
        .mockRejectedValue(new ApiError(410, ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID, 'x'))
    })
    connectWidget(options)
    await flush()
    frameSays(REQUEST)
    await flush()
    await flush()
    expect(statuses.at(-1)).toBe(WidgetStatuses.FAILED)
    jest.advanceTimersByTime(120_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(2)
  })

  it('says unresponsive at once when the frame has no window, and opens no channel', () => {
    const createChannel = jest.fn()
    const { options, statuses } = setup({ frame: { contentWindow: null }, createChannel })
    connectWidget(options).close()
    expect(statuses).toEqual([WidgetStatuses.CONNECTING, WidgetStatuses.UNRESPONSIVE])
    expect(createChannel).not.toHaveBeenCalled()
    expect(options.openSession).not.toHaveBeenCalled()
  })

  it('never renews in a loop: a lifetime shorter than the margin waits half of it', async () => {
    const openSession = jest.fn().mockResolvedValue({ token: 'tok', expiresInSeconds: 30 })
    const { options } = setup({ openSession })
    connectWidget(options)
    await flush()
    jest.advanceTimersByTime(14_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1_000)
    await flush()
    expect(openSession).toHaveBeenCalledTimes(2)
  })

  it('opens a new session at once when the api says the session is invalid', async () => {
    const openSession = jest
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInSeconds: 300 })
      .mockResolvedValueOnce({ token: 'tok-2', expiresInSeconds: 300 })
    const { options, frameSays, toFrame } = setup({
      openSession,
      call: jest
        .fn()
        .mockRejectedValue(new ApiError(410, ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID, 'x'))
    })
    connectWidget(options)
    await flush()
    frameSays(REQUEST)
    await flush()
    await flush()
    expect(openSession).toHaveBeenCalledTimes(2)
    expect(toFrame.at(-1)).toMatchObject({ type: 'platform.widget.session', token: 'tok-2' })
  })

  it('keeps trying while it has no session, and recovers from FAILED when one opens', async () => {
    const openSession = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ token: 'tok-1', expiresInSeconds: 300 })
    const { options, statuses, toFrame } = setup({ openSession })
    connectWidget(options)
    await flush()
    expect(statuses).toContain(WidgetStatuses.FAILED)
    jest.advanceTimersByTime(15_000)
    await flush()
    expect(toFrame.at(-1)).toMatchObject({ token: 'tok-1' })
    expect(statuses.at(-1)).toBe(WidgetStatuses.CONNECTING)
  })
})
