import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Layout of the stored bytes: [1 byte format version][12 byte IV][ciphertext][16 byte auth tag].
// The version byte lets a later algorithm or layout coexist with rows written today:
//  - version 1: no associated data (what every row written before Step 7.3-S17 holds, and what a seal without `aad` still writes);
//  - version 2: the GCM tag also covers the associated data (`aad`), so a sealed value moved to another row does not open.
// An open accepts both: a version 1 row opens as it always did, a version 2 row opens only with the same `aad` it was sealed with.
const FORMAT_VERSION_PLAIN = 1
const FORMAT_VERSION_BOUND = 2
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = 1 + IV_BYTES

// Why a sealed value did not open, as a code that carries no data (never the value, never a fragment of it). AES-GCM cannot tell a key that
// changed from a row that was altered (both fail the authentication tag): `KEY_MISMATCH` is both until a previous key is held to try
// (Step 7.3-S11b); a row whose bytes are not even shaped like a sealed value is `ROW_DAMAGED`; a key that is not there is `KEY_MISSING`.
export const DecryptionFailure = {
  KEY_MISSING: 'key_missing',
  KEY_MISMATCH: 'key_mismatch',
  ROW_DAMAGED: 'row_damaged'
} as const
export type DecryptionFailure = (typeof DecryptionFailure)[keyof typeof DecryptionFailure]

export class DecryptionError extends Error {
  constructor(
    reason: string,
    readonly failure: DecryptionFailure = DecryptionFailure.ROW_DAMAGED
  ) {
    super(`cannot decrypt: ${reason}`)
    this.name = 'DecryptionError'
  }
}

// The failure code of anything an open threw; a stray error is a damaged row (it is never read for its message)
export function failureOf(error: unknown): DecryptionFailure {
  return error instanceof DecryptionError ? error.failure : DecryptionFailure.ROW_DAMAGED
}

// CREDENTIALS_ENCRYPTION_KEY is 64 hex characters. The key is a parameter, never read from the
// environment here, so the rotation job can hold the old and the new key at once.
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('the encryption key must be 64 hex characters (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(plaintext: string, key: Buffer, aad?: string): Buffer<ArrayBuffer> {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const version = aad === undefined ? FORMAT_VERSION_PLAIN : FORMAT_VERSION_BOUND
  return Buffer.concat([Buffer.from([version]), iv, body, cipher.getAuthTag()])
}

export function decrypt(payload: Uint8Array, key: Buffer, aad?: string): string {
  if (key.length !== KEY_BYTES) {
    throw new DecryptionError('the encryption key must be 32 bytes', DecryptionFailure.KEY_MISSING)
  }
  const bytes = Buffer.from(payload)
  if (bytes.length < HEADER_BYTES + TAG_BYTES) throw new DecryptionError('payload too short')
  const version = bytes[0]
  if (version !== FORMAT_VERSION_PLAIN && version !== FORMAT_VERSION_BOUND) {
    throw new DecryptionError('unknown format version')
  }
  // A bound value never opens without its associated data. A plain (version 1) value has no data to check: it opens even when `aad` is given,
  // which is the compatibility with what was sealed before the data existed (a caller that must refuse version 1 has to check the format itself)
  if (version === FORMAT_VERSION_BOUND && aad === undefined) {
    throw new DecryptionError('missing associated data')
  }

  const iv = bytes.subarray(1, HEADER_BYTES)
  const body = bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  if (version === FORMAT_VERSION_BOUND && aad !== undefined)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // The auth tag did not match: a wrong key or a tampered payload. The cause adds nothing.
    throw new DecryptionError('wrong key or altered data', DecryptionFailure.KEY_MISMATCH)
  }
}

// Credentials are stored as encrypted JSON; the reader gets back what was written.
export function encryptJson(value: unknown, key: Buffer): Buffer<ArrayBuffer> {
  return encrypt(JSON.stringify(value), key)
}

export function decryptJson(payload: Uint8Array, key: Buffer): unknown {
  return JSON.parse(decrypt(payload, key)) as unknown
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error('the encryption key must be 32 bytes')
}
