import { z } from 'zod'

import { HttpStatusCodes } from '@platform/core/errors'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import type { ForzaConfig } from './forza-connection'
import {
  ForzaHeaders,
  ForzaLimits,
  type ForzaMethod,
  ForzaPaths,
  ForzaStatusCodes,
  PDF_MAGIC
} from './forza-constants'
import { decodeForzaPayload, signForzaRequest } from './forza-signing'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ForzaAnswer {
  objectValue: unknown
  trackOrder: unknown
}

const envelopeSchema = z.object({
  StatusCode: z.number().optional(),
  Description: z.string().nullish(),
  ObjectValue: z.unknown().optional(),
  TrackOrder: z.unknown().optional()
})
const wireSchema = z.object({ PayLoad: z.string().min(1) })

// Text of the carrier that goes into an error: bounded, one line, never anything of ours
export function safeCarrierText(text: string | null | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return clean === '' ? fallback : clean.slice(0, ForzaLimits.MESSAGE_MAX)
}

// The refusal of the credentials is the one 401 that names the application or the signature; the other 401s are
// a malformed PayLoad (the documentation's catalog of controlled answers)
const CREDENTIAL_REFUSAL = /(codapp|lauvalue)\s+inv[aá]lid/i

function classify(status: number, description: string | null | undefined): never {
  const text = safeCarrierText(description, 'Forza refused the request')
  if (status === ForzaStatusCodes.UNAUTHORIZED && CREDENTIAL_REFUSAL.test(description ?? '')) {
    throw new CarrierAuthError('Forza rejected the credentials')
  }
  // 409 is "the transaction could not be completed, try again": the outcome is not known; a throttle or a timeout of
  // the gateway is not a refusal either
  if (
    status === ForzaStatusCodes.CONFLICT ||
    status === HttpStatusCodes.REQUEST_TIMEOUT ||
    status === HttpStatusCodes.TOO_MANY_REQUESTS ||
    status >= ForzaStatusCodes.SERVER_ERROR
  ) {
    throw new CarrierUnavailableError('Forza could not complete the request')
  }
  throw new CarrierRejectedError(text)
}

// The body of an answer, read as it arrives and dropped as soon as it passes the limit, whatever the headers say
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const announced = Number(response.headers.get('content-length') ?? 0)
  if (announced > max || response.body === null) {
    if (announced > max) throw new Error('too large')
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > max) throw new Error('too large')
    return new Uint8Array(buffer)
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

// One signed call. Network failures, timeouts, 5xx and an unreadable answer end in CarrierUnavailableError (the
// outcome is unknown); the controlled refusals of the documentation are mapped by `classify`.
export async function callForza(
  doFetch: FetchLike,
  config: ForzaConfig,
  method: ForzaMethod,
  params: Record<string, unknown>
): Promise<ForzaAnswer> {
  const { payload, signature } = signForzaRequest(method, params, config.secretKey)
  let response: Response
  try {
    response = await doFetch(`${config.baseUrl}${ForzaPaths[method]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ForzaHeaders.SIGNATURE]: signature },
      body: JSON.stringify({ CodApp: config.codApp, PayLoad: payload }),
      redirect: 'error',
      signal: AbortSignal.timeout(ForzaLimits.REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new CarrierUnavailableError('Forza could not be reached')
  }

  const text = await readCapped(response, ForzaLimits.ANSWER_MAX_BYTES)
    .then(bytes => new TextDecoder().decode(bytes))
    .catch(() => '')
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch {
    body = null
  }
  const wire = wireSchema.safeParse(body)
  const decoded = wire.success ? decodeForzaPayload(wire.data.PayLoad) : null
  const envelope = envelopeSchema.safeParse(decoded)
  if (!envelope.success || envelope.data.StatusCode === undefined) {
    // No PayLoad: the HTTP status and the text say what the service meant
    // The text of a body that is not the PayLoad is not shown: it may be a page that echoes the request
    if (
      response.status === ForzaStatusCodes.UNAUTHORIZED ||
      response.status === HttpStatusCodes.FORBIDDEN
    ) {
      throw new CarrierAuthError('Forza rejected the credentials')
    }
    if (response.status >= ForzaStatusCodes.BAD_REQUEST) classify(response.status, null)
    throw new CarrierUnavailableError('Forza answered something unreadable')
  }
  const { StatusCode, Description, ObjectValue, TrackOrder } = envelope.data
  if (StatusCode !== ForzaStatusCodes.SUCCESS) classify(StatusCode, Description)
  return { objectValue: ObjectValue, trackOrder: TrackOrder }
}

// The label is a link to a PDF in the answer. Only a link on the host of the connection is followed, and the
// signature is never sent to it.
export async function downloadForzaPdf(
  doFetch: FetchLike,
  config: ForzaConfig,
  link: string
): Promise<Uint8Array> {
  let target: URL
  try {
    target = new URL(link)
  } catch {
    throw new CarrierRejectedError('Forza sent a label link that is not valid')
  }
  if (target.origin !== new URL(config.baseUrl).origin) {
    throw new CarrierRejectedError('Forza sent a label link to another host')
  }
  let response: Response
  try {
    response = await doFetch(target.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(ForzaLimits.REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new CarrierUnavailableError('The Forza label could not be downloaded')
  }
  if (!response.ok) throw new CarrierUnavailableError('The Forza label could not be downloaded')
  const bytes = await readCapped(response, ForzaLimits.LABEL_MAX_BYTES).catch(() => null)
  if (bytes === null) throw new CarrierRejectedError('The Forza label is too large')
  if (new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
    throw new CarrierRejectedError('The Forza label is not a PDF')
  }
  return bytes
}
