import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { SanitizedDocument } from '@platform/core/document-sanitizer'
import { withDecodeSlot } from '@platform/core/image-sanitizer'
import { DocumentSanitizing, UploadLimits } from '@platform/core/storage'

import {
  DocumentCleaner,
  type DocumentThreadInput,
  type DocumentThreadReply
} from './document-cleaner'

export interface DocumentThreadOptions {
  // The file the thread runs: `document-thread.js` next to `main.js` of the bundle
  entryFile: string
  timeoutMs: number
  maxOldGenerationMb: number
  maxYoungGenerationMb: number
  stackMb: number
  // How long `terminate()` is waited for before the thread is given up as stuck (see `live`)
  stopTimeoutMs: number
}

// The file of the thread is next to the bundle that is running (`node main.js`, so `process.argv[1]`)
export const bundledEntryFile = (): string =>
  join(dirname(process.argv[1] ?? ''), DocumentSanitizing.THREAD_ENTRY_FILE)

export const defaultThreadOptions = (): DocumentThreadOptions => ({
  entryFile: bundledEntryFile(),
  timeoutMs: DocumentSanitizing.THREAD_TIMEOUT_MS,
  maxOldGenerationMb: DocumentSanitizing.THREAD_MAX_OLD_GENERATION_MB,
  maxYoungGenerationMb: DocumentSanitizing.THREAD_MAX_YOUNG_GENERATION_MB,
  stackMb: DocumentSanitizing.THREAD_STACK_MB,
  stopTimeoutMs: DocumentSanitizing.THREAD_STOP_TIMEOUT_MS
})

const { ThreadReplies, Untouched } = DocumentSanitizing

// The threads of this process that have not exited yet. `terminate()` cannot interrupt a thread inside a synchronous native call (inflate) until
// it returns, so a thread can outlive its document: the cleaner then waits for it only up to `stopTimeoutMs` and, while it is alive, takes no
// new document (it throws, the caller retries): two threads of memory are never alive together
let live = 0

// Cleans a document on a thread that exists for that one document (`DocumentCleaner`). The parse is synchronous, so a hostile or huge file would
// hold the event loop of the worker for as long as it runs: here it holds a thread that is killed at the deadline (`terminate`, which stops
// even a loop that never yields) or when it passes its memory limit. What the thread has: the bytes it was handed (a copy), an empty
// environment (no database or storage address, no credential), no storage client and nothing shared with this thread. What it can send back is
// one message, checked here: a document that came out bigger than the limit is not taken.
//
// A document that hangs or eats the memory limit is the document's fault, not the machine's: it ends as `timed_out` or `not_cleanable` (kept
// as it came, logged by the caller with ids only), never as an error to retry for ever. A thread that cannot start, or ends with no answer, is
// the machine's: it throws, and the caller's own count of attempts bounds the retries (the sweep writes the attempt before it calls this).
// One at a time per process, in the decode slot that the picture decoder shares, so that two documents never hold two threads of memory.
export class ThreadDocumentCleaner extends DocumentCleaner {
  constructor(private readonly options: DocumentThreadOptions) {
    super()
  }

  clean(
    input: Buffer,
    contentType: string,
    maxBytes: number = UploadLimits.MAX_FILE_SIZE_BYTES
  ): Promise<SanitizedDocument> {
    // A file over the limit is not read by anybody (the callers read with the limit): nothing to start a thread for
    if (input.length > maxBytes) {
      return Promise.resolve({ kind: ThreadReplies.UNTOUCHED, why: Untouched.NOT_CLEANABLE })
    }
    return withDecodeSlot(() => this.runThread(input, contentType, maxBytes))
  }

  private runThread(
    input: Buffer,
    contentType: string,
    maxBytes: number
  ): Promise<SanitizedDocument> {
    const options = this.options
    if (live > 0) {
      return Promise.reject(new Error('a document thread is still running'))
    }
    if (!existsSync(options.entryFile)) {
      // A bundle without its thread file is a broken deploy: the document is not to blame and must not be marked
      return Promise.reject(new Error('the file of the document thread is missing'))
    }
    return new Promise<SanitizedDocument>((resolve, reject) => {
      const data: DocumentThreadInput = { input: new Uint8Array(input), contentType, maxBytes }
      let worker: Worker
      try {
        worker = new Worker(options.entryFile, {
          workerData: data,
          // Nothing of the process reaches the thread: no variable (database, storage keys), no argument, no node option
          env: {},
          argv: [],
          execArgv: [],
          stdout: false,
          stderr: false,
          trackUnmanagedFds: true,
          resourceLimits: {
            maxOldGenerationSizeMb: options.maxOldGenerationMb,
            maxYoungGenerationSizeMb: options.maxYoungGenerationMb,
            stackSizeMb: options.stackMb
          }
        })
      } catch {
        reject(new Error('the document thread could not be started'))
        return
      }

      live += 1
      worker.on('exit', () => {
        live -= 1
      })

      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Always: a finished thread is a no-op, a live one (a late answer, a timeout) is stopped, and the slot is not released until it
        // is, or until `stopTimeoutMs` says it is stuck (then this fails and `live` keeps the next document out until it exits)
        let stopTimer: NodeJS.Timeout | undefined
        const stopped = new Promise<boolean>(done => {
          stopTimer = setTimeout(() => {
            done(false)
          }, options.stopTimeoutMs)
          worker.terminate().then(
            () => {
              done(true)
            },
            () => {
              done(true)
            }
          )
        })
        void stopped.then(ok => {
          clearTimeout(stopTimer)
          if (ok) settle()
          else reject(new Error('the document thread did not stop'))
        })
      }
      const timer = setTimeout(() => {
        finish(() => resolve({ kind: ThreadReplies.UNTOUCHED, why: Untouched.TIMED_OUT }))
      }, options.timeoutMs)

      worker.once('message', (reply: unknown) => {
        finish(() => {
          const answer = this.accept(reply, maxBytes)
          if (answer === ThreadReplies.ENVIRONMENT) reject(new Error('the document thread failed'))
          else resolve(answer)
        })
      })
      worker.once('error', (error: NodeJS.ErrnoException) => {
        finish(() => {
          // The memory limit of the thread is the document's doing; anything else that escapes the thread is not a verdict on the document
          if (error.code === DocumentSanitizing.THREAD_OUT_OF_MEMORY_CODE)
            resolve({ kind: ThreadReplies.UNTOUCHED, why: Untouched.NOT_CLEANABLE })
          else reject(new Error('the document thread failed'))
        })
      })
      worker.once('exit', () => {
        finish(() => {
          reject(new Error('the document thread ended with no answer'))
        })
      })
    })
  }

  // The message of the thread is data from a process that parsed a hostile file: its shape and its size are checked before it is used
  private accept(
    reply: unknown,
    maxBytes: number
  ): SanitizedDocument | typeof ThreadReplies.ENVIRONMENT {
    const message = reply as Partial<DocumentThreadReply> | null
    if (message === null || typeof message !== 'object') return ThreadReplies.ENVIRONMENT
    if (message.kind === ThreadReplies.ENVIRONMENT) return ThreadReplies.ENVIRONMENT
    if (message.kind === ThreadReplies.UNTOUCHED) {
      const why = message.why
      if (
        why === Untouched.TYPE ||
        why === Untouched.ALREADY_CLEAN ||
        why === Untouched.NOT_CLEANABLE
      ) {
        return { kind: ThreadReplies.UNTOUCHED, why }
      }
      return ThreadReplies.ENVIRONMENT
    }
    if (message.kind === ThreadReplies.SANITIZED && message.body instanceof Uint8Array) {
      // A result over the limit is a document that is not worth the rewrite, as `sanitizeDocumentInline` decides for its own result
      if (message.body.byteLength > maxBytes)
        return { kind: ThreadReplies.UNTOUCHED, why: Untouched.NOT_CLEANABLE }
      return {
        kind: ThreadReplies.SANITIZED,
        body: Buffer.from(message.body.buffer, message.body.byteOffset, message.body.byteLength)
      }
    }
    return ThreadReplies.ENVIRONMENT
  }
}
