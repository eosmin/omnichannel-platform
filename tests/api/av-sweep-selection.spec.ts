import { randomUUID } from 'node:crypto'

import { AnyDatabaseNull, DatabaseNull, JsonValueNull } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AvSanitizing, ExistingAvSweep, UploadLimits } from '@platform/core/storage'

import { TAKEN } from '../../apps/worker/src/media/existing-av-sanitizer.service'
import { ownerClient } from '../helpers/database'

// The list of the sweep of stored video and audio (`TAKEN`) is a filter on a JSON column, and what it takes depends on how the database
// answers a key that is not there, a column that is null and a JSON null: a fake cannot say, so the filter runs here on a real
// PostgreSQL. The rows belong to no store (`store_id` is null: an avatar has none) and carry the run's prefix; nothing else is read.
describe('the list of the sweep of video and audio', () => {
  let owner: OwnerClient
  const prefix = `it-av-sweep-${randomUUID().slice(0, 8)}`
  const VERSION = AvSanitizing.CLEANING_VERSION
  const ids: Record<string, string> = {}

  const rows: Array<[string, object]> = [
    ['sqlNull', DatabaseNull],
    ['jsonNull', JsonValueNull],
    ['emptyObject', {}],
    ['scannerNote', { [UploadLimits.SCAN_UNAVAILABLE_SINCE_KEY]: '2026-01-01T00:00:00.000Z' }],
    ['tryOne', { [ExistingAvSweep.ATTEMPTS_KEY]: 1 }],
    ['tryExhausted', { [ExistingAvSweep.ATTEMPTS_KEY]: ExistingAvSweep.MAX_ATTEMPTS }],
    ['unavailable', { [AvSanitizing.OUTCOME_KEY]: AvSanitizing.Outcomes.AV_UNAVAILABLE }],
    ['oldCleaned', { sanitized: true, [AvSanitizing.CLEANING_VERSION_KEY]: VERSION - 1 }],
    ['currentCleaned', { sanitized: true, [AvSanitizing.CLEANING_VERSION_KEY]: VERSION }],
    [
      'currentKept',
      {
        [AvSanitizing.OUTCOME_KEY]: AvSanitizing.Untouched.NOT_CLEANABLE,
        [AvSanitizing.CLEANING_VERSION_KEY]: VERSION
      }
    ]
  ]

  beforeAll(async () => {
    owner = ownerClient()
    for (const [name, scanResult] of rows) {
      const id = `${prefix}-${name}`
      ids[name] = id
      await owner.media.create({
        data: {
          id,
          purpose: 'message',
          key: `${prefix}/${name}.mp4`,
          filename: `${name}.mp4`,
          contentType: 'video/mp4',
          fileSize: 1,
          status: 'clean',
          scanResult: scanResult as never
        }
      })
    }
  })

  afterAll(async () => {
    await owner.media.deleteMany({ where: { id: { startsWith: prefix } } })
    await owner.$disconnect()
  })

  const taken = async (): Promise<string[]> =>
    (
      await owner.media.findMany({
        where: { id: { startsWith: prefix }, status: 'clean', ...TAKEN },
        select: { id: true }
      })
    )
      .map(row => row.id.slice(prefix.length + 1))
      .sort()

  it('takes the rows that no finished mark covers, and none that carries one', async () => {
    expect(await taken()).toEqual(
      [
        'sqlNull',
        'jsonNull',
        'emptyObject',
        'scannerNote',
        'tryOne',
        'unavailable',
        'oldCleaned'
      ].sort()
    )
  })

  it('leaves out the row of the current version, cleaned or kept, and the one that spent its tries (closed apart)', async () => {
    const list = await taken()
    expect(list).not.toContain('currentCleaned')
    expect(list).not.toContain('currentKept')
  })

  it('opens the work on a row read as null whether the column is SQL NULL or the JSON null', async () => {
    // The batch reads both as `null`; the write that begins the try must find both, or the row is taken in every run and never worked
    for (const name of ['sqlNull', 'jsonNull']) {
      const began = await owner.media.updateMany({
        where: { id: ids[name] as string, scanResult: { equals: AnyDatabaseNull } },
        data: { scanResult: { [ExistingAvSweep.ATTEMPTS_KEY]: 1 } }
      })
      expect(began.count).toBe(1)
    }
  })
})
