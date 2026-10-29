import type { z } from 'zod'

import { API_PREFIX } from '@platform/core/api'
import { TenantHeaders } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { ApiError } from './api-error'
import { errorResponseSchema } from './api-schemas'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions<T> {
  method?: HttpMethod
  body?: unknown
  // The store the request is about: the api reads it from X-Store-Id and nowhere else
  storeId?: string
  // Every answer is parsed with it; z.undefined() for a 204
  schema: z.ZodType<T>
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
    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (options.storeId !== undefined) headers[TenantHeaders.STORE_ID] = options.storeId
    try {
      return await fetchImpl(`${baseUrl}${API_PREFIX}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'The api cannot be reached')
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
    return options.schema.parse(
      response.status === HttpStatusCodes.NO_CONTENT ? undefined : await response.json()
    )
  }

  return { request }
}
