import { Agent, request as httpRequest } from 'node:http'

import { errorCodeOf } from './pinned-errors'
import {
  PinnedExchangeFailed,
  PinnedExchangeReasons,
  assertAnswerReading,
  type PinnedExchangeOptions,
  type PinnedExchangeResult,
  pinnedHttpsExchange
} from './pinned-https-exchange'
import { isWellFormedPublicHttpsUrl, UnsafeUrlError } from './public-url'

const TEST_ENVIRONMENT = 'test'
// The machine itself and nothing else: no private network, no name that resolves somewhere (`localhost` is connected as 127.0.0.1)
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

// A channel plugin of the suites listens on this machine over http, which the rule of the public internet refuses (TDD_10 §6.7).
// The switch is off until the process is configured (`PLUGIN_ALLOW_LOCAL_COMMANDS_URL`, read from the validated environment when the
// plugins module is built), and it turns on only for NODE_ENV=test: the environment schema refuses the variable anywhere else (the
// process does not start), and this setter asks for the test environment again, so no caller can turn it on in another one.
let localCommandsUrlOn = false

export function allowLocalCommandsUrl(input: { nodeEnv: string; flag: boolean }): void {
  localCommandsUrlOn = input.nodeEnv === TEST_ENVIRONMENT && input.flag
}

export function localCommandsUrlAllowed(): boolean {
  return localCommandsUrlOn
}

// An address on this machine: plain http (the suites' plugin has no certificate to check), no credentials, the name of the machine or a
// loopback literal, any port
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''))
}

// The check of a `commandsUrl`: a public https address always; an address on this machine only where the switch allows it
export function isAcceptableCommandsUrl(raw: string): boolean {
  return isWellFormedPublicHttpsUrl(raw) || (localCommandsUrlOn && isLoopbackUrl(raw))
}

// The exchange of a channel plugin: `pinnedHttpsExchange` for every address, except an address on this machine where the switch allows
// it, which is called directly (no redirect, one budget, an answer read up to a ceiling, as the pinned one does). With the switch off
// an address on this machine reaches `pinnedHttpsExchange`, which refuses it as not public.
export async function commandsExchange(
  raw: string,
  options: PinnedExchangeOptions
): Promise<PinnedExchangeResult> {
  if (!(localCommandsUrlOn && isLoopbackUrl(raw))) {
    return pinnedHttpsExchange(raw, options)
  }
  return loopbackExchange(new URL(raw), options)
}

function loopbackExchange(url: URL, options: PinnedExchangeOptions): Promise<PinnedExchangeResult> {
  if (!isLoopbackUrl(url.href)) throw new UnsafeUrlError('not on this machine')
  assertAnswerReading(options)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const payload = Buffer.from(options.body, 'utf8')
  return new Promise<PinnedExchangeResult>((resolve, reject) => {
    let settled = false
    const timers: { deadline?: NodeJS.Timeout } = {}
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timers.deadline)
      settle()
    }
    let req: ReturnType<typeof httpRequest>
    try {
      req = httpRequest({
        hostname: host === 'localhost' ? '127.0.0.1' : host,
        port: url.port === '' ? 80 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...options.headers, 'content-length': String(payload.length) },
        // A socket of its own, as the pinned exchange opens: a pooled one the plugin closed would fail the call
        agent: new Agent({ keepAlive: false }),
        timeout: options.timeoutMs
      })
    } catch {
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.REQUEST_REFUSED))
      return
    }
    timers.deadline = setTimeout(() => {
      req.destroy(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    }, options.timeoutMs)
    req.on('timeout', () => {
      req.destroy(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    })
    req.on('error', (error: Error) => {
      finish(() => {
        reject(
          error instanceof PinnedExchangeFailed
            ? error
            : new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:${errorCodeOf(error)}`)
        )
      })
    })
    req.on('response', response => {
      const status = response.statusCode ?? 0
      if (options.anyStatus !== true && (status < 200 || status >= 300)) {
        response.resume()
        finish(() => {
          reject(new PinnedExchangeFailed(PinnedExchangeReasons.BAD_STATUS, status))
        })
        req.destroy()
        return
      }
      if (options.discardBody) {
        response.resume()
        finish(() => {
          resolve({ status, body: '' })
        })
        req.destroy()
        return
      }
      const maxBytes = options.maxResponseBytes
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          finish(() => {
            reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_LARGE, status))
          })
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish(() => {
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') })
        })
      })
      response.on('error', () => {
        finish(() => {
          reject(new PinnedExchangeFailed(PinnedExchangeReasons.NO_ANSWER, status))
        })
      })
    })
    req.end(payload)
  })
}
