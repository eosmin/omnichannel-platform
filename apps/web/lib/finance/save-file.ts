import { CSV_BOM } from '@platform/core/exports'

// Hands a file the api wrote to the person: the text as it came, as a download. The api writes a CSV with the mark of its encoding
// first and `Response.text()` takes that mark off, so it goes back on: the file is the one the api wrote, byte for byte (an auditor
// compares it with the head of the chain), and a spreadsheet reads the accents right.
const REVOKE_AFTER_MS = 30_000

export function saveCsvFile(name: string, text: string): void {
  const blob = new Blob([text.startsWith(CSV_BOM) ? text : CSV_BOM + text], {
    type: 'text/csv;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  // Not at once: some browsers read the address after the click returns, and a large file takes a while to be read
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
