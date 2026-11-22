// Cleans a real PDF on the document thread of the BUILT worker (dist/apps/worker/document-thread.js). The specs run the thread with test
// files and the cleaner under ts-jest; only the bundle the image runs can show that the file of the thread is there, resolves what it imports
// and answers (a thread with no file would make every document upload and sweep fail). Needs `nx run worker:build` first.
// It starts the file as `ThreadDocumentCleaner` does (an empty environment, the same limits) and reads the one message it sends.
// Usage: tsx scripts/smoke-document-thread.ts
import { resolve } from 'node:path'
import { exit } from 'node:process'
import { Worker } from 'node:worker_threads'

import { PDFDocument } from 'pdf-lib'

import { DocumentSanitizing } from '@platform/core/storage'

const AUTHOR = 'Smoke Test Author'
const DEADLINE_MS = 20_000

async function main(): Promise<void> {
  const doc = await PDFDocument.create()
  doc.addPage([100, 100])
  doc.setAuthor(AUTHOR)
  const input = new Uint8Array(await doc.save({ useObjectStreams: false }))

  const reply = await new Promise<{ kind?: unknown; body?: unknown }>((done, fail) => {
    const worker = new Worker(resolve('dist/apps/worker', DocumentSanitizing.THREAD_ENTRY_FILE), {
      workerData: {
        input,
        contentType: DocumentSanitizing.PDF_CONTENT_TYPE,
        maxBytes: input.length * 4
      },
      env: {},
      argv: [],
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: DocumentSanitizing.THREAD_MAX_OLD_GENERATION_MB,
        maxYoungGenerationSizeMb: DocumentSanitizing.THREAD_MAX_YOUNG_GENERATION_MB,
        stackSizeMb: DocumentSanitizing.THREAD_STACK_MB
      }
    })
    const timer = setTimeout(() => {
      fail(new Error('the thread did not answer'))
    }, DEADLINE_MS)
    worker.once('message', (message: { kind?: unknown; body?: unknown }) => {
      clearTimeout(timer)
      done(message)
    })
    worker.once('error', fail)
  })

  if (
    reply.kind !== DocumentSanitizing.ThreadReplies.SANITIZED ||
    !(reply.body instanceof Uint8Array)
  ) {
    console.error(
      `smoke-document-thread: the thread did not clean the PDF (${JSON.stringify(reply.kind)})`
    )
    exit(1)
  }
  if (Buffer.from(reply.body).includes(AUTHOR)) {
    console.error('smoke-document-thread: the cleaned PDF still carries its author')
    exit(1)
  }
  console.log('smoke-document-thread: ok')
  exit(0)
}

main().catch((error: unknown) => {
  console.error('smoke-document-thread: failed', error instanceof Error ? error.message : error)
  exit(1)
})
