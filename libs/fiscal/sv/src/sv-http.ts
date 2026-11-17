// The HTTP calls of this provider: one function, an injectable `fetch`, a timeout, and errors that carry a code and nothing else (never the
// url, a header or a body: they hold credentials and the data of a customer).

export interface SvResponseLike {
  readonly status: number
  text(): Promise<string>
}

export interface SvRequestInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal?: AbortSignal
  // A call that carries a password is never followed to another address: a redirect is an error
  readonly redirect: 'error'
}

export type SvFetch = (url: string, init: SvRequestInit) => Promise<SvResponseLike>

export const SvTransportFailures = { TIMEOUT: 'timeout', NETWORK: 'network' } as const
export type SvTransportFailure = (typeof SvTransportFailures)[keyof typeof SvTransportFailures]

export class SvTransportError extends Error {
  constructor(readonly failure: SvTransportFailure) {
    super(failure)
    this.name = 'SvTransportError'
  }
}

export interface SvHttpResult {
  readonly status: number
  // The body as JSON, or null when it is not JSON (an error page of a proxy)
  readonly json: unknown
}

export async function callSv(
  fetcher: SvFetch,
  url: string,
  init: Omit<SvRequestInit, 'signal' | 'redirect'>,
  timeoutMs: number
): Promise<SvHttpResult> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    let json: unknown = null
    try {
      json = JSON.parse(text) as unknown
    } catch {
      json = null
    }
    return { status: response.status, json }
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name
    throw new SvTransportError(
      name === 'TimeoutError' || name === 'AbortError'
        ? SvTransportFailures.TIMEOUT
        : SvTransportFailures.NETWORK
    )
  }
}

// What a value of a JSON answer is, read without trusting its shape
export const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
// A code of the authority or of the signing service, which a Java service may write as a number (803) or as text ("803")
export const codeOf = (value: unknown): string | null =>
  typeof value === 'number' && Number.isInteger(value)
    ? String(value)
    : typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : null
export const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null
