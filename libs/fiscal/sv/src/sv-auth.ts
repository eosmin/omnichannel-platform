import { createHash } from 'node:crypto'

import { type FiscalEnvironment } from '@platform/core/domain'

import { SvAnswerStates, SvAuthentication, SvEndpoints } from './sv-constants'
import { callSv, recordOf, SvTransportError, textOf, type SvFetch } from './sv-http'

// The token of the API (Manual Técnico §1.1, §4.1). The token is valid for a day in production and two in the sandbox, so it is asked for
// once and kept in memory; it is renewed before it ends. Three wrong logins lock the user of the API until a person changes the password in
// the site of the authority, so a password the authority refused is never sent again for a while (a negative memory), and the documents that
// wait for the same token share one login.

export type SvLogin =
  | { readonly kind: 'token'; readonly token: string }
  // The authority said the user or the password is wrong, or the password expired
  | { readonly kind: 'rejected' }
  // No answer, or an answer of the platform of the authority that says nothing about the credentials
  | { readonly kind: 'unavailable' }

export interface SvAuthOptions {
  readonly fetch: SvFetch
  readonly now: () => number
  readonly userAgent: string
  readonly timeoutMs: number
  readonly endpoints?: typeof SvEndpoints
}

interface Cached {
  readonly token: string
  readonly renewAt: number
}

export class SvAuthenticator {
  private readonly tokens = new Map<string, Cached>()
  private readonly refused = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<SvLogin>>()

  constructor(private readonly options: SvAuthOptions) {}

  // A key that never holds the password: the environment, the user and a hash of the password (a new password is a new key)
  private keyOf(environment: FiscalEnvironment, nit: string, password: string): string {
    return `${environment}:${nit}:${createHash('sha256').update(password).digest('hex').slice(0, 16)}`
  }

  async login(environment: FiscalEnvironment, nit: string, password: string): Promise<SvLogin> {
    const key = this.keyOf(environment, nit, password)
    const now = this.options.now()
    this.prune(now)
    const cached = this.tokens.get(key)
    if (cached !== undefined && now < cached.renewAt) return { kind: 'token', token: cached.token }
    const until = this.refused.get(key)
    if (until !== undefined && now < until) return { kind: 'rejected' }
    const running = this.inFlight.get(key)
    if (running !== undefined) return running
    const attempt = this.request(key, environment, nit, password).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, attempt)
    return attempt
  }

  // The token the authority did not accept: the next call asks for another one. Only that token is dropped: a newer one that another call
  // just got stays.
  forget(environment: FiscalEnvironment, nit: string, password: string, token: string): void {
    const key = this.keyOf(environment, nit, password)
    if (this.tokens.get(key)?.token === token) this.tokens.delete(key)
  }

  // What has ended is not kept: a token past its renewal and a memory that is over
  private prune(now: number): void {
    for (const [key, cached] of this.tokens) if (now >= cached.renewAt) this.tokens.delete(key)
    for (const [key, until] of this.refused) if (now >= until) this.refused.delete(key)
  }

  private async request(
    key: string,
    environment: FiscalEnvironment,
    nit: string,
    password: string
  ): Promise<SvLogin> {
    const endpoints = (this.options.endpoints ?? SvEndpoints)[environment]
    try {
      const result = await callSv(
        this.options.fetch,
        `${endpoints.baseUrl}${endpoints.auth}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': this.options.userAgent
          },
          body: new URLSearchParams({ user: nit, pwd: password }).toString()
        },
        this.options.timeoutMs
      )
      const body = recordOf(result.json)
      const token = textOf(recordOf(body['body'])['token'])
      if (result.status === 200 && body['status'] === SvAnswerStates.OK && token !== null) {
        const lifetime = SvAuthentication.TOKEN_LIFETIME_MS[environment]
        this.tokens.set(key, {
          token,
          renewAt: this.options.now() + lifetime * SvAuthentication.RENEW_AT
        })
        return { kind: 'token', token }
      }
      // Only the answer of the authority that says the user or the password is wrong is a verdict on the credentials (an error of the
      // authentication service with HTTP 400, 401 or 403). A rate limit, a gateway, a 404, a 5xx or a body that is not the authority's own is a fault of the
      // moment: it must never start the memory that refuses a document for fifteen minutes
      if (
        body['status'] === SvAnswerStates.ERROR &&
        (result.status === 400 || result.status === 401 || result.status === 403)
      ) {
        this.refused.set(key, this.options.now() + SvAuthentication.REJECTED_MEMORY_MS)
        return { kind: 'rejected' }
      }
      return { kind: 'unavailable' }
    } catch (error) {
      if (error instanceof SvTransportError) return { kind: 'unavailable' }
      throw error
    }
  }
}
