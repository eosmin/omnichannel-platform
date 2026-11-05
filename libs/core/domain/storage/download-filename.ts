import type { AllowedContentTypes } from './upload-constants'

type AllowedContentType = (typeof AllowedContentTypes)[keyof typeof AllowedContentTypes][number]

// The extensions a name may carry for each kind of file the app lets in; the first is the one added when
// the name has none that fits. Typed on `AllowedContentTypes`, so a new type does not compile until it
// has its extensions here. Nothing a desktop would run (`bat`, `cmd`, `ps1`, `sh`, `js`, `vbs`, `exe`,
// `html`) is on any list, and plain text keeps the extensions of the text files people really send.
const EXTENSIONS = {
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov', 'qt'],
  'audio/mpeg': ['mp3', 'mpga'],
  'audio/ogg': ['ogg', 'oga', 'opus'],
  'audio/wav': ['wav', 'wave'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'text', 'log', 'csv', 'md', 'json'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx']
} as const satisfies Record<AllowedContentType, readonly string[]>

// What a download is called when the name is nothing but dots
const FALLBACK_BASE = 'file'

// The name a download is offered under. The name is the sender's and the type was read from the bytes,
// so `x.exe` with a PDF inside, or `run.bat` with plain text, would open as an executable when it is
// double-clicked on the desktop of the agent. A name whose extension is not one of its type's gets the
// type's own after it (`x.exe.pdf`): the file still says what it was sent as, and opens as what it is.
// A type that is not one of the uploads (an export, an archive the app builds itself) is left alone.
export function downloadFilename(filename: string, contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  const allowed = (EXTENSIONS as Record<string, readonly string[] | undefined>)[type]
  if (allowed === undefined || allowed[0] === undefined) return filename
  const trimmed = filename.replace(/\.+$/, '')
  const base = trimmed === '' ? FALLBACK_BASE : trimmed
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  return allowed.includes(extension) ? base : `${base}.${allowed[0]}`
}
