import type { z } from 'zod'

import { API_PREFIX } from '@platform/core/api'
import { TenantHeaders } from '@platform/core/auth'
import { ClientErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { ApiError } from './api-error'
import { errorResponseSchema } from './api-schemas'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions<T> {
  method?: HttpMethod
  body?: unknown
  // A file or pasted table sent as it is, with its own content type (the import of a settlement file): the api reads it as text and
  // not as JSON. It replaces `body`, never goes with it.
  textBody?: { text: string; contentType: string }
  // A file sent byte for byte, with its own content type: the api decodes it with the encoding a profile names (a bank file saved as
  // Windows-1252 must not travel as text, which the browser would turn into UTF-8). It replaces `body`, never goes with it.
  fileBody?: { bytes: ArrayBuffer; contentType: string }
  // The store the request is about: the api reads it from X-Store-Id and nowhere else
  storeId?: string
  // Every answer is parsed with it; z.undefined() for a 204
  schema: z.ZodType<T>
  // 'text' reads the body as it comes (a CSV the api writes as a file) and `schema` parses that text; JSON by default
  responseType?: 'json' | 'text'
  signal?: AbortSignal
  // false for the public routes (magic link request, invitation preview), which send no token
  authenticated?: boolean
}

export interface ApiClientOptions {
  baseUrl: string
  getAccessToken: () => string | null
  refreshAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

export interface ApiClient {
  request: <T>(path: string, options: RequestOptions<T>) => Promise<T>
}

// The one way the browser talks to the api: prefix, token, X-Store-Id, the error contract and a
// single retry after an expired token. A request with no token yet asks for one first.
export function createApiClient({
  baseUrl,
  getAccessToken,
  refreshAccessToken,
  fetchImpl = fetch
}: ApiClientOptions): ApiClient {
  const send = async <T>(
    path: string,
    options: RequestOptions<T>,
    token: string | null
  ): Promise<Response> => {
    const payloads = [options.body, options.textBody, options.fileBody].filter(
      value => value !== undefined
    )
    if (payloads.length > 1) throw new Error('a request has one body: body, textBody or fileBody')
    const headers: Record<string, string> = {}
    if (options.textBody !== undefined) headers['content-type'] = options.textBody.contentType
    else if (options.fileBody !== undefined) headers['content-type'] = options.fileBody.contentType
    else if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (options.storeId !== undefined) headers[TenantHeaders.STORE_ID] = options.storeId
    try {
      return await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.textBody !== undefined
            ? options.textBody.text
            : options.fileBody !== undefined
              ? options.fileBody.bytes
              : options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
        signal: options.signal
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError(0, ClientErrorCodes.NETWORK_UNAVAILABLE, 'The api cannot be reached')
    }
  }

  const request = async <T>(path: string, options: RequestOptions<T>): Promise<T> => {
    const authenticated = options.authenticated ?? true
    let token = authenticated ? (getAccessToken() ?? (await refreshAccessToken())) : null
    options.signal?.throwIfAborted() // A refresh can take a while: the page may have moved on
    let response = await send(path, options, token)
    // Any 401, not only an expiry: a token revoked by a logout in another tab is refused with another
    // code. The refresh then settles it: a new token, or a session lost that the page hears about.
    if (authenticated && response.status === HttpStatusCodes.UNAUTHORIZED) {
      token = await refreshAccessToken()
      options.signal?.throwIfAborted()
      response = await send(path, options, token)
    }
    if (!response.ok) {
      const body = errorResponseSchema.safeParse(await response.json().catch(() => null))
      throw body.success
        ? ApiError.fromBody(response.status, body.data)
        : ApiError.unreadable(response.status)
    }
    if (response.status === HttpStatusCodes.NO_CONTENT) return options.schema.parse(undefined)
    return options.schema.parse(
      options.responseType === 'text' ? await response.text() : await response.json()
    )
  }

  return { request }
}
