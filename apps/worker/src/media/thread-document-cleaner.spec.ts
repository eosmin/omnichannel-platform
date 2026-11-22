import { join } from 'node:path'

import { type DocumentThreadOptions, ThreadDocumentCleaner } from './thread-document-cleaner'

const PDF = 'application/pdf'
const THREADS = join(__dirname, 'testing', 'threads')

const cleanerOf = (
  file: string,
  over: Partial<DocumentThreadOptions> = {}
): ThreadDocumentCleaner =>
  new ThreadDocumentCleaner({
    entryFile: join(THREADS, file),
    timeoutMs: 5000,
    maxOldGenerationMb: 64,
    maxYoungGenerationMb: 8,
    stackMb: 4,
    ...over
  })

// Step 7.3: the parse of a document runs on a thread that is stopped at its deadline and at its memory limit. The threads here are the
// documents' side of the contract (a file that spins, that eats memory, that answers badly); the cleaner itself is covered by
// `document-thread.reply.spec.ts` and by the check of the bundle
describe('ThreadDocumentCleaner', () => {
  const bytes = Buffer.from('%PDF-1.4 a customer document')

  it('hands the bytes to the thread and takes the cleaned bytes back', async () => {
    const result = await cleanerOf('answer.cjs').clean(bytes, PDF)
    expect(result).toEqual({ kind: 'sanitized', body: bytes })
  })

  it('stops a document that never lets the parser go, and says so instead of waiting', async () => {
    const started = Date.now()
    const result = await cleanerOf('hang.cjs', { timeoutMs: 300 }).clean(bytes, PDF)
    expect(result).toEqual({ kind: 'untouched', why: 'timed_out' })
    // The deadline, not the end of the test, ended it
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('keeps the event loop of the worker free while a document spins', async () => {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 20)
    try {
      await cleanerOf('hang.cjs', { timeoutMs: 600 }).clean(bytes, PDF)
    } finally {
      clearInterval(timer)
    }
    // On the main thread a spinning parse would have allowed none or one tick
    expect(ticks).toBeGreaterThan(5)
  })

  it('ends a document that passes the memory limit as one that cannot be cleaned, not as an error of the machine', async () => {
    const result = await cleanerOf('eats-memory.cjs', { timeoutMs: 20_000 }).clean(bytes, PDF)
    expect(result).toEqual({ kind: 'untouched', why: 'not_cleanable' })
  })

  it('does not take a cleaned document bigger than the limit', async () => {
    const result = await cleanerOf('oversized.cjs').clean(bytes, PDF, 1024)
    expect(result).toEqual({ kind: 'untouched', why: 'not_cleanable' })
  })

  it('does not start a thread for a file over the limit', async () => {
    // The file of the thread does not exist: it would be an error if it were looked at
    const cleaner = cleanerOf('not-there.cjs')
    await expect(cleaner.clean(Buffer.alloc(2048), PDF, 1024)).resolves.toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('does not trust the shape of what the thread sends', async () => {
    await expect(cleanerOf('garbage.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the document thread failed'
    )
  })

  it('treats a thread that fails, or ends with no answer, as a failure of the machine and never leaks what it said', async () => {
    const crash = cleanerOf('crashes.cjs').clean(bytes, PDF)
    await expect(crash).rejects.toThrow('the document thread failed')
    // The text of the error of the thread (it may hold a piece of the file) is not the text of ours
    await expect(crash).rejects.not.toThrow(/4111/)
    await expect(cleanerOf('exits.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the document thread ended with no answer'
    )
  })

  it('fails, so that the queue retries, when the bundle has no file for the thread', async () => {
    await expect(cleanerOf('not-there.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the file of the document thread is missing'
    )
  })

  it('gives the thread nothing of the process: no variable, no argument, no node option', async () => {
    // The process that runs this spec has variables (PATH at least): none of them is in the thread
    const result = await cleanerOf('sees.cjs').clean(bytes, PDF)
    expect(result.kind).toBe('sanitized')
    const seen = JSON.parse(result.kind === 'sanitized' ? result.body.toString('utf8') : '{}') as {
      env: string[]
      argv: string[]
      execArgv: string[]
    }
    expect(seen.env).toEqual([])
    expect(seen.argv).toEqual([])
    expect(seen.execArgv).toEqual([])
  })

  it('leaves no thread behind, after an answer, a timeout or a failure', async () => {
    const before = process.getActiveResourcesInfo().filter(name => name === 'MessagePort').length
    await cleanerOf('answer.cjs').clean(bytes, PDF)
    await cleanerOf('hang.cjs', { timeoutMs: 200 }).clean(bytes, PDF)
    await cleanerOf('crashes.cjs')
      .clean(bytes, PDF)
      .catch(() => undefined)
    // terminate() is awaited by nobody: give the loop a turn
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = process.getActiveResourcesInfo().filter(name => name === 'MessagePort').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('cleans one document at a time in the process', async () => {
    const cleaner = cleanerOf('hang.cjs', { timeoutMs: 400 })
    const started = Date.now()
    await Promise.all([cleaner.clean(bytes, PDF), cleaner.clean(bytes, PDF)])
    // Two deadlines one after the other, not together
    expect(Date.now() - started).toBeGreaterThanOrEqual(750)
  })
})
