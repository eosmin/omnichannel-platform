import { createHmac } from 'node:crypto'

// What goes on the wire for one call (Forza API v2.2, "LauValue y PayLoad"): the JSON of the request
// `{ Method, Params }`, sent as base64 in `PayLoad`, and signed as that very string with HMAC-SHA256 and the
// connection's secret key, in base64 (44 characters), in the `LauValue` header.
export interface SignedForzaRequest {
  payload: string
  signature: string
}

export function signForzaRequest(
  method: string,
  params: Record<string, unknown>,
  secretKey: string
): SignedForzaRequest {
  const json = JSON.stringify({ Method: method, Params: params })
  return {
    payload: Buffer.from(json, 'utf8').toString('base64'),
    signature: createHmac('sha256', secretKey).update(json, 'utf8').digest('base64')
  }
}

// The answer comes as base64 JSON as well; null when it is neither
export function decodeForzaPayload(payload: string): unknown {
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown
  } catch {
    return null
  }
}
