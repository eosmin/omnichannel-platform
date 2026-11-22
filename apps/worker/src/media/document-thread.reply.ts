import { isEnvironmentError, sanitizeDocumentInline } from '@platform/core/document-sanitizer'
import { DocumentSanitizing } from '@platform/core/storage'

import type { DocumentThreadInput, DocumentThreadReply } from './document-cleaner'

const { ThreadReplies, Untouched } = DocumentSanitizing

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
    if (result.kind === 'sanitized') return { kind: ThreadReplies.SANITIZED, body: result.body }
    return {
      kind: ThreadReplies.UNTOUCHED,
      why: result.why === Untouched.TIMED_OUT ? Untouched.NOT_CLEANABLE : result.why
    }
  } catch (error) {
    // `sanitizeDocumentInline` rethrows only the errors of the machine; anything else it has already turned into `not_cleanable`
    return isEnvironmentError(error)
      ? { kind: ThreadReplies.ENVIRONMENT }
      : { kind: ThreadReplies.UNTOUCHED, why: Untouched.NOT_CLEANABLE }
  }
}
