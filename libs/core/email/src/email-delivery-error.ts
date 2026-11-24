// What a mail provider refused, kept by its name and its code and by nothing else. The text of a refusal (an SMTP response, the message of a
// provider SDK) can hold the address the mail was sent to, and an error travels to the log, to the dead-letter queue and to the failure that
// the queue keeps for the job: so the provider's own text is never kept, and there is no `cause`. A name or a code that is not a plain token
// is not trusted either. The check is of the shape (a token of at most 40 characters, which cannot be an address: no `@`), not a list of the
// values a provider uses; the names and codes of the providers we call are of this shape.
const TOKEN = /^[A-Za-z0-9_.-]{1,40}$/

// The values that stand when the provider gave none that can be kept
export const EmailDeliveryFallback = { KIND: 'unknown', NO_STATUS: 'network' } as const

export function safeToken(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : value
  return typeof text === 'string' && TOKEN.test(text) ? text : null
}

export class EmailDeliveryError extends Error {
  // The name of what the provider raised (`validation_error`, `Error`), or `unknown`
  readonly kind: string
  // The code or the status the provider gave (`EENVELOPE`, `422`, `network`), or null
  readonly providerCode: string | null

  constructor(kind: unknown, providerCode: unknown) {
    const safeKind = safeToken(kind) ?? EmailDeliveryFallback.KIND
    const safeCode = safeToken(providerCode)
    super(
      `the mail provider did not take the message: ${safeKind}${safeCode === null ? '' : ` (${safeCode})`}`
    )
    this.name = 'EmailDeliveryError'
    this.kind = safeKind
    this.providerCode = safeCode
  }
}
