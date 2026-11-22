import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

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
    stopTimeoutMs: 2000,
    ...over
  })

// Step 7.3: the parse of a document runs on a thread that is stopped at its deadline and at its memory limit. The threads here are the
// documents' side of the contract (a file that spins, that eats memory, that answers badly); the cleaner itself is covered by
// `document-thread.reply.spec.ts` and by the check of the bundle
describe('ThreadDocumentCleaner', () => {
  const bytes = Buffer.from('%PDF-1.4 a customer document\n%%EOF\n')

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

  it('does not take bytes the thread can still change: memory shared with it is refused', async () => {
    await expect(cleanerOf('shared-memory.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the document thread failed'
    )
  })

  it('does not take a result that does not begin as the type of the document', async () => {
    await expect(cleanerOf('wrong-type.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the document thread failed'
    )
  })

  // The check reads two ends of the bytes the cleaner just wrote, so a document that was cleaned is never refused for how its original was
  // padded; these cases show the windows are wide enough for what a writer may leave
  it('accepts a PDF with 900 bytes after its end mark, and a zip whose end record has a 60 000 byte comment before the end of the file', async () => {
    const padded = Buffer.concat([bytes, Buffer.alloc(900, 0x20)])
    await expect(cleanerOf('answer.cjs').clean(padded, PDF)).resolves.toEqual({
      kind: 'sanitized',
      body: padded
    })
    const record = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(16),
      Buffer.from([0x60, 0xea]), // the length of the comment: 60 000
      Buffer.alloc(60_000, 0x41)
    ])
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64), record])
    await expect(
      cleanerOf('answer.cjs').clean(
        zip,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).resolves.toEqual({ kind: 'sanitized', body: zip })
  })

  it('refuses the right beginning with a body of garbage, and never hands it on', async () => {
    const garbage = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5000, 0x41)])
    await expect(cleanerOf('answer.cjs').clean(garbage, PDF)).rejects.toThrow(
      'the document thread failed'
    )
  })

  it('does not take a result that begins as the type but does not end as it', async () => {
    await expect(cleanerOf('cut-short.cjs').clean(bytes, PDF)).rejects.toThrow(
      'the document thread failed'
    )
    await expect(
      cleanerOf('zip-without-end.cjs').clean(
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
    ).rejects.toThrow('the document thread failed')
  })

  it('survives a thread that holds gigabytes of buffers, which the heap limit of the thread does not count', async () => {
    const result = await cleanerOf('buffers.cjs', { timeoutMs: 20_000 }).clean(bytes, PDF)
    expect(result).toEqual({ kind: 'untouched', why: 'not_cleanable' })
    // The thread is gone and so is its memory: the process still works
    await expect(cleanerOf('answer.cjs').clean(bytes, PDF)).resolves.toEqual({
      kind: 'sanitized',
      body: bytes
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
    const seen = JSON.parse(
      result.kind === 'sanitized'
        ? result.body.toString('utf8').slice('%PDF-'.length).replace('\n%%EOF', '')
        : '{}'
    ) as {
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

  it('stops the thread on every way out: an answer, a deadline, the memory limit, a crash, an exit and a bad answer', async () => {
    const terminate = jest.spyOn(Worker.prototype, 'terminate')
    try {
      const ways: [string, Partial<DocumentThreadOptions>][] = [
        ['answer.cjs', {}],
        ['hang.cjs', { timeoutMs: 200 }],
        ['eats-memory.cjs', { timeoutMs: 20_000 }],
        ['crashes.cjs', {}],
        ['exits.cjs', {}],
        ['garbage.cjs', {}]
      ]
      for (const [file, over] of ways) {
        const before = terminate.mock.calls.length
        await cleanerOf(file, over)
          .clean(bytes, PDF)
          .catch(() => undefined)
        // One thread was started and it was stopped, whatever happened to it
        expect(terminate.mock.calls.length - before).toBe(1)
      }
    } finally {
      terminate.mockRestore()
    }
  })

  it('survives a document that eats memory: the limit stops the thread, the process of the worker keeps its own heap and keeps working', async () => {
    const heapBefore = process.memoryUsage().heapUsed
    const result = await cleanerOf('eats-memory.cjs', { timeoutMs: 20_000 }).clean(bytes, PDF)
    expect(result).toEqual({ kind: 'untouched', why: 'not_cleanable' })
    // The 64 MB limit of the thread is not the heap of this process: it did not grow by anything near it
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(48 * 1024 * 1024)
    // and the next document is cleaned as if nothing had happened
    await expect(cleanerOf('answer.cjs').clean(bytes, PDF)).resolves.toEqual({
      kind: 'sanitized',
      body: bytes
    })
  })

  it('does not start another thread while one that could not be stopped is alive, and fails instead of waiting for it for ever', async () => {
    // A thread that does not answer to terminate() in time (inside a native call): the call never settles
    const refuse = jest
      .spyOn(Worker.prototype, 'terminate')
      .mockImplementationOnce(() => new Promise<number>(() => undefined))
    try {
      const cleaner = cleanerOf('spins-then-ends.cjs', { timeoutMs: 200, stopTimeoutMs: 300 })
      await expect(cleaner.clean(bytes, PDF)).rejects.toThrow('the document thread did not stop')
      // The sweep asks this before it counts an attempt: it is true while the thread lives, for every cleaner of the process
      expect(cleaner.isBusy()).toBe(true)
      expect(cleanerOf('answer.cjs').isBusy()).toBe(true)
      // It is still running: no second thread of memory beside it
      await expect(cleanerOf('answer.cjs').clean(bytes, PDF)).rejects.toThrow(
        'a document thread is still running'
      )
      // Once it is gone the cleaner takes documents again
      await new Promise(resolve => setTimeout(resolve, 1500))
      expect(cleaner.isBusy()).toBe(false)
      await expect(cleanerOf('answer.cjs').clean(bytes, PDF)).resolves.toEqual({
        kind: 'sanitized',
        body: bytes
      })
    } finally {
      refuse.mockRestore()
    }
  })
})
