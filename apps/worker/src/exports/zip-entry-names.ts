import { sanitizeFilename } from '@platform/core/storage'

// The most a numbered stem may hold, so that `name (12).ext` stays near the 120 characters of a stored name
const MAX_ENTRY_STEM = 110

// The names inside a ZIP. A customer can send ten files called `image.jpg`, and a ZIP that holds two
// entries with one name extracts one over the other (or asks, or fails, by program). The name is
// cleaned once more here, so that an entry can never be a path (`../x`, `/etc/x`) whatever the row
// holds, and a repeated name gets a counter before its extension: `a.jpg`, `a (2).jpg`.
// Compared without case: Windows and macOS extract `A.jpg` and `a.jpg` to one file.
export class ZipEntryNames {
  private readonly taken = new Set<string>()

  next(filename: string): string {
    const clean = sanitizeFilename(filename)
    const dot = clean.lastIndexOf('.')
    const stem = dot > 0 ? clean.slice(0, dot) : clean
    const extension = dot > 0 ? clean.slice(dot) : ''
    let candidate = clean
    for (let counter = 2; this.taken.has(candidate.toLowerCase()); counter += 1) {
      const suffix = ` (${counter})`
      candidate = `${stem.slice(0, Math.max(1, MAX_ENTRY_STEM - suffix.length))}${suffix}${extension}`
    }
    this.taken.add(candidate.toLowerCase())
    return candidate
  }
}
