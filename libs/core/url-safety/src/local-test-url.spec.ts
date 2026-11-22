import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  allowLocalCommandsUrl,
  commandsExchange,
  isAcceptableCommandsUrl,
  isLoopbackUrl,
  localCommandsUrlAllowed
} from './local-test-url'
import { PinnedExchangeFailed, PinnedExchangeReasons } from './pinned-https-exchange'
import { UnsafeUrlError } from './public-url'

type Setting = { nodeEnv: string; flag: boolean }
const ON: Setting = { nodeEnv: 'test', flag: true }
const OFF_CASES: [string, Setting | null][] = [
  ['production with the switch', { nodeEnv: 'production', flag: true }],
  ['staging with the switch', { nodeEnv: 'staging', flag: true }],
  ['development with the switch', { nodeEnv: 'development', flag: true }],
  ['test with the switch off', { nodeEnv: 'test', flag: false }],
  ['a process never configured', null]
]
const configure = (setting: Setting | null): void => {
  allowLocalCommandsUrl(setting ?? { nodeEnv: 'test', flag: false })
}
const OPTIONS = {
  body: '{}',
  headers: { 'content-type': 'application/json' },
  timeoutMs: 2000,
  maxResponseBytes: 1024,
  anyStatus: true
}

describe('the switch that lets a channel plugin answer on this machine (tests only)', () => {
  afterEach(() => {
    configure(null)
  })

  describe('localCommandsUrlAllowed', () => {
    it('is off until the process is configured', () => {
      expect(localCommandsUrlAllowed()).toBe(false)
    })

    it('is on only for NODE_ENV=test with the switch on', () => {
      configure(ON)
      expect(localCommandsUrlAllowed()).toBe(true)
    })

    it.each(OFF_CASES)('is off with %s', (_name, setting) => {
      configure(ON)
      configure(setting)
      expect(localCommandsUrlAllowed()).toBe(false)
    })
  })

  describe('isLoopbackUrl', () => {
    it.each([
      'http://localhost:4000/commands',
      'http://127.0.0.1:4000/c',
      'http://[::1]:4000/c',
      'http://LOCALHOST:4000/c'
    ])('is this machine: %s', raw => {
      expect(isLoopbackUrl(raw)).toBe(true)
    })

    it.each([
      'http://10.0.0.5/c',
      'http://192.168.1.2/c',
      'http://169.254.169.254/latest',
      'http://0.0.0.0/c',
      'http://127.0.0.2/c',
      'http://localhost.evil.example.com/c',
      'http://user:pass@localhost/c',
      'ftp://localhost/c',
      'https://localhost/c',
      'https://127.0.0.1:5432/',
      'not a url'
    ])('is not this machine: %s', raw => {
      expect(isLoopbackUrl(raw)).toBe(false)
    })
  })

  describe('isAcceptableCommandsUrl', () => {
    it('accepts an address on this machine only with the switch on', () => {
      configure(ON)
      expect(isAcceptableCommandsUrl('http://localhost:4000/c')).toBe(true)
      expect(isAcceptableCommandsUrl('http://127.0.0.1:4000/c')).toBe(true)
    })

    it.each(OFF_CASES)('keeps refusing an address on this machine in %s', (_name, setting) => {
      configure(setting)
      expect(isAcceptableCommandsUrl('http://localhost:4000/c')).toBe(false)
      expect(isAcceptableCommandsUrl('http://127.0.0.1/c')).toBe(false)
      expect(isAcceptableCommandsUrl('https://localhost/c')).toBe(false)
    })

    it('never opens a private network, with the switch on', () => {
      configure(ON)
      for (const raw of [
        'http://10.0.0.5/c',
        'https://10.0.0.5/c',
        'http://169.254.169.254/latest',
        'http://192.168.0.1/c'
      ]) {
        expect(isAcceptableCommandsUrl(raw)).toBe(false)
      }
    })

    it('accepts a public https address in every environment', () => {
      expect(isAcceptableCommandsUrl('https://plugin.example.com/commands')).toBe(true)
      configure(ON)
      expect(isAcceptableCommandsUrl('https://plugin.example.com/commands')).toBe(true)
    })
  })

  describe('commandsExchange', () => {
    let server: Server
    let seen: { method?: string; url?: string; body: string; signature?: string }
    let port = 0

    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          seen = {
            method: req.method,
            url: req.url,
            body: Buffer.concat(chunks).toString('utf8'),
            signature: req.headers['x-test-signature'] as string | undefined
          }
          if (req.url === '/redirect') {
            res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end()
            return
          }
          res.writeHead(req.url === '/refused' ? 422 : 200, { 'content-type': 'application/json' })
          res.end(req.url === '/big' ? 'x'.repeat(5000) : '{"ok":true}')
        })
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })
    afterAll(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it('posts to a plugin on this machine with the switch on, and reads its answer', async () => {
      configure(ON)
      const result = await commandsExchange(`http://localhost:${port}/commands`, {
        ...OPTIONS,
        headers: { ...OPTIONS.headers, 'x-test-signature': 'sig' },
        body: '{"a":1}'
      })
      expect(result).toEqual({ status: 200, body: '{"ok":true}' })
      expect(seen).toMatchObject({
        method: 'POST',
        url: '/commands',
        body: '{"a":1}',
        signature: 'sig'
      })
    })

    it('returns the status and body of a refusal when the caller asks for any status', async () => {
      configure(ON)
      await expect(
        commandsExchange(`http://127.0.0.1:${port}/refused`, OPTIONS)
      ).resolves.toMatchObject({ status: 422 })
      await expect(
        commandsExchange(`http://127.0.0.1:${port}/refused`, { ...OPTIONS, anyStatus: false })
      ).rejects.toMatchObject({ reason: PinnedExchangeReasons.BAD_STATUS, status: 422 })
    })

    it('follows no redirect and reads an answer up to the ceiling only', async () => {
      configure(ON)
      await expect(
        commandsExchange(`http://127.0.0.1:${port}/redirect`, OPTIONS)
      ).resolves.toMatchObject({ status: 302 })
      await expect(commandsExchange(`http://127.0.0.1:${port}/big`, OPTIONS)).rejects.toMatchObject(
        { reason: PinnedExchangeReasons.TOO_LARGE }
      )
    })

    it('resolves with an empty body, without reading the answer, when the caller discards it', async () => {
      configure(ON)
      await expect(
        commandsExchange(`http://127.0.0.1:${port}/big`, {
          body: OPTIONS.body,
          headers: OPTIONS.headers,
          timeoutMs: OPTIONS.timeoutMs,
          discardBody: true
        })
      ).resolves.toEqual({ status: 200, body: '' })
    })

    it('fails as a plugin that does not answer when nothing listens', async () => {
      configure(ON)
      await expect(commandsExchange('http://127.0.0.1:1/commands', OPTIONS)).rejects.toBeInstanceOf(
        PinnedExchangeFailed
      )
    })

    it.each(OFF_CASES)(
      'refuses an address on this machine in %s, and sends nothing',
      async (_name, setting) => {
        configure(setting)
        seen = { body: 'untouched' }
        await expect(
          commandsExchange(`http://127.0.0.1:${port}/commands`, OPTIONS)
        ).rejects.toBeInstanceOf(UnsafeUrlError)
        await expect(
          commandsExchange(`https://localhost:${port}/commands`, OPTIONS)
        ).rejects.toBeInstanceOf(UnsafeUrlError)
        expect(seen.body).toBe('untouched')
      }
    )

    it('does not reach a private network address with the switch on', async () => {
      configure(ON)
      await expect(commandsExchange('http://10.0.0.5/commands', OPTIONS)).rejects.toBeInstanceOf(
        UnsafeUrlError
      )
      await expect(
        commandsExchange('http://169.254.169.254/latest', OPTIONS)
      ).rejects.toBeInstanceOf(UnsafeUrlError)
    })
  })
})
