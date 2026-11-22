import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import type { PinoLogger } from 'nestjs-pino'

import { AuditColdRead } from '@platform/core/compliance'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import type { StorageService } from '@platform/core/storage-module'

import { AuditLogArchiveReader } from './audit-log-archive.reader'

const STORE = 'store-a'
const OTHER = 'store-b'

interface Line {
  id: string
  storeId: string | null
  timestamp: string
  action?: string
}

const toLine = (line: Line): string =>
  JSON.stringify({
    id: line.id,
    action: line.action ?? 'order.created',
    userId: null,
    storeId: line.storeId,
    organizationId: null,
    resourceType: null,
    resourceId: null,
    metadata: { n: 1 },
    ipAddress: null,
    userAgent: null,
    timestamp: line.timestamp
  })

const part = (lines: Line[]): Buffer => gzipSync(`${lines.map(toLine).join('\n')}\n`)

// An in-memory bucket: key -> bytes. `streamed` records every key a read opened
function bucket(objects: Record<string, Buffer>) {
  const streamed: string[] = []
  const storage = {
    list: jest.fn((prefix: string) =>
      Promise.resolve({
        objects: Object.keys(objects)
          .filter(key => key.startsWith(prefix))
          .map(key => ({ key, lastModified: new Date() })),
        next: undefined
      })
    ),
    stream: jest.fn((key: string) => {
      streamed.push(key)
      const bytes = objects[key]
      return Promise.resolve(bytes === undefined ? null : Readable.from([bytes]))
    })
  }
  const logger = { setContext: jest.fn(), error: jest.fn() }
  return {
    logger,
    streamed,
    storage,
    reader: new AuditLogArchiveReader(
      storage as unknown as StorageService,
      logger as unknown as PinoLogger
    )
  }
}

const MARCH = 'audit/2001/03/audit-logs.jsonl.gz'
const MARCH_2 = 'audit/2001/03/audit-logs-part-2.jsonl.gz'
const APRIL = 'audit/2001/04/audit-logs.jsonl.gz'

describe('AuditLogArchiveReader', () => {
  it('reads the entries of the store only, newest first, across months and parts', async () => {
    const { reader } = bucket({
      [MARCH]: part([
        { id: 'a1', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' },
        { id: 'b1', storeId: OTHER, timestamp: '2001-03-03T00:00:00.000Z' },
        { id: 'n1', storeId: null, timestamp: '2001-03-04T00:00:00.000Z' }
      ]),
      [MARCH_2]: part([{ id: 'a2', storeId: STORE, timestamp: '2001-03-20T00:00:00.000Z' }]),
      [APRIL]: part([{ id: 'a3', storeId: STORE, timestamp: '2001-04-01T00:00:00.000Z' }])
    })

    const rows = await reader.readPage(STORE, {}, undefined, 10)

    expect(rows.map(row => row.id)).toEqual(['a3', 'a2', 'a1'])
  })

  it('keeps an entry once when two parts hold it (an export that was not finished)', async () => {
    const dup = { id: 'dup', storeId: STORE, timestamp: '2001-03-10T00:00:00.000Z' }
    const { reader } = bucket({ [MARCH]: part([dup]), [MARCH_2]: part([dup]) })

    expect((await reader.readPage(STORE, {}, undefined, 10)).map(row => row.id)).toEqual(['dup'])
  })

  it('returns the page that follows the cursor, with the same instant ordered by id', async () => {
    const at = '2001-03-10T00:00:00.000Z'
    const { reader } = bucket({
      [MARCH]: part([
        { id: 'c', storeId: STORE, timestamp: at },
        { id: 'b', storeId: STORE, timestamp: at },
        { id: 'a', storeId: STORE, timestamp: at },
        { id: 'z', storeId: STORE, timestamp: '2001-03-11T00:00:00.000Z' }
      ])
    })

    const first = await reader.readPage(STORE, {}, undefined, 2)
    expect(first.map(row => row.id)).toEqual(['z', 'c'])
    const last = first.at(-1)
    if (last === undefined) throw new Error('empty page')
    const next = await reader.readPage(STORE, {}, { timestamp: last.timestamp, id: last.id }, 2)
    expect(next.map(row => row.id)).toEqual(['b', 'a'])
  })

  it('applies the filters like the database does and skips the months the range leaves out', async () => {
    const { reader, streamed } = bucket({
      [MARCH]: part([{ id: 'm', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' }]),
      [APRIL]: part([
        { id: 'x', storeId: STORE, timestamp: '2001-04-02T00:00:00.000Z', action: 'order.paid' },
        { id: 'y', storeId: STORE, timestamp: '2001-04-03T00:00:00.000Z' }
      ])
    })

    const rows = await reader.readPage(
      STORE,
      { action: 'order.paid', from: new Date('2001-04-01T00:00:00.000Z') },
      undefined,
      10
    )

    expect(rows.map(row => row.id)).toEqual(['x'])
    expect(streamed).toEqual([APRIL])
  })

  it('stops at the month that fills the page and does not open the older ones', async () => {
    const { reader, streamed } = bucket({
      [MARCH]: part([{ id: 'old', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' }]),
      [APRIL]: part([
        { id: 'n1', storeId: STORE, timestamp: '2001-04-02T00:00:00.000Z' },
        { id: 'n2', storeId: STORE, timestamp: '2001-04-03T00:00:00.000Z' }
      ])
    })

    expect((await reader.readPage(STORE, {}, undefined, 2)).map(row => row.id)).toEqual([
      'n2',
      'n1'
    ])
    expect(streamed).toEqual([APRIL])
  })

  it('reads only objects of the shape of the export: a key that is not one is ignored', async () => {
    const { reader, streamed } = bucket({
      'audit/2001/03/../../x.jsonl.gz': part([
        { id: 'evil', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' }
      ]),
      'audit/2001/13/audit-logs.jsonl.gz': part([
        { id: 'month13', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' }
      ]),
      'audit/readme.txt': Buffer.from('x')
    })

    expect(await reader.readPage(STORE, {}, undefined, 10)).toEqual([])
    expect(streamed).toEqual([])
  })

  it('finds one entry of the store in the month of its instant, and never one of another store', async () => {
    const { reader, streamed } = bucket({
      [MARCH]: part([
        { id: 'mine', storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' },
        { id: 'theirs', storeId: OTHER, timestamp: '2001-03-02T00:00:00.000Z' }
      ]),
      [APRIL]: part([{ id: 'april', storeId: STORE, timestamp: '2001-04-02T00:00:00.000Z' }])
    })
    const at = new Date('2001-03-02T00:00:00.000Z')

    expect((await reader.findById(STORE, 'mine', at))?.id).toBe('mine')
    expect(await reader.findById(STORE, 'theirs', at)).toBeNull()
    // The entry of April is not looked for in the month of March
    expect(await reader.findById(STORE, 'april', at)).toBeNull()
    expect(streamed).not.toContain(APRIL)
  })

  it('does not read a line of another store, even a corrupt one', async () => {
    const { reader } = bucket({ [MARCH]: gzipSync(`{"id":"x","storeId":"${OTHER}"\n`) })

    expect(await reader.readPage(STORE, {}, undefined, 10)).toEqual([])
  })

  it('refuses a corrupt line instead of answering a page that is short of entries', async () => {
    const { reader } = bucket({ [MARCH]: gzipSync(`{"id":"x","storeId":"${STORE}"}\n`) })

    await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toMatchObject({
      code: ErrorCodes.EXTERNAL_SERVICE_ERROR
    })
  })

  it('keeps the text of a corrupt line out of the error and the log', async () => {
    // The error of the parser quotes the few characters that follow the bad token: the secret sits inside that window
    const secret = '7.7.7.7'
    const { reader, logger } = bucket({
      [MARCH]: gzipSync(`{"storeId":"${STORE}","id":x${secret}}\n`)
    })

    const error: unknown = await reader.readPage(STORE, {}, undefined, 10).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformException)
    // An Error is read with its message, as a logger that serializes errors does
    const asText = JSON.stringify([(error as Error).message, logger.error.mock.calls], (_k, v) =>
      v instanceof Error ? { name: v.name, message: v.message } : (v as unknown)
    )
    expect(asText).not.toContain(secret)
    expect(JSON.stringify(logger.error.mock.calls)).toContain('errorName')
  })

  it('does not list a row of another store that quotes the id of this one', async () => {
    const { reader } = bucket({
      [MARCH]: gzipSync(
        `${JSON.stringify({
          id: 'b-row',
          action: 'order.created',
          userId: null,
          storeId: OTHER,
          resourceType: null,
          resourceId: null,
          metadata: { storeId: STORE },
          ipAddress: null,
          userAgent: null,
          timestamp: '2001-03-02T00:00:00.000Z'
        })}\n`
      )
    })

    expect(await reader.readPage(STORE, {}, undefined, 10)).toEqual([])
  })

  it('refuses a part that listed and is gone', async () => {
    const { reader, storage } = bucket({ [MARCH]: part([]) })
    storage.stream.mockResolvedValueOnce(null)

    await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
      PlatformException
    )
  })

  it('refuses a line longer than the ceiling without holding it', async () => {
    const huge = gzipSync(`"${STORE}"${'x'.repeat(AuditColdRead.MAX_LINE_BYTES + 10)}\n`)
    const { reader } = bucket({ [MARCH]: huge })

    await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
      PlatformException
    )
  })

  describe('ceilings of one request', () => {
    const ceilings = AuditColdRead as unknown as Record<string, number>
    const own = (id: string) => ({ id, storeId: STORE, timestamp: '2001-03-02T00:00:00.000Z' })
    afterEach(() => jest.restoreAllMocks())

    it('refuses more inflated bytes than the ceiling, even from a small gzip', async () => {
      jest.replaceProperty(ceilings, 'MAX_INFLATED_BYTES', 200)
      const { reader } = bucket({ [MARCH]: part([own('a'), own('b'), own('c'), own('d')]) })

      await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
        PlatformException
      )
    })

    it('refuses more compressed bytes than the ceiling', async () => {
      jest.replaceProperty(ceilings, 'MAX_COMPRESSED_BYTES', 10)
      const { reader } = bucket({ [MARCH]: part([own('a')]) })

      await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
        PlatformException
      )
    })

    it('refuses to open more parts than the ceiling', async () => {
      jest.replaceProperty(ceilings, 'MAX_PARTS', 1)
      const { reader } = bucket({ [MARCH]: part([own('a')]), [MARCH_2]: part([own('b')]) })

      await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
        PlatformException
      )
    })

    it('refuses a listing longer than the ceiling of pages', async () => {
      jest.replaceProperty(ceilings, 'MAX_LIST_PAGES', 1)
      const { reader, storage } = bucket({ [MARCH]: part([own('a')]) })
      storage.list.mockResolvedValue({ objects: [], next: 'more' } as never)

      await expect(reader.readPage(STORE, {}, undefined, 10)).rejects.toBeInstanceOf(
        PlatformException
      )
    })

    it('answers within the ceilings', async () => {
      const { reader } = bucket({ [MARCH]: part([own('a')]) })

      expect((await reader.readPage(STORE, {}, undefined, 10)).map(row => row.id)).toEqual(['a'])
    })
  })
})
