import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_TOKEN_BYTES = 32 // 256 bits

// An opaque secret for a magic link or a refresh token: unguessable, safe in a URL fragment or a body
export function generateToken(bytes = DEFAULT_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url')
}

// What the database keeps instead of the token. SHA-256 and no salt, on purpose: the token already
// has 256 bits of entropy, so there is nothing to brute-force, and a lookup by hash needs the same
// input to give the same output.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
