import { SvAnswerStates, SvSignerRoute } from './sv-constants'
import { callSv, codeOf, recordOf, SvTransportError, textOf, type SvFetch } from './sv-http'

// Signing a document. The authority hands out a signing service (a Java application in a container, or a Windows service) that reads the
// certificate of the taxpayer from its own disk and signs with the private key, and nothing in it is authenticated: it runs only on a private
// network, never published. The port below is what the provider needs; the adapter is the official service. A signer of our own (the key
// kept encrypted in the database) would be a second adapter (Step 4B.7c-3, option C, **pending the owner**).

export interface SvSignInput {
  readonly nit: string
  // The password of the private key of the certificate: it is never logged, kept or returned
  readonly privateKeyPassword: string
  readonly document: Readonly<Record<string, unknown>>
}

export type SvSigned =
  | { readonly kind: 'signed'; readonly jws: string }
  // The service refused: no certificate for that NIT, or the password does not open it (a person fixes the credentials)
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'unavailable' }

export interface SvSigner {
  sign(input: SvSignInput): Promise<SvSigned>
}

// The codes of the official signing service (its source, `Errores.java`) that say what a person gives it is wrong: 803 no key for that NIT
// (also a wrong password) and 809 data required. The others (801 no active certificate, 802 not valid, 812 no file: the state of the service
// or of its volume; 804 uncatalogued; 810 and 811 conversion) are faults of the deployment: they are not a verdict on the document, and
// the document waits until an operator fixes them.
const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['803', '809'])

export interface OfficialSignerOptions {
  readonly baseUrl: string
  readonly fetch: SvFetch
  readonly timeoutMs: number
}

// The address of the signing service as a base with no trailing slash and no credentials in it; anything else is refused
export function signerBaseUrl(url: string): string {
  const parsed = new URL(url)
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error(
      'the signing service address must be an http or https address with no credentials'
    )
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

// A compact signed document: three parts, each of base64url characters
const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function officialSigner(options: OfficialSignerOptions): SvSigner {
  const base = signerBaseUrl(options.baseUrl)
  return {
    async sign(input: SvSignInput): Promise<SvSigned> {
      try {
        const result = await callSv(
          options.fetch,
          `${base}${SvSignerRoute}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              nit: input.nit,
              activo: true,
              passwordPri: input.privateKeyPassword,
              dteJson: input.document
            })
          },
          options.timeoutMs
        )
        // The service answers 200 to everything: what counts is `status`
        const body = recordOf(result.json)
        if (result.status === 200 && body['status'] === SvAnswerStates.OK) {
          const jws = textOf(body['body'])
          return jws !== null && JWS_SHAPE.test(jws)
            ? { kind: 'signed', jws }
            : { kind: 'unavailable' }
        }
        if (result.status === 200 && body['status'] === SvAnswerStates.ERROR) {
          const code = codeOf(recordOf(body['body'])['codigo'])
          return code !== null && CREDENTIAL_CODES.has(code)
            ? { kind: 'rejected', code }
            : { kind: 'unavailable' }
        }
        return { kind: 'unavailable' }
      } catch (error) {
        if (error instanceof SvTransportError) return { kind: 'unavailable' }
        throw error
      }
    }
  }
}
