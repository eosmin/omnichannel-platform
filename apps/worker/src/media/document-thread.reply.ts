import { isEnvironmentError, sanitizeDocumentInline } from '@platform/core/document-sanitizer'

import type { DocumentThreadInput, DocumentThreadReply } from './document-cleaner'

// What the document thread answers for what it was handed (`document-thread.entry.ts` sends it). Apart from the entry so that a spec can
// call it: the entry runs on load and only inside a thread. The text of an error is never in the reply, because the one of a parser may
// carry a piece of the file.
export async function replyFor({
  input,
  contentType,
  maxBytes
}: DocumentThreadInput): Promise<DocumentThreadReply> {
  try {
    const result = await sanitizeDocumentInline(Buffer.from(input), contentType, maxBytes)
    if (result.kind === 'sanitized') return { kind: 'sanitized', body: result.body }
    return { kind: 'untouched', why: result.why === 'timed_out' ? 'not_cleanable' : result.why }
  } catch (error) {
    // `sanitizeDocumentInline` rethrows only the errors of the machine; anything else it has already turned into `not_cleanable`
    return isEnvironmentError(error)
      ? { kind: 'environment' }
      : { kind: 'untouched', why: 'not_cleanable' }
  }
}
