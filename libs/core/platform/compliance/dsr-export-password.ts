import { randomBytes } from 'node:crypto'

import type { CredentialCipher } from '@platform/core/crypto'

import { ComplianceConfig } from './compliance-constants'

// The password of the ZIP of a data export (Step 7.2-H2b-3c): 192 random bits, new for each request, as text a person can paste into any tool
// that opens a ZIP with AES-256. It is kept sealed with the credentials key and bound to the request (the sealed value of one request opens
// for no other), so a rotation of the key re-seals it with the machinery of the credentials (`openTextRotating`) and a row copied to another
// request is useless.
export function newDsrExportPassword(): string {
  return randomBytes(ComplianceConfig.DSR_EXPORT_PASSWORD_BYTES).toString('base64url')
}

// The data the sealed password is bound to (also the one the re-seal of a rotation of the key opens and seals it with)
export const dsrExportPasswordAad = (requestId: string): string =>
  `${ComplianceConfig.DSR_EXPORT_PASSWORD_AAD_PREFIX}${requestId}`

export function sealDsrExportPassword(
  cipher: CredentialCipher,
  requestId: string,
  password: string
): Uint8Array<ArrayBuffer> {
  return cipher.sealText(password, dsrExportPasswordAad(requestId))
}

// Throws (a wrong key, a value altered or moved to another request) with the error of the cipher, which names no data
export function openDsrExportPassword(
  cipher: CredentialCipher,
  requestId: string,
  sealed: Uint8Array
): string {
  return cipher.openTextRotating(sealed, dsrExportPasswordAad(requestId)).text
}
