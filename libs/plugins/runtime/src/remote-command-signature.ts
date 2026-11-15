import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  REMOTE_SIGNATURE_TIME_KEY,
  REMOTE_SIGNATURE_VERSION_KEY,
  RemoteChannelLimits
} from '@platform/core/domain'

const HEX_SHA256 = /^[0-9a-f]{64}$/
const DIGITS = /^\d{1,12}$/

function hmacHex(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

// `X-Platform-Command-Signature` (TDD_10 §6.7.4): `t=<unix seconds>,v1=<hex>`, the hex being the HMAC-SHA256 of `"<t>.<raw body>"`
// with the command secret. While a rotation is open there is one `v1=` per secret (the current one first), so a plugin that
// knows only the old one, or only the new one, still verifies.
export function signRemoteCommand(
  rawBody: string,
  secrets: readonly string[],
  nowSeconds: number
): string {
  if (secrets.length === 0) throw new Error('no command secret to sign with')
  const parts = secrets.map(
    secret => `${REMOTE_SIGNATURE_VERSION_KEY}=${hmacHex(secret, nowSeconds, rawBody)}`
  )
  return `${REMOTE_SIGNATURE_TIME_KEY}=${nowSeconds},${parts.join(',')}`
}

// What a plugin does with a command: the same check its author writes (the reference plugin of the contract suite uses
// it). A `t` more than the tolerance from `nowSeconds`, or a signature that matches none of the secrets it knows, is refused.
// The comparison of every signature takes the same time whatever the secret.
export function verifyRemoteCommand(
  header: string,
  rawBody: string,
  secrets: readonly string[],
  nowSeconds: number
): boolean {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const part of header.split(',')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    const key = part.slice(0, at).trim()
    const value = part.slice(at + 1).trim()
    if (key === REMOTE_SIGNATURE_TIME_KEY && DIGITS.test(value) && timestamp === null) {
      timestamp = Number(value)
    } else if (key === REMOTE_SIGNATURE_VERSION_KEY && HEX_SHA256.test(value)) {
      signatures.push(value)
    }
  }
  if (timestamp === null || signatures.length === 0) return false
  if (Math.abs(nowSeconds - timestamp) > RemoteChannelLimits.SIGNATURE_TOLERANCE_SECONDS) {
    return false
  }
  let matched = false
  for (const secret of secrets) {
    const expected = Buffer.from(hmacHex(secret, timestamp, rawBody), 'hex')
    for (const signature of signatures) {
      // No early exit: the time does not say which secret or which entry matched
      if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) matched = true
    }
  }
  return matched
}
