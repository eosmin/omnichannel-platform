import { WidgetApiError, type WidgetApi } from './api'
import { ChatLog } from './chat-log'
import { Session, type VisitorSocket } from './session'
import type { Bootstrap } from './types'

const MS = 1000
const HOUR = 3600

function boot(token: string, overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    visitorToken: token,
    expiresInSeconds: HOUR,
    store: { name: 'Shop', locale: 'es' },
    away: false,
    messages: [],
    ...overrides
  }
}

class FakeSocket implements VisitorSocket {
  readonly handlers = new Map<string, (...args: unknown[]) => void>()
  connects = 0
  disconnects = 0
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.set(event, listener)
  }
  connect(): void {
    this.connects += 1
  }
  disconnect(): void {
    this.disconnects += 1
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args)
  }
}

function setup(api: Partial<jest.Mocked<Pick<WidgetApi, 'bootstrap' | 'send'>>>) {
  const log = new ChatLog()
  const socket = new FakeSocket()
  let auth: ((deliver: (data: Record<string, string>) => void) => void) | undefined
  let ids = 0
  const session = new Session({
    siteKey: 'pk_x',
    visitorId: 'visitor',
    api: api as unknown as WidgetApi,
    log,
    socketUrl: 'https://api.test',
    createSocket: (_url, _namespace, authenticate) => {
      auth = authenticate
      return socket
    },
    newMessageId: () => `id-${(ids += 1)}`
  })
  const tokenOnTheWire = (): string | undefined => {
    let seen: string | undefined
    auth?.(data => {
      seen = data['token']
    })
    return seen
  }
  return { session, log, socket, tokenOnTheWire }
}

describe('Session', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  describe('starting', () => {
    it('reads the history, opens the socket with the token and hands back the store', async () => {
      const bootstrap = jest.fn().mockResolvedValue(
        boot('t1', {
          messages: [{ id: 'm1', from: 'team', content: 'hola', createdAt: 'd' }]
        })
      )
      const { session, log, tokenOnTheWire } = setup({ bootstrap })

      const result = await session.start()

      expect(result?.store.name).toBe('Shop')
      expect(bootstrap).toHaveBeenCalledWith('pk_x', 'visitor')
      expect(log.messages).toHaveLength(1)
      expect(tokenOnTheWire()).toBe('t1')
      session.stop()
    })

    it('gives up at once on a key or a site the api refuses', async () => {
      const bootstrap = jest.fn().mockRejectedValue(new WidgetApiError(403, 'X'))
      const { session } = setup({ bootstrap })

      expect(await session.start()).toBeNull()
      expect(bootstrap).toHaveBeenCalledTimes(1)
    })

    it('tries again when the api cannot be reached, and then works', async () => {
      const bootstrap = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(0, null))
        .mockResolvedValue(boot('t1'))
      const { session } = setup({ bootstrap })

      const started = session.start()
      await jest.advanceTimersByTimeAsync(MS)

      expect(await started).not.toBeNull()
      expect(bootstrap).toHaveBeenCalledTimes(2)
      session.stop()
    })

    it('stops trying after a few attempts', async () => {
      const bootstrap = jest.fn().mockRejectedValue(new WidgetApiError(500, null))
      const { session } = setup({ bootstrap })

      const started = session.start()
      await jest.advanceTimersByTimeAsync(40 * MS)

      expect(await started).toBeNull()
      expect(bootstrap).toHaveBeenCalledTimes(6)
    })
  })

  describe('replies', () => {
    it('adds a reply of the socket, and ignores what is not a message', async () => {
      const { session, log, socket } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')) })
      await session.start()

      socket.emit('widget.message', { id: 'r1', from: 'team', content: 'hola', createdAt: 'd' })
      socket.emit('widget.message', { nonsense: true })

      expect(log.messages.map(message => message.content)).toEqual(['hola'])
      session.stop()
    })
  })

  describe('the token', () => {
    it('is renewed before it ends, and the socket reconnects with the new one', async () => {
      const bootstrap = jest
        .fn()
        .mockResolvedValueOnce(boot('t1'))
        .mockResolvedValueOnce(boot('t2'))
      const { session, socket, tokenOnTheWire } = setup({ bootstrap })
      await session.start()

      await jest.advanceTimersByTimeAsync((HOUR - 60) * MS)

      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(socket.disconnects).toBe(1)
      expect(socket.connects).toBe(1)
      expect(tokenOnTheWire()).toBe('t2')
      session.stop()
    })

    it('is asked for again when the server closes the socket on purpose', async () => {
      const bootstrap = jest
        .fn()
        .mockResolvedValueOnce(boot('t1'))
        .mockResolvedValueOnce(boot('t2'))
      const { session, socket } = setup({ bootstrap })
      await session.start()

      socket.emit('disconnect', 'io server disconnect')
      await jest.advanceTimersByTimeAsync(0)

      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(socket.connects).toBe(1)
      session.stop()
    })

    it('is asked for again, and the socket connected, when the handshake says it is not valid and not for another refusal', async () => {
      const bootstrap = jest.fn().mockResolvedValue(boot('t1'))
      const { session, socket } = setup({ bootstrap })
      await session.start()

      socket.emit('connect_error', { data: { code: 'RATE_LIMIT_EXCEEDED' } })
      expect(bootstrap).toHaveBeenCalledTimes(1)
      socket.emit('connect_error', { data: { code: 'WIDGET_TOKEN_INVALID' } })
      await jest.advanceTimersByTimeAsync(0)

      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(socket.connects).toBe(1)
      session.stop()
    })

    it('stops asking when the api says the site or the key is gone', async () => {
      const bootstrap = jest
        .fn()
        .mockResolvedValueOnce(boot('t1'))
        .mockRejectedValue(new WidgetApiError(403, 'WIDGET_ORIGIN_NOT_ALLOWED'))
      const { session, socket } = setup({ bootstrap })
      await session.start()

      await jest.advanceTimersByTimeAsync(3 * HOUR * MS)

      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(socket.disconnects).toBe(1)
    })

    it('opens no socket when it was stopped while the api was answering', async () => {
      let answer: (value: Bootstrap) => void = () => undefined
      const bootstrap = jest.fn(
        (_siteKey: string, _visitorId: string) =>
          new Promise<Bootstrap>(resolve => (answer = resolve))
      )
      const { session, socket } = setup({ bootstrap })

      const started = session.start()
      session.stop()
      answer(boot('t1'))
      await jest.advanceTimersByTimeAsync(HOUR * MS)

      expect(await started).toBeNull()
      expect(socket.handlers.size).toBe(0)
      expect(bootstrap).toHaveBeenCalledTimes(1)
    })

    it('does nothing after the session was stopped', async () => {
      const bootstrap = jest.fn().mockResolvedValue(boot('t1'))
      const { session, socket } = setup({ bootstrap })
      await session.start()

      session.stop()
      await jest.advanceTimersByTimeAsync(HOUR * MS)

      expect(bootstrap).toHaveBeenCalledTimes(1)
      expect(socket.disconnects).toBe(1)
    })
  })

  describe('sending', () => {
    it('shows the message at once and marks it sent when the api takes it', async () => {
      const send = jest.fn().mockResolvedValue(undefined)
      const { session, log } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()

      await session.send('hola')

      expect(send).toHaveBeenCalledWith('t1', 'id-1', 'hola')
      expect(log.find('id-1')?.state).toBe('sent')
      session.stop()
    })

    it('begins another session and sends again when the token had ended', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(401, 'WIDGET_TOKEN_INVALID'))
        .mockResolvedValue(undefined)
      const bootstrap = jest
        .fn()
        .mockResolvedValueOnce(boot('t1'))
        .mockResolvedValueOnce(boot('t2'))
      const { session, log } = setup({ bootstrap, send })
      await session.start()

      await session.send('hola')

      expect(send).toHaveBeenNthCalledWith(2, 't2', 'id-1', 'hola')
      expect(log.find('id-1')?.state).toBe('sent')
      session.stop()
    })

    it('marks a message that could not go as failed, and sends it again with the same id', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(0, null))
        .mockResolvedValue(undefined)
      const { session, log } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()

      await session.send('hola')
      expect(log.find('id-1')?.state).toBe('failed')
      await session.retry('id-1')

      expect(send).toHaveBeenLastCalledWith('t1', 'id-1', 'hola')
      expect(log.find('id-1')?.state).toBe('sent')
      session.stop()
    })

    it('does not send again a message that is not failed', async () => {
      const send = jest.fn().mockResolvedValue(undefined)
      const { session } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()
      await session.send('hola')

      await session.retry('id-1')
      await session.retry('nope')

      expect(send).toHaveBeenCalledTimes(1)
      session.stop()
    })
  })
})
