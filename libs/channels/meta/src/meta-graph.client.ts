import { Readable } from 'node:stream'

import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaGraph, type MetaGraphOrigin, MetaLimits, MetaWebhook } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type FetchedMedia, PluginError } from '@platform/plugins/sdk'

import { graphFailure, graphFileFailure, graphUnexpected, graphUnreachable } from './graph-failure'
import { limitBytes } from './limit-bytes'
import { MetaAppConfig } from './meta-app-config'
import { answerMetaHandshake, isValidMetaSignature } from './meta-webhook'

// An id or an edge name: letters, digits, underscore, dash. No dot, so no `..`, and no slash.
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
// A media id is a number. Any other segment would let an id from a webhook read another Graph node
// (`me`, `debug_token`) with the connection's token.
// 302 is class 3: a redirect
const STATUS_CLASS = 100
const REDIRECT_CLASS = 3
const MEDIA_ID = /^\d+$/
// What can go into a header value: printable ASCII
const HEADER_TOKEN = /^[\x21-\x7E]+$/

const mediaInfoSchema = z.object({
  url: z.url(),
  mime_type: z.string().min(1),
  file_size: z.number().int().nonnegative().optional()
})

export interface GraphRequest<T> {
  // ['123456', 'messages'] is /123456/messages
  path: readonly string[]
  token: string
  schema: z.ZodType<T>
  query?: Record<string, string>
  body?: unknown
  // A POST that changes nothing the second time (a subscription, a read receipt) may be tried again
  idempotent?: boolean
  // Facebook's Graph unless said otherwise. Instagram Login tokens only work on Instagram's.
  origin?: MetaGraphOrigin
}

// The calls and checks the three Meta plugins share. The token is the connection's and arrives per
// call; the app secret and the verify token belong to the platform's one Meta app.
@Injectable()
export class MetaGraphClient {
  constructor(private readonly config: MetaAppConfig) {}

  isValidSignature(rawBody: string, headers: Record<string, string>): boolean {
    return isValidMetaSignature(
      rawBody,
      headers[MetaWebhook.SIGNATURE_HEADER],
      this.config.appSecret
    )
  }

  verifyHubChallenge(query: Record<string, string>): string | null {
    return answerMetaHandshake(query, this.config.verifyToken)
  }

  async get<T>(request: GraphRequest<T>): Promise<T> {
    return this.call('GET', request)
  }

  async post<T>(request: GraphRequest<T>): Promise<T> {
    return this.call('POST', request)
  }

  // GET /{media-id} answers a short-lived url; the file is behind it and wants the same token. The url
  // is Meta's word, so it is only followed to a Meta host over https, and a file bigger than the limit
  // is cut off instead of being read to the end.
  async downloadMedia(token: string, mediaId: string): Promise<FetchedMedia> {
    if (!MEDIA_ID.test(mediaId)) throw graphUnexpected()
    const info = await this.get({ path: [mediaId], token, schema: mediaInfoSchema })
    // The type is the one Meta declared in its authenticated answer, not the one the file server sends
    return this.downloadFile(info.url, token, info.file_size, info.mime_type)
  }

  // Messenger and Instagram put the url of the file in the webhook itself. It is a link of a Meta CDN
  // that needs no token, so none is sent; the type is the one the file server declares, because Meta
  // does not vouch for it here.
  async downloadMediaUrl(url: string): Promise<FetchedMedia> {
    return this.downloadFile(url, undefined, undefined, undefined)
  }

  private async downloadFile(
    url: string,
    token: string | undefined,
    declaredSize: number | undefined,
    declaredType: string | undefined
  ): Promise<FetchedMedia> {
    const target = parseUrl(url)
    if (!target || !isMetaMediaUrl(target)) throw graphUnexpected()
    if ((declaredSize ?? 0) > MetaLimits.MEDIA_MAX_BYTES) throw graphUnexpected()

    const response = await this.fetchOrFail(url, {
      method: 'GET',
      headers: {
        // Uncompressed, so that content-length is the length of the file and a cut-off one shows
        'accept-encoding': 'identity',
        // The token goes only where it is needed
        ...(token && MetaGraph.MEDIA_TOKEN_HOSTS.some(host => host === target.hostname)
          ? { authorization: `Bearer ${token}` }
          : {})
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(MetaLimits.MEDIA_TIMEOUT_MS)
    })
    if (!response.ok) {
      await discard(response)
      throw graphFileFailure(response.status)
    }
    // With a content-encoding the length is the compressed one, not the length of the stream
    const length = response.headers.has('content-encoding')
      ? null
      : parseLength(response.headers.get('content-length'))
    if (!response.body || (length ?? 0) > MetaLimits.MEDIA_MAX_BYTES) {
      await discard(response)
      throw graphUnexpected()
    }

    const source = Readable.fromWeb(response.body)
    return {
      stream: limitBytes(source, MetaLimits.MEDIA_MAX_BYTES, length),
      contentType: declaredType ?? mediaTypeOf(response.headers.get('content-type')),
      contentLength: length
    }
  }

  private async call<T>(method: 'GET' | 'POST', request: GraphRequest<T>): Promise<T> {
    // A token that cannot be a header makes fetch throw before any call, and it never will work
    if (!HEADER_TOKEN.test(request.token)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
    }
    const url = this.urlFor(request.origin ?? MetaGraph.ORIGIN, request.path, request.query)
    const safeToRepeat = method === 'GET' || request.idempotent === true
    const response = await this.fetchOrFail(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${request.token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(MetaLimits.REQUEST_TIMEOUT_MS)
      },
      safeToRepeat
    )
    const body = await readJson(response)
    if (!response.ok) throw graphFailure(response.status, body, { safeToRepeat })
    // A 2xx whose body cannot be read: a read can be asked again, a send may already have gone out
    if (body === undefined) throw graphUnreachable({ safeToRepeat })
    const parsed = request.schema.safeParse(body)
    if (!parsed.success) throw graphUnexpected()
    return parsed.data
  }

  private urlFor(
    origin: MetaGraphOrigin,
    path: readonly string[],
    query: Record<string, string> | undefined
  ): string {
    if (path.length === 0 || !path.every(segment => PATH_SEGMENT.test(segment))) {
      throw graphUnexpected()
    }
    const base = `${origin}/${this.config.graphVersion}/${path.join('/')}`
    return query ? `${base}?${new URLSearchParams(query).toString()}` : base
  }

  // A redirect is never followed: neither Graph nor a media host has a reason to send one, and the
  // token would travel with it. It is not retried either, the same call would be sent away again.
  private async fetchOrFail(
    url: string,
    init: RequestInit,
    safeToRepeat = true
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      throw graphUnreachable({ safeToRepeat })
    }
    if (Math.floor(response.status / STATUS_CLASS) === REDIRECT_CLASS) {
      await discard(response)
      throw graphUnexpected()
    }
    return response
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// `image/jpeg; charset=binary` is `image/jpeg`; a missing or odd type is plain bytes
function mediaTypeOf(header: string | null): string {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : MetaGraph.FALLBACK_CONTENT_TYPE
}

function isMetaMediaUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (MetaGraph.MEDIA_TOKEN_HOSTS.some(host => host === url.hostname) ||
      MetaGraph.MEDIA_CDN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix)))
  )
}

// An answer that is refused is not read; closing it frees the connection
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

// `undefined` when the body cannot be read or is not json; an answer of `null` is a body
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function parseLength(header: string | null): number | null {
  // Number() takes '', ' ', '0x10' and '1e3'; a byte count is only digits
  if (header === null || !/^\d+$/.test(header)) return null
  const length = Number(header)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}
