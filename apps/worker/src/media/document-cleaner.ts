import type { SanitizedDocument } from '@platform/core/document-sanitizer'

// What the worker uses to clean a PDF, a docx or an xlsx of its properties. The one implementation that runs in the worker parses the document on
// a thread of its own (`ThreadDocumentCleaner`): the parse is synchronous and the file is the customer's, so it never runs on the main thread.
// An abstract class, not an interface, so that Nest can use it as the token. Never refuses a document: one it cannot clean is `untouched`, and
// an error of the machine propagates so that the queue retries.
export abstract class DocumentCleaner {
  abstract clean(input: Buffer, contentType: string, maxBytes?: number): Promise<SanitizedDocument>
  // True while the cleaner cannot take a document (a thread that could not be stopped is still alive): the sweep does not count an attempt
  // for a document it would only be refused
  abstract isBusy(): boolean
}

// What the thread receives (a copy of the bytes: the caller keeps its own) and what it sends back. Nothing else crosses: the thread has no
// storage, no database, no credentials and no environment
export interface DocumentThreadInput {
  input: Uint8Array
  contentType: string
  maxBytes: number
}

export type DocumentThreadReply =
  // `keptParts`: what the cleaning meant to reach and left as it came (see `SanitizedDocument`); absent counts as none
  | { kind: 'sanitized'; body: Uint8Array; keptParts?: number }
  | { kind: 'untouched'; why: 'type' | 'already_clean' | 'not_cleanable' }
  // An error of the machine (memory, threads): the document is not to blame, the caller retries. The text of the error is not sent, because
  // the one of a parser may carry a piece of the file
  | { kind: 'environment' }
