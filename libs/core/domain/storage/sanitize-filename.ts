const MAX_FILENAME_LENGTH = 120
const MAX_EXTENSION_LENGTH = 16
const FALLBACK_FILENAME = 'file'

// The name of a file that came from outside (a customer's, an agent's browser) before it is part of
// an object key, a database row or a `Content-Disposition` header (TDD_07 §6.3). Only letters,
// digits, dot, underscore and hyphen survive; every run of anything else (a slash, a space, an
// accent, a control character, a NUL) becomes one `_`, which is what stops a path traversal and a
// command injection in whatever processes the file later. Accents are taken off first ("año" is
// "ano", not "a_o"); letters of other scripts have no Latin form and become `_`. A leading dot would hide the file or name
// `..`, so it goes too. The name is cut to 120 characters keeping its extension, and is never empty.
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .normalize('NFD')
    .replaceAll(/\p{M}+/gu, '')
    .replaceAll(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '_')
  if (cleaned === '' || /^_*$/.test(cleaned)) return FALLBACK_FILENAME
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned

  const dot = cleaned.lastIndexOf('.')
  const extension =
    dot > 0 && cleaned.length - dot <= MAX_EXTENSION_LENGTH ? cleaned.slice(dot) : ''
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension
}
