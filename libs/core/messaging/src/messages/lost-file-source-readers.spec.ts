import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// Where a customer file that was lost came from (the connection and the id of the provider's media) is
// kept in `Message.metadata` so that an agent can ask for the file again. It is not a secret of the store,
// but it names a connection and a file of the provider, and the thread has no use for it: the view of a
// message carries only `canRetry`.
//
// The metadata of a message is written by the channels and read in many places, so the safe thing is
// to know every file that understands this entry. A new reader (an export, a search, a webhook to a
// plugin, a log line) has to be added to the list below on purpose, in the review that reads it.
const ROOT = resolve(__dirname, '../../../../..')
const SOURCE_DIRS = ['apps', 'libs', 'scripts', 'tests']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.next', 'generated', 'coverage', '.nx'])
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/
// A file reaches the entry by its types, by the constant of its key, or by the key written out. The
// last is not a type access (`MessageView['unavailableFiles']` is the view, which has no source).
const SYMBOLS = new RegExp(
  [
    String.raw`\b(lostFileSourceSchema|LostFileSource|lostFileEntrySchema|LostFileEntry|lostFilesSchema)\b`,
    String.raw`\bUNAVAILABLE_FILES_KEY\b`,
    String.raw`(?<!\[)['"\`]unavailableFiles['"\`]`
  ].join('|')
)

// The files that read the entry, and why each may
const ALLOWED_READERS = [
  // Names the key of the entry in the metadata
  'libs/core/domain/conversation-constants.ts',
  // Drops the key from what a channel plugin passes through, so that a provider cannot write one
  'libs/core/messaging/src/messages/inbound-messages.ts',
  // Defines the entry, and decides `canRetry` from it
  'libs/core/messaging/src/messages/lost-files.ts',
  // Draws the view of a message from `lostFilesSchema`: it copies the index, the code and `canRetry`, never the source
  'libs/core/messaging/src/messages/messages.views.ts',
  // The request of an agent: builds the job from the stored source, nothing from the caller
  'libs/core/messaging/src/messages/media-refetch.service.ts',
  // The worker writes the source when it gives up on a file, and keeps what it cannot read
  'apps/worker/src/media/unavailable-file-marker.service.ts',
  'apps/worker/src/media/inbound-media-fetcher.service.ts'
]

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : sourceFilesUnder(join(directory, entry.name))
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [join(directory, entry.name)]
      : []
  })
}

describe('the files that read the source of a lost customer file', () => {
  it('are the ones listed here, so that a new reader is reviewed on purpose', () => {
    const readers = SOURCE_DIRS.flatMap(dir => sourceFilesUnder(join(ROOT, dir)))
      .filter(file => SYMBOLS.test(readFileSync(file, 'utf8')))
      .map(file => relative(ROOT, file).split(sep).join('/'))
      .sort()

    expect(readers).toEqual([...ALLOWED_READERS].sort())
  })
})
