import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Layout of the stored bytes: [1 byte format version][12 byte IV][ciphertext][16 byte auth tag].
// The version byte lets a later algorithm or layout coexist with rows written today.
const FORMAT_VERSION = 1
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = 1 + IV_BYTES

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`cannot decrypt: ${reason}`)
    this.name = 'DecryptionError'
  }
}

// CREDENTIALS_ENCRYPTION_KEY is 64 hex characters. The key is a parameter, never read from the
// environment here, so the rotation job can hold the old and the new key at once.
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('the encryption key must be 64 hex characters (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(plaintext: string, key: Buffer): Buffer<ArrayBuffer> {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, body, cipher.getAuthTag()])
}

export function decrypt(payload: Uint8Array, key: Buffer): string {
  assertKey(key)
  const bytes = Buffer.from(payload)
  if (bytes.length < HEADER_BYTES + TAG_BYTES) throw new DecryptionError('payload too short')
  if (bytes[0] !== FORMAT_VERSION) throw new DecryptionError('unknown format version')

  const iv = bytes.subarray(1, HEADER_BYTES)
  const body = bytes.subarray(HEADER_BYTES, bytes.length - TAG_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // The auth tag did not match: a wrong key or a tampered payload. The cause adds nothing.
    throw new DecryptionError('wrong key or altered data')
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
