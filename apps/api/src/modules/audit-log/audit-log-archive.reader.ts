import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { AuditColdRead } from '@platform/core/compliance'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { type AuditLogFilters, auditLogMatches } from '@platform/core/messaging'
import { StorageService } from '@platform/core/storage-module'

import type { AuditLogRow } from './audit-log.views'

const NEWLINE = 0x0a

// `audit/2024/03/audit-logs.jsonl.gz` is part 1 of a month, `audit/2024/03/audit-logs-part-2.jsonl.gz` the next ones
// (`StorageKeys.auditArchive`). Only a key of this shape is ever read: nothing a person typed becomes part of a key
const ARCHIVE_KEY =
  /^audit\/(\d{4})\/(0[1-9]|1[0-2])\/audit-logs(?:-part-([1-9]\d{0,3}))?\.jsonl\.gz$/

// One line of a part: the row as the cold export wrote it (`AuditColdExporter`). A line that is not this is a corrupt archive
const lineSchema = z.object({
  id: z.string().min(1),
  action: z.string(),
  userId: z.string().nullable(),
  storeId: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  metadata: z.unknown(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  timestamp: z.iso.datetime()
})

type ArchiveLine = AuditLogRow & { storeId: string | null }

interface ArchiveMonth {
  start: Date
  end: Date
  keys: string[]
}

// What one request may spend: the bytes and the time. Shared by every part the request reads
interface ReadBudget {
  parts: number
  compressed: number
  inflated: number
  signal: AbortSignal
}

export interface ArchiveCursor {
  timestamp: Date
  id: string
}

// The ceilings of a request were reached: the answer would have been short of entries, so there is none
class ArchiveLimitError extends Error {}

// The cold parts of the audit log (TDD_05 §9.3): the months older than the hot window that the nightly export moved to the
// bucket. They are read as streams, a line at a time, and only the entries of the store of the request that fit the page being
// asked for are kept, so memory is the size of the page and never of the file. Which objects are read comes from the listing
// of the bucket under a prefix of the code and from the instants of the request, never from a path a person gave. A restore
// of all the parts of a month holds each entry once, but a month that was exported twice (a part that was written before a delete
// that did not finish) may hold one in two parts: the reader keeps an entry once, by its `id`.
@Injectable()
export class AuditLogArchiveReader {
  constructor(
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AuditLogArchiveReader.name)
  }

  // The newest `size` entries of the store that match the filters and come strictly before `after` in the order of the viewer
  // (instant, then id, newest first)
  async readPage(
    storeId: string,
    filters: AuditLogFilters,
    after: ArchiveCursor | undefined,
    size: number
  ): Promise<ArchiveLine[]> {
    return this.guarded(async budget => {
      const top: ArchiveLine[] = []
      for (const month of await this.months(budget)) {
        if (month.start.getTime() >= (filters.before?.getTime() ?? Infinity)) continue
        if (after !== undefined && month.start.getTime() > after.timestamp.getTime()) continue
        // The months go from the newest: once the page is full, every older month holds only older entries
        if (top.length >= size) break
        if (filters.from !== undefined && month.end.getTime() <= filters.from.getTime()) break
        for (const key of month.keys) {
          await this.readPart(key, budget, storeId, line => {
            if (!auditLogMatches(storeId, filters, line)) return
            if (after !== undefined && !isBefore(line, after)) return
            keepNewest(top, line, size)
          })
        }
      }
      return top
    })
  }

  // One entry of the store whose instant is `at`: only the month of that instant is read
  async findById(storeId: string, id: string, at: Date): Promise<ArchiveLine | null> {
    return this.guarded(async budget => {
      const month = (await this.months(budget)).find(
        item => item.start.getTime() <= at.getTime() && at.getTime() < item.end.getTime()
      )
      if (month === undefined) return null
      const found: { row: ArchiveLine | null } = { row: null }
      for (const key of month.keys) {
        await this.readPart(key, budget, storeId, line => {
          if (line.id === id && line.storeId === storeId) found.row = line
        })
        if (found.row !== null) break
      }
      return found.row
    })
  }

  private async guarded<T>(read: (budget: ReadBudget) => Promise<T>): Promise<T> {
    const budget: ReadBudget = {
      parts: 0,
      compressed: 0,
      inflated: 0,
      signal: AbortSignal.timeout(AuditColdRead.MAX_READ_MS)
    }
    try {
      return await read(budget)
    } catch (error) {
      if (error instanceof PlatformException) throw error
      this.logger.error(
        { limit: error instanceof ArchiveLimitError, errorName: errorNameOf(error) },
        'the archive of the audit log could not be read'
      )
      throw new PlatformException(
        ErrorCodes.EXTERNAL_SERVICE_ERROR,
        'the archive of the audit log could not be read',
        HttpStatusCodes.SERVICE_UNAVAILABLE
      )
    }
  }

  // The months of the archive that the bucket holds, newest first, each with its parts in order
  private async months(budget: ReadBudget): Promise<ArchiveMonth[]> {
    const byMonth = new Map<string, { start: Date; parts: { part: number; key: string }[] }>()
    let token: string | undefined
    for (let page = 0; ; page += 1) {
      budget.signal.throwIfAborted()
      if (page >= AuditColdRead.MAX_LIST_PAGES) throw new ArchiveLimitError('too many objects')
      const listed = await this.storage.list(AuditColdRead.PREFIX, token)
      for (const object of listed.objects) {
        const match = ARCHIVE_KEY.exec(object.key)
        if (match === null) continue
        const year = Number(match[1])
        const month = Number(match[2])
        const id = `${year}-${month}`
        const entry = byMonth.get(id) ?? {
          start: new Date(Date.UTC(year, month - 1, 1)),
          parts: []
        }
        entry.parts.push({ part: match[3] === undefined ? 1 : Number(match[3]), key: object.key })
        byMonth.set(id, entry)
      }
      if (listed.next === undefined) break
      token = listed.next
    }
    return [...byMonth.values()]
      .sort((a, b) => b.start.getTime() - a.start.getTime())
      .map(({ start, parts }) => ({
        start,
        end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
        keys: parts.sort((a, b) => a.part - b.part).map(item => item.key)
      }))
  }

  // Streams one part and hands each line to `take`. Nothing but the line being read is in memory
  private async readPart(
    key: string,
    budget: ReadBudget,
    storeId: string,
    take: (line: ArchiveLine) => void
  ): Promise<void> {
    budget.parts += 1
    if (budget.parts > AuditColdRead.MAX_PARTS) throw new ArchiveLimitError('too many parts')
    const body = await this.storage.stream(key)
    // A part that listed and is gone is a month that is being replaced: the read is not complete, so it is not answered
    if (body === null) throw new Error('a part of the archive is not in the bucket')
    let tail = Buffer.alloc(0)
    // A line that does not carry the id of the store is not read at all: it is another tenant's, and it is not parsed
    const needle = Buffer.from(JSON.stringify(storeId))
    const line = (bytes: Buffer): void => {
      if (bytes.length === 0 || bytes.indexOf(needle) === -1) return
      // The error of the parser quotes a piece of the line, which is an audit row (an address, an agent): it is never passed on
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw new Error('a line of the archive is not JSON')
      }
      const result = lineSchema.safeParse(parsed)
      if (!result.success) throw new Error('a line of the archive is not an audit entry')
      const row = result.data
      take({ ...row, metadata: row.metadata ?? null, timestamp: new Date(row.timestamp) })
    }
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          budget.compressed += chunk.length
          done(
            budget.compressed > AuditColdRead.MAX_COMPRESSED_BYTES
              ? new ArchiveLimitError('too many bytes')
              : null,
            chunk
          )
        }
      }),
      createGunzip(),
      async function readLines(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          budget.inflated += chunk.length
          if (budget.inflated > AuditColdRead.MAX_INFLATED_BYTES) {
            throw new ArchiveLimitError('too many bytes inflated')
          }
          tail = Buffer.concat([tail, chunk])
          for (let end = tail.indexOf(NEWLINE); end !== -1; end = tail.indexOf(NEWLINE)) {
            line(tail.subarray(0, end))
            tail = tail.subarray(end + 1)
          }
          if (tail.length > AuditColdRead.MAX_LINE_BYTES) {
            throw new ArchiveLimitError('a line is too long')
          }
        }
        line(tail)
      },
      { signal: budget.signal }
    )
  }
}

// The order of the viewer is newest first: `row` comes before the cursor when it is older, or has the same instant and a smaller id
function isBefore(row: ArchiveCursor, cursor: ArchiveCursor): boolean {
  const diff = row.timestamp.getTime() - cursor.timestamp.getTime()
  return diff < 0 || (diff === 0 && row.id < cursor.id)
}

// Keeps `top` the newest `size` entries seen, newest first, each `id` once
function keepNewest(top: ArchiveLine[], row: ArchiveLine, size: number): void {
  if (top.some(item => item.id === row.id)) return
  const at = top.findIndex(item => isBefore(item, row))
  if (at === -1) {
    if (top.length < size) top.push(row)
    return
  }
  top.splice(at, 0, row)
  if (top.length > size) top.pop()
}

// Only the kind of the failure is logged: the message of a parser or of a stream may carry a piece of the data it was reading
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
