import { createHash } from 'node:crypto'

import { type CarrierTokenCache } from '@platform/core/domain'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import {
  C807_BASE_URLS,
  C807Api,
  type C807Environment,
  C807Environments,
  C807Token
} from './c807-constants'
import type { C807Credentials } from './c807-credentials'

// Who a call is made for: the token is kept per connection. A call made before the connection exists (the test of the
// credentials at connect time) has no connection and keeps no token.
export interface C807Scope {
  storeId: string
  connectionId?: string
  // Left out, production
  environment?: C807Environment
}

const baseUrlOf = (scope: C807Scope): string =>
  C807_BASE_URLS[scope.environment ?? C807Environments.PRODUCTION]

export interface C807Request {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: unknown
}

const MESSAGE_MAX_LENGTH = 200

// What C807 says when it refuses, short and with no control characters, for a person to read
function safeMessage(body: unknown, fallback: string): string {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  // C807 answers a refusal as `{"errores": [{"codigo": 5, "mensaje": "..."}]}` (sandbox, 2026-11-14)
  const listed = Array.isArray(record['errores'])
    ? (record['errores'] as unknown[])
        .map(item =>
          typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>)['mensaje']
            : undefined
        )
        .filter((value): value is string => typeof value === 'string')
        .join('; ') || undefined
    : undefined
  const raw =
    listed ??
    (['mensaje', 'message', 'error'] as const)
      .map(key => record[key])
      .find((value): value is string => typeof value === 'string')
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const text = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text === '' ? fallback : text.slice(0, MESSAGE_MAX_LENGTH)
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

// The HTTP side of C807: a Bearer token from Basic Auth, kept per connection, renewed once on a `401` (the carrier answers a bare
// 401 for an expired or a bad token). Errors are typed so that the core never reads provider text (TDD_17 §4.1): a refusal is
// `CarrierRejectedError`, a failure with no answer is `CarrierUnavailableError` (the outcome is unknown) and a refusal of the
// credentials is `CarrierAuthError`.
// The token is kept with a digest of the user and password that earned it, so that a connection whose credentials were edited
// never goes on with the token of the old account
function fingerprint(scope: C807Scope, credentials: C807Credentials): string {
  return createHash('sha256')
    .update(
      `${scope.environment ?? C807Environments.PRODUCTION}\n${credentials.username}\n${credentials.password}`
    )
    .digest('hex')
    .slice(0, 16)
}

export class C807Client {
  // A login in flight per connection: callers that find the token expired at the same time ask the carrier once
  private readonly logins = new Map<string, Promise<string>>()

  constructor(private readonly cache: CarrierTokenCache) {}

  // Forgets the token of a connection (it is closed, or the carrier no longer accepts it)
  forget(scope: C807Scope): Promise<void> {
    return scope.connectionId === undefined
      ? Promise.resolve()
      : this.cache.delete(scope.storeId, scope.connectionId)
  }

  // The token for these credentials, from the cache or from the carrier
  async token(scope: C807Scope, credentials: C807Credentials): Promise<string> {
    if (scope.connectionId !== undefined) {
      const cached = await this.cache.get(scope.storeId, scope.connectionId)
      const prefix = `${fingerprint(scope, credentials)}.`
      if (cached !== null && cached.startsWith(prefix)) return cached.slice(prefix.length)
    }
    return this.login(scope, credentials)
  }

  // A token from the carrier now, whatever the cache holds: it is how the credentials are proved. Calls that ask at the same
  // time for the same connection share one login.
  login(scope: C807Scope, credentials: C807Credentials): Promise<string> {
    if (scope.connectionId === undefined) return this.requestToken(scope, credentials)
    const key = `${scope.storeId}:${scope.connectionId}`
    const running = this.logins.get(key)
    if (running) return running
    const started = this.requestToken(scope, credentials).finally(() => this.logins.delete(key))
    this.logins.set(key, started)
    return started
  }

  private async requestToken(scope: C807Scope, credentials: C807Credentials): Promise<string> {
    const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    // The documentation does not name the method: the carrier answers 405 to a GET and takes a POST
    const response = await this.send(`${baseUrlOf(scope)}${C807Api.TOKEN_PATH}`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, accept: 'application/json' }
    })
    if (response.status === 401 || response.status === 403) {
      throw new CarrierAuthError('C807 rejected the user and password')
    }
    const body = await readJson(response)
    if (!response.ok) this.fail(response.status, body)
    const token =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['access_token']
        : undefined
    if (typeof token !== 'string' || token === '') {
      throw new CarrierUnavailableError('C807 answered the token request without a token')
    }
    if (scope.connectionId !== undefined) {
      await this.cache.set(
        scope.storeId,
        scope.connectionId,
        `${fingerprint(scope, credentials)}.${token}`,
        C807Token.TTL_SECONDS
      )
    }
    return token
  }

  // Drops the cached token only if it is still the one that failed: another caller may already have stored a new one
  private async dropIfStale(
    scope: C807Scope,
    credentials: C807Credentials,
    stale: string
  ): Promise<void> {
    if (scope.connectionId === undefined) return
    const cached = await this.cache.get(scope.storeId, scope.connectionId)
    if (cached === `${fingerprint(scope, credentials)}.${stale}`) {
      await this.cache.delete(scope.storeId, scope.connectionId)
    }
  }

  // The answer of an authorized call as JSON. A `401` drops the token, asks for a new one and repeats the call once.
  async call(
    scope: C807Scope,
    credentials: C807Credentials,
    request: C807Request
  ): Promise<unknown> {
    let token = await this.token(scope, credentials)
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.send(this.url(scope, request), {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      })
      if (response.status === 401) {
        await this.dropIfStale(scope, credentials, token)
        if (attempt > 0) throw new CarrierAuthError('C807 rejected the token it had just issued')
        token = await this.login(scope, credentials)
        continue
      }
      const body = await readJson(response)
      if (!response.ok) this.fail(response.status, body)
      return body
    }
  }

  private url(scope: C807Scope, request: C807Request): string {
    const query = new URLSearchParams(request.query).toString()
    return `${baseUrlOf(scope)}${request.path}${query === '' ? '' : `?${query}`}`
  }

  // A failure before any answer leaves the outcome unknown
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(C807Api.TIMEOUT_MS) })
    } catch {
      throw new CarrierUnavailableError('C807 did not answer')
    }
  }

  private fail(status: number, body: unknown): never {
    if (status >= 500 || status === 429 || status === 408) {
      throw new CarrierUnavailableError(`C807 answered with an error (${status})`)
    }
    throw new CarrierRejectedError(safeMessage(body, `C807 refused the request (${status})`))
  }
}
