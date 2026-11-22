import { isMainThread, parentPort, workerData } from 'node:worker_threads'

import type { DocumentThreadInput, DocumentThreadReply } from './document-cleaner'
import { replyFor } from './document-thread.reply'

// The file that the worker starts as a thread (`ThreadDocumentCleaner`): a second entry of the rspack bundle, `document-thread.js` next to
// `main.js` (`apps/worker/rspack.config.cjs`). Nothing else imports it, because it runs on load. It cleans one document and answers with
// one message: the bytes it received in, the bytes it made out. It reads no environment and holds no credential (the thread is started
// with an empty one).
if (!isMainThread && parentPort !== null) {
  const port = parentPort
  void replyFor(workerData as DocumentThreadInput).then(reply => {
    if (reply.kind === 'sanitized') {
      // The bytes move to the parent, they are not copied
      const body = new Uint8Array(reply.body)
      port.postMessage({ kind: 'sanitized', body } satisfies DocumentThreadReply, [body.buffer])
    } else {
      port.postMessage(reply)
    }
  })
}
