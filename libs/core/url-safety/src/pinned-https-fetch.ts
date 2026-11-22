import { Agent, request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { errorCodeOf } from './pinned-errors'
import {
  type HttpsRequester,
  PinnedExchangeFailed,
  PinnedExchangeReasons
} from './pinned-https-exchange'
import { pinnedLookup } from './pinned-lookup'
import {
  type HostResolver,
  type PublicTarget,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from './public-url'

const HTTPS_PORT = 443
const NO_ENCODING = 'identity'
const METHODS_WITH_BODY: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH'])
// What a caller never sets: where the request goes, how its body is framed, who is asking
const FORBIDDEN_HEADER =
  /^(host|content-length|connection|transfer-encoding|upgrade|expect|proxy-.*|cookie|accept-encoding|te|trailer)$/i

export interface PinnedFetchOptions {
  // One budget for the whole call (resolution, connection, answer)
  timeoutMs: number
  // The answer is read up to this many bytes; a longer one fails (an address that streams must not fill memory)
  maxResponseBytes: number
  // The address may name a port other than 443, from 1024 up (a carrier's gateway often listens on its own). The checked
  // address is still a public one, so the port only chooses a service of a public host; the well-known ports below 1024 stay out.
  allowCustomPort?: boolean
  resolve?: HostResolver
  // Replaceable so that a unit test needs no network
  request?: HttpsRequester
}

const MIN_STATUS = 200
const MAX_STATUS = 599
const FIRST_CUSTOM_PORT = 1024
const LAST_PORT = 65_535

// The port the address names and the address without it, which is what the check of a public https url takes
function portOf(raw: string, allowCustomPort: boolean): { port: number; checked: string } {
  if (!allowCustomPort) return { port: HTTPS_PORT, checked: raw }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { port: HTTPS_PORT, checked: raw }
  }
  if (url.port === '') return { port: HTTPS_PORT, checked: raw }
  const port = Number(url.port)
  if (port < FIRST_CUSTOM_PORT || port > LAST_PORT) return { port: HTTPS_PORT, checked: raw }
  url.port = ''
  return { port, checked: url.toString() }
}

export type PinnedFetch = (url: string, init?: RequestInit) => Promise<Response>

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    if (FORBIDDEN_HEADER.test(name)) {
      throw new TypeError(`the header ${name} cannot be set on a pinned request`)
    }
    out[name] = value
  })
  return out
}

// A `fetch` for an address a person typed (a carrier endpoint): plain https on the default port with no credentials, a public
// address resolved now and then the only one connected to (a host that changes its DNS answer after the check, or answers with
// a private address, is never connected to: rebinding), no redirect (the address of a redirect is a new one nobody has checked,
// so a 3xx is a failure and never followed), one budget for the whole call and an answer read up to a ceiling. The answer of any
// status is returned, for a caller that decides by it. An address that does not lead to the public internet throws
// UnsafeUrlError; any other failure is a PinnedExchangeFailed.
export function createPinnedFetch(options: PinnedFetchOptions): PinnedFetch {
  return async (raw, init) => {
    const signal = init?.signal ?? undefined
    // Nothing is resolved for a call that is already cancelled
    if (signal?.aborted === true) throw new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW)
    const startedAt = Date.now()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = headersOf(init)
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw new TypeError('a pinned request sends a text body only')
    }
    if (typeof body === 'string' && !METHODS_WITH_BODY.has(method)) {
      throw new TypeError(`a ${method} request carries no body`)
    }
    const { port, checked } = portOf(raw, options.allowCustomPort === true)

    let target: PublicTarget
    try {
      target = await withDeadline(
        resolvePublicHttpsUrl(checked, options.resolve),
        options.timeoutMs,
        signal
      )
    } catch (error) {
      if (error instanceof UnsafeUrlError || error instanceof PinnedExchangeFailed) throw error
      throw new PinnedExchangeFailed(`${PinnedExchangeReasons.NOT_RESOLVED}:${errorCodeOf(error)}`)
    }
    const { url, addresses } = target
    const remainingMs = Math.max(1, options.timeoutMs - (Date.now() - startedAt))
    const send = options.request ?? httpsRequest
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : undefined

    return new Promise<Response>((resolve, reject) => {
      let settled = false
      const timers: { deadline?: NodeJS.Timeout } = {}
      let req: ReturnType<HttpsRequester> | undefined
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timers.deadline)
        signal?.removeEventListener('abort', onAbort)
        settle()
      }
      const fail = (reason: string, status: number | null = null): void => {
        finish(() => {
          reject(new PinnedExchangeFailed(reason, status))
        })
        req?.destroy()
      }
      const onAbort = (): void => {
        fail(PinnedExchangeReasons.TOO_SLOW)
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        req = send({
          protocol: 'https:',
          hostname: host,
          port,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            ...headers,
            'accept-encoding': NO_ENCODING,
            ...(payload === undefined ? {} : { 'content-length': String(payload.length) })
          },
          // A socket of its own: a pooled one, opened for an earlier call, would not go through this lookup
          agent: new Agent({ keepAlive: false }),
          lookup: pinnedLookup(addresses),
          // The certificate is checked against the name of the address, not the address connected to
          ...(isIP(host) === 0 ? { servername: host } : {}),
          timeout: remainingMs
        })
      } catch {
        fail(PinnedExchangeReasons.REQUEST_REFUSED)
        return
      }
      timers.deadline = setTimeout(() => {
        fail(PinnedExchangeReasons.TOO_SLOW)
      }, remainingMs)
      req.on('timeout', () => {
        fail(PinnedExchangeReasons.TOO_SLOW)
      })
      req.on('error', (error: Error) => {
        finish(() => {
          reject(
            new PinnedExchangeFailed(`${PinnedExchangeReasons.NO_ANSWER}:${errorCodeOf(error)}`)
          )
        })
      })
      req.on('response', response => {
        const status = response.statusCode ?? 0
        // A status a Response cannot hold (1xx, or above 599) comes from a server that does not speak http: nothing to decide by
        if (status < MIN_STATUS || status > MAX_STATUS) {
          response.resume()
          fail(PinnedExchangeReasons.BAD_STATUS, status)
          return
        }
        // A redirect is not followed, and its target is never read
        if (status >= 300 && status < 400) {
          response.resume()
          fail(PinnedExchangeReasons.BAD_STATUS, status)
          return
        }
        const encoding = String(response.headers['content-encoding'] ?? NO_ENCODING)
          .trim()
          .toLowerCase()
        if (encoding !== '' && encoding !== NO_ENCODING) {
          response.resume()
          fail(PinnedExchangeReasons.REQUEST_REFUSED, status)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxResponseBytes) {
            fail(PinnedExchangeReasons.TOO_LARGE, status)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          finish(() => {
            const contentType = String(response.headers['content-type'] ?? '')
            // A body is not allowed on these statuses by the Response constructor
            const noBody = status === 204 || status === 205 || status === 304
            try {
              resolve(
                new Response(noBody ? null : Buffer.concat(chunks), {
                  status,
                  headers: contentType === '' ? {} : { 'content-type': contentType }
                })
              )
            } catch {
              reject(new PinnedExchangeFailed(PinnedExchangeReasons.NO_ANSWER, status))
            }
          })
        })
        response.on('error', () => {
          fail(PinnedExchangeReasons.NO_ANSWER, status)
        })
      })
      if (payload === undefined) req.end()
      else req.end(payload)
    })
  }
}

function withDeadline<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    }, ms)
    onAbort = () => {
      reject(new PinnedExchangeFailed(PinnedExchangeReasons.TOO_SLOW))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  })
}
