import { ChatLog } from './chat-log'
import type { ServerMessage } from './types'

const server = (id: string, from: 'visitor' | 'team', content: string): ServerMessage => ({
  id,
  from,
  content,
  createdAt: '2026-01-01T00:00:00.000Z'
})

describe('ChatLog', () => {
  it('shows the history the server gives', () => {
    const log = new ChatLog()

    log.loadHistory([server('1', 'visitor', 'hola'), server('2', 'team', 'buenas')])

    expect(log.messages.map(message => [message.from, message.content, message.state])).toEqual([
      ['visitor', 'hola', 'sent'],
      ['team', 'buenas', 'sent']
    ])
  })

  it('adds a reply once, even if it arrives twice or the history already holds it', () => {
    const log = new ChatLog()
    log.loadHistory([server('1', 'team', 'a')])

    log.addIncoming(server('1', 'team', 'a'))
    log.addIncoming(server('2', 'team', 'b'))
    log.addIncoming(server('2', 'team', 'b'))

    expect(log.messages.map(message => message.serverId)).toEqual(['1', '2'])
  })

  it('writes a message at once, as sending, and tells the listeners', () => {
    const log = new ChatLog()
    const heard = jest.fn()
    log.subscribe(heard)

    log.addOutgoing('k1', 'hola')
    log.setState('k1', 'failed')

    expect(log.find('k1')).toMatchObject({ content: 'hola', state: 'failed', serverId: null })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('stops telling a listener that unsubscribed', () => {
    const log = new ChatLog()
    const heard = jest.fn()

    log.subscribe(heard)()
    log.addOutgoing('k1', 'x')

    expect(heard).not.toHaveBeenCalled()
  })

  describe('when the history is read again', () => {
    it('does not show twice a message that was sent and has been stored', () => {
      const log = new ChatLog()
      log.addOutgoing('k1', 'hola')
      log.setState('k1', 'sent')

      log.loadHistory([server('1', 'visitor', 'hola')])

      expect(log.messages).toHaveLength(1)
      expect(log.messages[0]?.serverId).toBe('1')
    })

    it('keeps a message the worker has not stored yet, and one that failed', () => {
      const log = new ChatLog()
      log.addOutgoing('k1', 'en camino')
      log.setState('k1', 'sent')
      log.addOutgoing('k2', 'fallo')
      log.setState('k2', 'failed')

      log.loadHistory([server('1', 'team', 'hola')])

      expect(log.messages.map(message => message.content)).toEqual(['hola', 'en camino', 'fallo'])
    })

    it('matches two equal texts one by one', () => {
      const log = new ChatLog()
      for (const key of ['k1', 'k2']) {
        log.addOutgoing(key, 'ok')
        log.setState(key, 'sent')
      }

      log.loadHistory([server('1', 'visitor', 'ok')])

      expect(log.messages.map(message => message.serverId)).toEqual(['1', null])
    })
  })
  describe('when the history is read while something else arrives', () => {
    it('keeps a reply that the socket pushed after the history was cut', () => {
      const log = new ChatLog()
      log.addIncoming({ ...server('2', 'team', 'nuevo'), createdAt: '2026-01-02T00:00:00.000Z' })

      log.loadHistory([server('1', 'team', 'viejo')])

      expect(log.messages.map(message => message.serverId)).toEqual(['1', '2'])
    })

    it('does not take an old message of the same text for the one that was just sent', () => {
      const log = new ChatLog()
      log.loadHistory([server('1', 'visitor', 'hola')])
      log.addOutgoing('k1', 'hola')
      log.setState('k1', 'sent')

      log.loadHistory([server('1', 'visitor', 'hola')])

      expect(log.messages.map(message => message.serverId)).toEqual(['1', null])
    })
  })
})
