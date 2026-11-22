import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DocumentSanitizing } from '@platform/core/storage'

const SRC = join(__dirname, '..')
// A call or an import of the cleaner of the calling thread (a mention in a comment is not a use)
const USES_INLINE = /\bsanitizeDocumentInline\s*\(|import\s[^;]*\bsanitizeDocumentInline\b/

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sourcesOf(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

// Step 7.3: the parse of a document is synchronous and the file is the customer's, so nothing in the worker may run it on its main thread.
// The cleaner that runs on the calling thread (`sanitizeDocumentInline`) is for the entry of the document thread and for the specs
describe('the cleaning of documents never runs on the main thread of the worker', () => {
  it('only the entry of the document thread uses the cleaner of the calling thread', () => {
    const users = sourcesOf(SRC)
      .filter(file => USES_INLINE.test(readFileSync(file, 'utf8')))
      .map(file => file.slice(SRC.length + 1))
    expect(users.sort()).toEqual(['media/document-thread.reply.ts'])
  })

  it('the file of the thread is a second entry of the bundle, next to main.js', () => {
    const config = readFileSync(join(SRC, '..', 'rspack.config.cjs'), 'utf8')
    expect(config).toContain("'document-thread': 'apps/worker/src/media/document-thread.entry.ts'")
    expect(DocumentSanitizing.THREAD_ENTRY_FILE).toBe('document-thread.js')
  })
})
