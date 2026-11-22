import { sanitizeDocumentInline } from '@platform/core/document-sanitizer'

import { DocumentCleaner } from '../document-cleaner'

// For the specs that are not about the thread: the same cleaner, on the thread of the test. The thread itself is covered by
// `thread-document-cleaner.spec.ts`, and `document-cleaner-isolation.spec.ts` keeps the services from calling the cleaner directly.
export class InlineDocumentCleaner extends DocumentCleaner {
  clean(
    input: Buffer,
    contentType: string,
    maxBytes?: number
  ): ReturnType<DocumentCleaner['clean']> {
    return sanitizeDocumentInline(input, contentType, maxBytes)
  }
}
