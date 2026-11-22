import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  RemoteChannelCommands,
  RemoteChannelErrorCodes,
  RemoteChannelHeaders,
  RemoteChannelLimits
} from '@platform/core/domain'
import {
  type PinnedExchangeOptions,
  type PinnedExchangeResult,
  PinnedExchangeFailed,
  PinnedExchangeReasons
} from '@platform/core/url-safety'
import { verifyRemoteCommand } from '@platform/plugins/runtime'

// The reference plugin of TDD_10 §6.7.9: the smallest service that does what a channel plugin has to do, and nothing of any
// provider. It is a plain HTTP server that checks the signature of every command as a plugin author must, keeps what it was
// told, answers the five commands, and says what the platform sent to it. A plugin author copies its shape.

export interface ReceivedCommand {
  command: string
  storeId: string
  connectionId: string
  data: Record<string, unknown>
  // The headers of the platform, as the plugin read them
  signature: string
  delivery: string
  idempotencyKey: string | null
  rawBody: string
}

// What the next request gets instead of the normal answer: how a test makes the plugin refuse, stall or hang up
export interface ScriptedAnswer {
  status?: number
  body?: unknown
  // Waits before answering, to be read as "slow" by a caller with a shorter deadline
  delayMs?: number
  // Closes the connection with no answer, after reading the request
  hangUp?: boolean
  // Answers with this many bytes of filler instead of a body
  oversizeBytes?: number
  // A `message.send` that the plugin DID take (its key is kept, the message exists) and then fails to say so: this status,
  // or 0 to hang up. It is the doubt a plugin must survive: the platform sends the same key again and gets the first message
  failAfterSendWith?: number
}

export interface ReferencePlugin {
  // Where the platform posts: `commandsUrl` of the manifest
  url: string
  received: ReceivedCommand[]
  // Requests that failed the signature check (nothing of them is kept)
  refused: number
  // Sends the plugin took a second time under the same idempotency key (it answers the first answer again)
  duplicates: number
  // The message each idempotency key made: one entry per key, however many times it came
  messages: ReadonlyMap<string, string>
  // The secrets it verifies with: one, or two while a rotation is open
  secrets: string[]
  // The next request is answered by this and not by the plugin
  script: (answer: ScriptedAnswer) => void
  // The clock the 5-minute window is read against, in milliseconds
  clock: { now: () => number }
  stop: () => Promise<void>
}

const MAX_BODY_BYTES = RemoteChannelLimits.MAX_REQUEST_BYTES

function readRaw(request: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // A body past the ceiling is not read to the end: the answer is a 413 and the connection closes
        resolve(null)
        ;(request as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', () => {
      resolve(null)
    })
  })
}

export async function startReferencePlugin(
  secrets: string[],
  clock: { now: () => number } = { now: () => Date.now() }
): Promise<ReferencePlugin> {
  const scripted: ScriptedAnswer[] = []
  const sends = new Map<string, string>()
  let counter = 0
  // One object, read and written by the server and by the test alike: a copy would count on its own
  const plugin: ReferencePlugin = {
    url: '',
    stop: () => Promise.resolve(),
    received: [],
    refused: 0,
    duplicates: 0,
    messages: sends,
    secrets,
    clock,
    script: answer => {
      scripted.push(answer)
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readRaw(request)
      const answer = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (raw === null) {
        answer(413, { error: { code: RemoteChannelErrorCodes.REJECTED } })
        return
      }
      const signature = String(request.headers[RemoteChannelHeaders.SIGNATURE] ?? '')
      // What every plugin does first: nothing is read from a command whose signature is not good
      if (
        !verifyRemoteCommand(signature, raw, plugin.secrets, Math.floor(plugin.clock.now() / 1000))
      ) {
        plugin.refused += 1
        answer(401, { error: { code: RemoteChannelErrorCodes.REJECTED } })
        return
      }
      const next = scripted.shift()
      if (next?.hangUp === true) {
        request.socket.destroy()
        return
      }
      if (next?.delayMs !== undefined) {
        await new Promise(resolve => setTimeout(resolve, next.delayMs))
      }
      if (next?.oversizeBytes !== undefined) {
        response.writeHead(next.status ?? 200, { 'content-type': 'application/json' })
        response.end('x'.repeat(next.oversizeBytes))
        return
      }
      let body: {
        command: string
        storeId: string
        connectionId: string
        data: Record<string, unknown>
      }
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        // Signed and still not JSON: a plugin answers it, it does not crash
        answer(400, { error: { code: RemoteChannelErrorCodes.REJECTED } })
        return
      }
      const idempotencyKey = request.headers[RemoteChannelHeaders.IDEMPOTENCY_KEY]
      plugin.received.push({
        command: body.command,
        storeId: body.storeId,
        connectionId: body.connectionId,
        data: body.data,
        signature,
        delivery: String(request.headers[RemoteChannelHeaders.DELIVERY] ?? ''),
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : null,
        rawBody: raw
      })
      if (next?.status !== undefined) {
        answer(next.status, next.body ?? {})
        return
      }
      switch (body.command) {
        case RemoteChannelCommands.MESSAGE_SEND: {
          // A send is idempotent: the same key is the same message, and the answer is the first one
          const key = typeof idempotencyKey === 'string' ? idempotencyKey : null
          const known = key === null ? undefined : sends.get(key)
          if (known !== undefined) {
            plugin.duplicates += 1
            answer(200, { externalId: known, status: 'sent' })
            return
          }
          counter += 1
          const externalId = `ref-${counter}`
          if (key !== null) sends.set(key, externalId)
          if (next?.failAfterSendWith === 0) {
            request.socket.destroy()
            return
          }
          if (next?.failAfterSendWith !== undefined) {
            answer(next.failAfterSendWith, {})
            return
          }
          answer(200, { externalId, status: 'sent' })
          return
        }
        case RemoteChannelCommands.CONNECTION_HEALTH:
          answer(200, { healthy: true })
          return
        case RemoteChannelCommands.TYPING_SEND:
        case RemoteChannelCommands.MESSAGE_MARK_READ:
        case RemoteChannelCommands.CONNECTION_DISCONNECT:
          answer(200, {})
          return
        default:
          answer(400, { error: { code: RemoteChannelErrorCodes.REJECTED } })
      }
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  plugin.url = `http://127.0.0.1:${port}/platform/commands`
  plugin.stop = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => {
        resolve()
      })
    })
  return plugin
}

// The exchange of the adapter, over the loopback: the same shape as `pinnedHttpsExchange` (the status and body of any answer,
// a ceiling on the answer, a deadline, a failure that names its reason) but to the plain HTTP address of the reference plugin,
// which the real one refuses because it is not public and not https. What it does not do is what the real one does and the
// unit specs of the adapter and of `pinnedHttpsExchange` prove: resolve, pin and refuse private addresses.
export function loopbackExchange(
  url: string,
  options: PinnedExchangeOptions
): Promise<PinnedExchangeResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers: options.headers, timeout: options.timeoutMs },
      response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxResponseBytes) {
            request.destroy()
            reject(
              new PinnedExchangeFailed(PinnedExchangeReasons.TOO_LARGE, response.statusCode ?? null)
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
        response.on('error', () => {
          reject(new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:ECONNRESET`))
        })
      }
    )
    request.on('timeout', () => {
      request.destroy()
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:${error.code ?? 'ECONNRESET'}`)
      )
    })
    request.end(options.body)
  })
}
