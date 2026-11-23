import { createHash } from 'node:crypto'

import type { PinoLogger } from 'nestjs-pino'

import {
  DatabaseNull,
  JobContextGoneError,
  type JobContext,
  type PrismaService
} from '@platform/core/database'
import { AvSanitizing, ExistingAvSweep, MediaPurpose, UploadLimits } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import type { AvCleaner, CleanedAv } from './av-cleaner'
import { ExistingAvSanitizer } from './existing-av-sanitizer.service'
import { AvToolUnavailable } from './ffmpeg-av-cleaner'

const STORE = 'store-1'
const OTHER_STORE = 'store-2'
const MP4 = 'video/mp4'
const { MAX_ATTEMPTS, ATTEMPTS_KEY } = ExistingAvSweep
const VERSION = AvSanitizing.CLEANING_VERSION
const CLEANED_MARK = { sanitized: true, [AvSanitizing.CLEANING_VERSION_KEY]: VERSION }
const kept = (outcome: string): Record<string, unknown> => ({
  [AvSanitizing.OUTCOME_KEY]: outcome,
  [AvSanitizing.CLEANING_VERSION_KEY]: VERSION
})

interface Row {
  id: string
  storeId: string
  key: string
  contentType: string
  purpose: string
  status: string
  fileSize: number
  scanResult: Record<string, unknown> | null
}

type Condition = Record<string, unknown>
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// A condition on `scanResult`, read as the database reads it: the null, a whole value, or a number under a key
function scanMatches(row: Row, guard: Condition): boolean {
  const path = guard.path as string[] | undefined
  if (path !== undefined) {
    const value = row.scanResult?.[path[0] as string]
    if ('equals' in guard) return value === guard.equals
    if (typeof value !== 'number') return false
    if ('lt' in guard) return value < (guard.lt as number)
    if ('gte' in guard) return value >= (guard.gte as number)
    return false
  }
  return guard.equals === DatabaseNull
    ? row.scanResult === null
    : sameJson(row.scanResult, guard.equals)
}

// A where of the sweep, read whole: every key must hold, so a query that drops the store, the status or a condition takes the wrong rows
function matches(row: Row, where: Condition): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Condition[]).some(part => matches(row, part))
    if (key === 'scanResult') return scanMatches(row, value as Condition)
    const field = (row as unknown as Record<string, unknown>)[key]
    if (typeof value === 'object' && value !== null && 'in' in value) {
      return (value as { in: unknown[] }).in.includes(field)
    }
    return field === value
  })
}

describe('ExistingAvSanitizer', () => {
  let bucket: Map<string, Buffer>
  let rows: Row[]
  let puts: string[]
  let headCalls: Map<string, number>
  let changeAfterFirstHead: boolean
  let behaviour: (id: string) => Promise<CleanedAv>
  let updates: { where: Condition; data: Condition }[]
  let denyRowWrite: boolean

  const etagOf = (key: string): string =>
    createHash('md5')
      .update(bucket.get(key) ?? '')
      .digest('hex')
  const storage = {
    head: jest.fn((key: string) => {
      const body = bucket.get(key)
      if (body === undefined) return Promise.resolve(null)
      const calls = (headCalls.get(key) ?? 0) + 1
      headCalls.set(key, calls)
      return Promise.resolve({
        etag: changeAfterFirstHead && calls > 1 ? 'changed' : etagOf(key),
        contentLength: body.length
      })
    }),
    read: jest.fn((key: string) => Promise.resolve(bucket.get(key) ?? null)),
    delete: jest.fn(),
    put: jest.fn((key: string, body: Buffer) => {
      puts.push(key)
      bucket.set(key, body)
      return Promise.resolve()
    })
  }
  const prisma = {
    client: {
      media: {
        findMany: jest.fn((args: { where: Condition; take: number }) =>
          Promise.resolve(
            rows
              .filter(row => matches(row, args.where))
              .sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, args.take)
          )
        ),
        updateMany: jest.fn((args: { where: Condition; data: Condition }) => {
          updates.push(args)
          const hit = rows.filter(row => matches(row, args.where))
          // The row changed (or went) between the object being written and the mark
          if (denyRowWrite && args.data.fileSize !== undefined) return Promise.resolve({ count: 0 })
          for (const row of hit) {
            row.scanResult = args.data.scanResult as Record<string, unknown>
            if (args.data.fileSize !== undefined) row.fileSize = args.data.fileSize as number
          }
          return Promise.resolve({ count: hit.length })
        })
      }
    }
  }
  const metric = { inc: jest.fn() }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const cleaner: AvCleaner = { clean: (_input, _type, id) => behaviour(id) }
  const sanitizer = new ExistingAvSanitizer(
    prisma as unknown as PrismaService,
    { forStore: (_id: string, work: () => Promise<unknown>) => work() } as unknown as JobContext,
    storage as unknown as StorageService,
    logger as unknown as PinoLogger,
    cleaner,
    metric as never
  )
  const cleanedBody = Buffer.from('clean')

  function store(
    id: string,
    options: {
      body?: Buffer
      contentType?: string
      purpose?: string
      scanResult?: Row['scanResult']
      key?: string
      storeId?: string
      status?: string
    } = {}
  ): Row {
    const storeId = options.storeId ?? STORE
    const key = options.key ?? `stores/${storeId}/${id}`
    const body = options.body ?? Buffer.from('dirty video with gps')
    bucket.set(key, body)
    const row: Row = {
      id,
      storeId,
      key,
      contentType: options.contentType ?? MP4,
      purpose: options.purpose ?? MediaPurpose.MESSAGE,
      status: options.status ?? 'clean',
      fileSize: body.length,
      scanResult: options.scanResult ?? null
    }
    rows.push(row)
    return row
  }

  beforeEach(() => {
    bucket = new Map()
    rows = []
    puts = []
    updates = []
    headCalls = new Map()
    changeAfterFirstHead = false
    denyRowWrite = false
    behaviour = () => Promise.resolve({ kind: 'cleaned', body: cleanedBody, hadMetadata: true })
    jest.clearAllMocks()
  })

  it('rewrites a stored file with no mark, writes the new size and the version, and counts it', async () => {
    const row = store('v1')

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ cleaned: 1, kept: 0, unavailable: 0, failed: 0 })
    expect(bucket.get(row.key)).toEqual(cleanedBody)
    expect(row.fileSize).toBe(cleanedBody.length)
    expect(row.scanResult).toEqual(CLEANED_MARK)
    expect(metric.inc).toHaveBeenCalledWith({ result: AvSanitizing.Outcomes.CLEANED })
  })

  it('does not copy a file again on the next run: the version mark is what says it was done', async () => {
    store('v1')
    await sanitizer.runScoped([STORE])
    puts = []

    const second = await sanitizer.runScoped([STORE])

    expect(second).toEqual({ cleaned: 0, kept: 0, unavailable: 0, skipped: 0, failed: 0 })
    expect(puts).toEqual([])
  })

  it('takes a file marked by an older version of the cleaning and leaves the one of the current version', async () => {
    const old = store('old', { scanResult: { sanitized: true, cleaningVersion: VERSION - 1 } })
    const current = store('now', { scanResult: CLEANED_MARK })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(1)
    expect(old.scanResult).toEqual(CLEANED_MARK)
    expect(puts).toEqual([old.key])
    expect(current.scanResult).toEqual(CLEANED_MARK)
  })

  it('takes an inbound file the scan kept as `av_unavailable` and cleans it once the tools are back', async () => {
    const row = store('in', { scanResult: kept(AvSanitizing.Outcomes.AV_UNAVAILABLE) })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(1)
    expect(row.scanResult).toEqual(CLEANED_MARK)
  })

  it('keeps the mark of an unavailable file on the row while it works on it, so it is never sendable in between', async () => {
    store('in', { scanResult: kept(AvSanitizing.Outcomes.AV_UNAVAILABLE) })
    let seenDuring: Record<string, unknown> | null = null
    behaviour = () => {
      seenDuring = rows[0]?.scanResult ?? null
      return Promise.resolve({ kind: 'cleaned', body: cleanedBody, hadMetadata: true })
    }

    await sanitizer.runScoped([STORE])

    expect(seenDuring).toMatchObject({
      [AvSanitizing.OUTCOME_KEY]: AvSanitizing.Outcomes.AV_UNAVAILABLE,
      [ATTEMPTS_KEY]: 1
    })
  })

  it('leaves a missing tool as `av_unavailable` and takes the file again on every run, with no attempt counted, however many runs', async () => {
    behaviour = () => Promise.reject(new AvToolUnavailable())
    const row = store('v1')

    for (let run = 0; run < MAX_ATTEMPTS + 2; run += 1) {
      const report = await sanitizer.runScoped([STORE])
      expect(report).toMatchObject({ unavailable: 1, failed: 0, cleaned: 0 })
    }

    expect(row.scanResult).toEqual(kept(AvSanitizing.Outcomes.AV_UNAVAILABLE))
    expect(row.scanResult).not.toHaveProperty(ATTEMPTS_KEY)
    expect(puts).toEqual([])
    expect(bucket.get(row.key)).toEqual(Buffer.from('dirty video with gps'))
    expect(metric.inc).toHaveBeenCalledWith({ result: AvSanitizing.Outcomes.AV_UNAVAILABLE })
  })

  it('ends the run at the first file when the tools are missing: one object is read, not the whole batch', async () => {
    behaviour = () => Promise.reject(new AvToolUnavailable())
    store('v1')
    store('v2')
    store('v3')

    const report = await sanitizer.runScoped([STORE])

    expect(report.unavailable).toBe(1)
    expect(storage.read).toHaveBeenCalledTimes(1)
    expect(rows.filter(row => row.scanResult === null)).toHaveLength(2)
  })

  it('skips a store that is deleted while its batch runs, with no failure counted', async () => {
    store('v1')
    behaviour = () => Promise.reject(new JobContextGoneError('store-1'))

    const report = await sanitizer.runScoped([STORE])

    expect(report.failed).toBe(0)
  })

  it('becomes final `attempts_exhausted` after a deadline with THIS file MAX_ATTEMPTS times, and is never taken again', async () => {
    behaviour = () => Promise.resolve({ kind: 'untouched', why: AvSanitizing.Untouched.TIMED_OUT })
    const row = store('slow')

    for (let run = 1; run < MAX_ATTEMPTS; run += 1) {
      await sanitizer.runScoped([STORE])
      expect(row.scanResult).toEqual({ [ATTEMPTS_KEY]: run })
    }
    const last = await sanitizer.runScoped([STORE])

    expect(last.kept).toBe(1)
    expect(row.scanResult).toEqual(kept(ExistingAvSweep.ATTEMPTS_EXHAUSTED))
    const calls = storage.read.mock.calls.length
    await sanitizer.runScoped([STORE])
    expect(storage.read.mock.calls.length).toBe(calls)
    expect(puts).toEqual([])
    expect(bucket.get(row.key)).toEqual(Buffer.from('dirty video with gps'))
  })

  it('counts an error that is not the tools missing (a crash of the cleaner) and ends the file at MAX_ATTEMPTS, logged and kept', async () => {
    behaviour = () => Promise.reject(new Error('the child died'))
    const row = store('poison')

    for (let run = 0; run < MAX_ATTEMPTS; run += 1) {
      expect(await sanitizer.runScoped([STORE])).toMatchObject({ failed: 1 })
    }

    expect(row.scanResult).toEqual(kept(ExistingAvSweep.ATTEMPTS_EXHAUSTED))
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'poison', last: true }),
      expect.any(String)
    )
  })

  it('closes a file that a process death left at MAX_ATTEMPTS before it reads the batch, and does not open it', async () => {
    const row = store('dead', { scanResult: { [ATTEMPTS_KEY]: MAX_ATTEMPTS } })

    const report = await sanitizer.runScoped([STORE])

    expect(report).toEqual({ cleaned: 0, kept: 0, unavailable: 0, skipped: 0, failed: 0 })
    expect(row.scanResult).toEqual(kept(ExistingAvSweep.ATTEMPTS_EXHAUSTED))
    expect(storage.read).not.toHaveBeenCalled()
  })

  it('closes an unavailable file that reached MAX_ATTEMPTS too (the kept mark does not make it immortal)', async () => {
    const row = store('both', {
      scanResult: { ...kept(AvSanitizing.Outcomes.AV_UNAVAILABLE), [ATTEMPTS_KEY]: MAX_ATTEMPTS }
    })

    await sanitizer.runScoped([STORE])

    expect(row.scanResult).toEqual(kept(ExistingAvSweep.ATTEMPTS_EXHAUSTED))
    expect(storage.read).not.toHaveBeenCalled()
  })

  it('persists the attempt BEFORE the cleaner runs', async () => {
    store('v1')
    let during: unknown = null
    behaviour = () => {
      during = rows[0]?.scanResult
      return Promise.resolve({ kind: 'cleaned', body: cleanedBody, hadMetadata: true })
    }

    await sanitizer.runScoped([STORE])

    expect(during).toEqual({ [ATTEMPTS_KEY]: 1 })
  })

  it('keeps a file that cannot be cleaned without risk as it came, with a FINAL mark that no later run takes', async () => {
    behaviour = () =>
      Promise.resolve({ kind: 'untouched', why: AvSanitizing.Untouched.NOT_CLEANABLE })
    const row = store('odd')

    const report = await sanitizer.runScoped([STORE])
    const again = await sanitizer.runScoped([STORE])

    expect(report.kept).toBe(1)
    expect(again.kept).toBe(0)
    expect(row.scanResult).toEqual(kept(AvSanitizing.Untouched.NOT_CLEANABLE))
    expect(puts).toEqual([])
    expect(metric.inc).toHaveBeenCalledWith({ result: AvSanitizing.Outcomes.NOT_CLEANABLE })
  })

  it('never writes over an object that changed while it was cleaned, and leaves the row without a mark', async () => {
    changeAfterFirstHead = true
    const row = store('moving')

    const report = await sanitizer.runScoped([STORE])

    expect(report.skipped).toBe(1)
    expect(puts).toEqual([])
    expect(row.scanResult).toEqual({ [ATTEMPTS_KEY]: 1 })
  })

  it('does not take the object back when the row no longer matches after the write (the row still exists)', async () => {
    denyRowWrite = true
    store('v1')

    const report = await sanitizer.runScoped([STORE])

    expect(report.skipped).toBe(1)
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('reads with the limit of a video and not the 10 MB of a document, and refuses to read what is over it', async () => {
    store('big', { body: Buffer.alloc(UploadLimits.MAX_FILE_SIZE_BYTES + 1) })
    store('huge', { body: Buffer.alloc(UploadLimits.MAX_VIDEO_SIZE_BYTES + 1) })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(1)
    expect(report.kept).toBe(1)
    expect(storage.read).toHaveBeenCalledTimes(1)
    expect(storage.read).toHaveBeenCalledWith(
      expect.stringContaining('big'),
      UploadLimits.MAX_VIDEO_SIZE_BYTES
    )
    expect(rows.find(row => row.id === 'huge')?.scanResult).toEqual(
      kept(AvSanitizing.Untouched.TOO_LARGE)
    )
  })

  it('takes only the rows of the stores it names, only `clean` ones, and only the purposes it sweeps', async () => {
    const other = store('o1', { storeId: OTHER_STORE })
    const pending = store('p1', { status: 'pending' })
    const evidence = store('e1', { purpose: MediaPurpose.FISCAL_EVIDENCE })
    const picture = store('pic', { contentType: 'image/png' })
    const mine = store('m1')

    await sanitizer.runScoped([STORE])

    for (const untouched of [other, pending, evidence, picture]) {
      expect(untouched.scanResult).toBeNull()
      expect(puts).not.toContain(untouched.key)
    }
    expect(mine.scanResult).toEqual(CLEANED_MARK)
    // The read itself is scoped: the guard of the write is the second lock on the door, not the first
    for (const [args] of prisma.client.media.findMany.mock.calls) {
      expect(args.where).toMatchObject({ storeId: STORE, status: 'clean' })
    }
  })

  it('writes every row it changes under the store and the `clean` status of the row', async () => {
    store('v1')

    await sanitizer.runScoped([STORE])

    expect(updates.length).toBeGreaterThan(0)
    for (const update of updates) {
      expect(update.where).toMatchObject({ storeId: STORE })
    }
    for (const update of updates.filter(item => item.where.id !== undefined)) {
      expect(update.where).toMatchObject({ status: 'clean' })
    }
  })

  it('leaves a key outside the folder of its store alone and marks it', async () => {
    const row = store('alien', { key: 'stores/another-store/alien' })

    const report = await sanitizer.runScoped([STORE])

    expect(report.kept).toBe(1)
    expect(storage.read).not.toHaveBeenCalled()
    expect(row.scanResult).toEqual(kept('foreign_key'))
  })

  it('logs ids and reasons only: no key, no content type of a customer file', async () => {
    behaviour = () => Promise.resolve({ kind: 'untouched', why: AvSanitizing.Untouched.TIMED_OUT })
    store('slow')

    await sanitizer.runScoped([STORE])

    const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])
    expect(logged).not.toContain('stores/')
    expect(logged).toContain('slow')
  })

  it('takes no file at all for an empty list of stores', async () => {
    store('v1')

    expect(await sanitizer.runScoped([])).toEqual({
      cleaned: 0,
      kept: 0,
      unavailable: 0,
      skipped: 0,
      failed: 0
    })
    expect(puts).toEqual([])
  })
})
