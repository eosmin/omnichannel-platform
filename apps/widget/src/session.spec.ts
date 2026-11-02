import { WidgetClientEvents, WidgetLimits, WidgetSocketEvents } from '@platform/core/domain'

import { WidgetApiError, type WidgetApi } from './api'
import { ChatLog } from './chat-log'
import { Session, type SessionDeps, type VisitorSocket } from './session'
import type { Bootstrap, ServerMessage } from './types'

const MS = 1000
const HOUR = 3600

function boot(token: string, overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    visitorToken: token,
    expiresInSeconds: HOUR,
    store: { name: 'Shop', locale: 'es' },
    away: false,
    preChat: false,
    messages: [],
    readUpToMessageId: null,
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
  // What the server pushes
  receive(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args)
  }
  // What the visitor's widget sends
  readonly sent: string[] = []
  connected = true
  emit(event: string): void {
    this.sent.push(event)
  }
}

function setup(
  api: Partial<jest.Mocked<Pick<WidgetApi, 'bootstrap' | 'send' | 'requestUpload' | 'fileLink'>>>,
  onProfileSent?: () => void,
  extra: Partial<SessionDeps> = {}
) {
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
    newMessageId: () => `id-${(ids += 1)}`,
    ...(onProfileSent === undefined ? {} : { onProfileSent }),
    ...extra
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
          messages: [{ id: 'm1', from: 'team', content: 'hola', attachments: [], createdAt: 'd' }]
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

      socket.receive('widget.message', {
        id: 'r1',
        from: 'team',
        content: 'hola',
        attachments: [],
        createdAt: 'd'
      })
      socket.receive('widget.message', { nonsense: true })

      expect(log.messages.map(message => message.content)).toEqual(['hola'])
      session.stop()
    })
  })

  describe('typing', () => {
    it('tells the server the visitor types, at most once in the gap, and only on a live socket', async () => {
      const { session, socket } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')) })
      await session.start()

      session.typing()
      session.typing()
      await jest.advanceTimersByTimeAsync(WidgetLimits.CUSTOMER_TYPING_GAP_MS)
      session.typing()
      socket.connected = false
      await jest.advanceTimersByTimeAsync(WidgetLimits.CUSTOMER_TYPING_GAP_MS)
      session.typing()

      expect(socket.sent).toEqual([WidgetClientEvents.TYPING, WidgetClientEvents.TYPING])
      session.stop()
    })

    it('shows the team typing, until a stop, a reply or the lapse', async () => {
      const { session, socket } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')) })
      const states: boolean[] = []
      session.onAgentTyping(active => states.push(active))
      await session.start()

      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: true })
      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: false })
      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: true })
      socket.receive('widget.message', {
        id: 'r1',
        from: 'team',
        content: 'hola',
        attachments: [],
        createdAt: 'd'
      })
      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: true })
      await jest.advanceTimersByTimeAsync(WidgetLimits.AGENT_TYPING_LAPSE_MS)
      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: 'yes' })
      socket.receive(WidgetSocketEvents.AGENT_TYPING, null)

      expect(states).toEqual([true, false, true, false, true, false])
      session.stop()
    })

    it('ignores a start of the team after the session stopped', async () => {
      const { session, socket } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')) })
      const states: boolean[] = []
      session.onAgentTyping(active => states.push(active))
      await session.start()
      session.stop()

      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: true })

      expect(states).toEqual([])
    })

    it('lets the indicator go when the socket goes', async () => {
      const { session, socket } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')) })
      const states: boolean[] = []
      session.onAgentTyping(active => states.push(active))
      await session.start()

      socket.receive(WidgetSocketEvents.AGENT_TYPING, { active: true })
      socket.receive('disconnect', 'transport close')

      expect(states).toEqual([true, false])
      session.stop()
    })
  })

  describe('read receipts', () => {
    it('marks the messages of the visitor up to the one the agent read', async () => {
      const history: ServerMessage[] = [
        {
          id: 'a',
          from: 'visitor',
          content: '1',
          attachments: [],
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'b',
          from: 'team',
          content: '2',
          attachments: [],
          createdAt: '2026-01-01T00:00:01.000Z'
        },
        {
          id: 'c',
          from: 'visitor',
          content: '3',
          attachments: [],
          createdAt: '2026-01-01T00:00:02.000Z'
        }
      ]
      const { session, log, socket } = setup({
        bootstrap: jest.fn().mockResolvedValue(boot('t1', { messages: [...history] }))
      })
      await session.start()

      socket.receive(WidgetSocketEvents.READ, { messageId: 'a' })
      socket.receive(WidgetSocketEvents.READ, { nonsense: true })

      expect(log.messages.map(message => message.seen)).toEqual([true, false, false])
      session.stop()
    })

    it('marks nothing when the message that was read is older than the history it loaded', async () => {
      const history: ServerMessage[] = [
        {
          id: 'c',
          from: 'visitor',
          content: '3',
          attachments: [],
          createdAt: '2026-01-01T00:00:02.000Z'
        }
      ] as const
      const { session, log } = setup({
        bootstrap: jest
          .fn()
          .mockResolvedValue(boot('t1', { messages: [...history], readUpToMessageId: 'gone' }))
      })

      await session.start()

      expect(log.messages.map(message => message.seen)).toEqual([false])
      session.stop()
    })

    it('shows as seen what an agent read before the page was opened', async () => {
      const history: ServerMessage[] = [
        {
          id: 'a',
          from: 'visitor',
          content: '1',
          attachments: [],
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'b',
          from: 'team',
          content: '2',
          attachments: [],
          createdAt: '2026-01-01T00:00:01.000Z'
        },
        {
          id: 'c',
          from: 'visitor',
          content: '3',
          attachments: [],
          createdAt: '2026-01-01T00:00:02.000Z'
        }
      ] as const
      const { session, log } = setup({
        bootstrap: jest
          .fn()
          .mockResolvedValue(boot('t1', { messages: [...history], readUpToMessageId: 'a' }))
      })

      await session.start()

      expect(log.messages.map(message => message.seen)).toEqual([true, false, false])
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

      socket.receive('disconnect', 'io server disconnect')
      await jest.advanceTimersByTimeAsync(0)

      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(socket.connects).toBe(1)
      session.stop()
    })

    it('is asked for again, and the socket connected, when the handshake says it is not valid and not for another refusal', async () => {
      const bootstrap = jest.fn().mockResolvedValue(boot('t1'))
      const { session, socket } = setup({ bootstrap })
      await session.start()

      socket.receive('connect_error', { data: { code: 'RATE_LIMIT_EXCEEDED' } })
      expect(bootstrap).toHaveBeenCalledTimes(1)
      socket.receive('connect_error', { data: { code: 'WIDGET_TOKEN_INVALID' } })
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

      expect(send).toHaveBeenCalledWith('t1', 'id-1', 'hola', undefined, [])
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

      expect(send).toHaveBeenNthCalledWith(2, 't2', 'id-1', 'hola', undefined, [])
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

      expect(send).toHaveBeenLastCalledWith('t1', 'id-1', 'hola', undefined, [])
      expect(log.find('id-1')?.state).toBe('sent')
      session.stop()
    })

    it('sends what the visitor typed in the form with the first message only', async () => {
      const send = jest.fn().mockResolvedValue(undefined)
      const { session } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()

      session.setProfile({ name: 'Ana', email: 'ana@example.com' })
      await session.send('hola')
      await session.send('otra')

      expect(send).toHaveBeenNthCalledWith(
        1,
        't1',
        'id-1',
        'hola',
        {
          name: 'Ana',
          email: 'ana@example.com'
        },
        []
      )
      expect(send).toHaveBeenNthCalledWith(2, 't1', 'id-2', 'otra', undefined, [])
      session.stop()
    })

    it('keeps the profile for the next message when the first one could not go', async () => {
      const send = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(0, null))
        .mockResolvedValue(undefined)
      const { session } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()

      session.setProfile({ name: 'Ana' })
      await session.send('hola')
      await session.retry('id-1')

      expect(send).toHaveBeenLastCalledWith('t1', 'id-1', 'hola', { name: 'Ana' }, [])
      session.stop()
    })

    it('says when the api took the profile, and not when the message failed', async () => {
      const onProfileSent = jest.fn()
      const send = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(0, null))
        .mockResolvedValue(undefined)
      const { session } = setup(
        { bootstrap: jest.fn().mockResolvedValue(boot('t1')), send },
        onProfileSent
      )
      await session.start()

      session.setProfile({ name: 'Ana' })
      await session.send('hola')
      expect(onProfileSent).not.toHaveBeenCalled()
      await session.retry('id-1')

      expect(onProfileSent).toHaveBeenCalledTimes(1)
      session.stop()
    })

    it('sends no profile for a form that was left blank', async () => {
      const send = jest.fn().mockResolvedValue(undefined)
      const { session } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()

      session.setProfile({})
      await session.send('hola')

      expect(send).toHaveBeenCalledWith('t1', 'id-1', 'hola', undefined, [])
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
  describe('files', () => {
    const file = (name: string): File => new File(['x'], name, { type: 'image/png' })
    const slot = (n: number) => ({ uploadUrl: `https://bucket.test/${n}`, uploadId: `up-${n}` })

    it('puts the files up, then sends the message naming them, with the text as caption', async () => {
      const requestUpload = jest.fn().mockResolvedValueOnce(slot(1)).mockResolvedValueOnce(slot(2))
      const send = jest.fn().mockResolvedValue(undefined)
      const uploadFile = jest.fn(
        (_url: string, _file: Blob, _type: string, progress: (f: number) => void) => {
          progress(0.5)
          return Promise.resolve()
        }
      )
      const { session, log } = setup(
        { bootstrap: jest.fn().mockResolvedValue(boot('t1')), requestUpload, send },
        undefined,
        { uploadFile }
      )
      await session.start()

      await session.send('mira', [file('a.png'), file('b.png')])

      expect(requestUpload).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'a.png' }))
      expect(uploadFile).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledWith('t1', 'id-1', 'mira', undefined, ['up-1', 'up-2'])
      expect(log.find('id-1')?.state).toBe('sent')
      expect(log.find('id-1')?.progress).toBeNull()
      expect(log.find('id-1')?.attachments.map(item => item.filename)).toEqual(['a.png', 'b.png'])
      session.stop()
    })

    it('reports how much of all the files has gone up', async () => {
      const seen: (number | null | undefined)[] = []
      const holder: { log?: ChatLog } = {}
      const uploadFile = jest.fn(
        (_u: string, _f: Blob, _t: string, progress: (f: number) => void) => {
          progress(0.5)
          seen.push(holder.log?.find('id-1')?.progress)
          return Promise.resolve()
        }
      )
      const made = setup(
        {
          bootstrap: jest.fn().mockResolvedValue(boot('t1')),
          requestUpload: jest.fn().mockResolvedValueOnce(slot(1)).mockResolvedValueOnce(slot(2)),
          send: jest.fn().mockResolvedValue(undefined)
        },
        undefined,
        { uploadFile }
      )
      holder.log = made.log
      await made.session.start()

      await made.session.send('', [file('a.png'), file('b.png')])

      expect(seen).toEqual([0.25, 0.75])
      made.session.stop()
    })

    it('puts up on retry only the files that are not up, under the same message id', async () => {
      const requestUpload = jest
        .fn()
        .mockResolvedValueOnce(slot(1))
        .mockResolvedValueOnce(slot(2))
        .mockResolvedValueOnce(slot(3))
      const uploadFile = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValue(undefined)
      const send = jest.fn().mockResolvedValue(undefined)
      const { session, log } = setup(
        { bootstrap: jest.fn().mockResolvedValue(boot('t1')), requestUpload, send },
        undefined,
        { uploadFile }
      )
      await session.start()

      await session.send('', [file('a.png'), file('b.png')])
      expect(log.find('id-1')?.state).toBe('failed')
      expect(send).not.toHaveBeenCalled()
      await session.retry('id-1')

      // The first file stays up; only the second asks for a new url
      expect(requestUpload).toHaveBeenCalledTimes(3)
      expect(send).toHaveBeenCalledWith('t1', 'id-1', '', undefined, ['up-1', 'up-3'])
      session.stop()
    })

    it('puts the files up again when the api no longer vouches for them', async () => {
      const requestUpload = jest.fn().mockResolvedValueOnce(slot(1)).mockResolvedValueOnce(slot(2))
      const send = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(400, 'FILE_UPLOAD_FAILED'))
        .mockResolvedValue(undefined)
      const { session } = setup(
        { bootstrap: jest.fn().mockResolvedValue(boot('t1')), requestUpload, send },
        undefined,
        { uploadFile: jest.fn().mockResolvedValue(undefined) }
      )
      await session.start()

      await session.send('', [file('a.png')])
      await session.retry('id-1')

      expect(requestUpload).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenLastCalledWith('t1', 'id-1', '', undefined, ['up-2'])
      session.stop()
    })

    it('asks for the link of a file with the token of now, and renews it once if it ended', async () => {
      const fileLink = jest
        .fn()
        .mockRejectedValueOnce(new WidgetApiError(401, 'WIDGET_TOKEN_INVALID'))
        .mockResolvedValue({
          url: 'https://x',
          filename: 'a',
          contentType: 'image/png',
          previewUrl: null
        })
      const bootstrap = jest
        .fn()
        .mockResolvedValueOnce(boot('t1'))
        .mockResolvedValueOnce(boot('t2'))
      const { session } = setup({ bootstrap, fileLink })
      await session.start()

      const link = await session.fileLink('media-1')

      expect(link.url).toBe('https://x')
      expect(fileLink).toHaveBeenNthCalledWith(1, 't1', 'media-1')
      expect(fileLink).toHaveBeenNthCalledWith(2, 't2', 'media-1')
      session.stop()
    })
  })

  describe('a phone the api cannot read', () => {
    const refusal = (): WidgetApiError =>
      new WidgetApiError(400, 'VALIDATION_FAILED', ['profile.phone'])

    it('queues a message once however many times it is refused', async () => {
      const send = jest.fn().mockRejectedValue(refusal())
      const { session } = setup({ bootstrap: jest.fn().mockResolvedValue(boot('t1')), send })
      await session.start()
      await session.send('hola')

      await session.retry('id-1')
      session.setProfile({})
      await jest.advanceTimersByTimeAsync(0)

      // One resend for the one queued key
      expect(send).toHaveBeenCalledTimes(3)
      session.stop()
    })

    it('tells the page, keeps the message and sends it with the corrected form', async () => {
      const send = jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValue(undefined)
      const onPhoneRefused = jest.fn()
      const { session, log } = setup(
        { bootstrap: jest.fn().mockResolvedValue(boot('t1')), send },
        undefined,
        { onPhoneRefused }
      )
      await session.start()
      session.setProfile({ name: 'Ana', phone: '123' })

      await session.send('hola')
      expect(onPhoneRefused).toHaveBeenCalledTimes(1)
      expect(log.find('id-1')?.state).toBe('failed')
      session.setProfile({ name: 'Ana', phone: '+52 55 1234 5678' })
      await jest.advanceTimersByTimeAsync(0)

      expect(send).toHaveBeenLastCalledWith(
        't1',
        'id-1',
        'hola',
        { name: 'Ana', phone: '+52 55 1234 5678' },
        []
      )
      expect(log.find('id-1')?.state).toBe('sent')
      session.stop()
    })
  })
})
