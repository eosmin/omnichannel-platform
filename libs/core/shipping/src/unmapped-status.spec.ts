import { CarrierStatusLimits } from '@platform/core/domain'

import { recordUnmappedStatus } from './unmapped-status'

// A client that behaves as the table does: one row per (connection, code)
interface Row {
  storeId: string
  connectionId: string
  providerCode: string
  sampleRawStatus: string
  occurrences: number
  resolvedAt: Date | null
}

function fakeClient(rows: Row[], options: { raceOnCreate?: boolean } = {}) {
  let raced = false
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'resolvedAt') {
        return value === null
          ? row.resolvedAt === null
          : (value as { not: null }).not === null && row.resolvedAt !== null
      }
      return (row as unknown as Record<string, unknown>)[key] === value
    })
  return {
    rows,
    client: {
      carrierUnmappedStatus: {
        updateMany: ({
          where,
          data
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          const hit = rows.filter(row => matches(row, where))
          for (const row of hit) {
            row.occurrences += 1
            if ('resolvedAt' in data) row.resolvedAt = data['resolvedAt'] as null
            if (typeof data['sampleRawStatus'] === 'string')
              row.sampleRawStatus = data['sampleRawStatus']
          }
          return Promise.resolve({ count: hit.length })
        },
        count: ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(rows.filter(row => matches(row, where)).length),
        create: ({ data }: { data: Row }) => {
          if (options.raceOnCreate === true && !raced) {
            raced = true
            rows.push({ ...data, occurrences: 1, resolvedAt: null })
            return Promise.reject(Object.assign(new Error('unique'), { code: 'P2002' }))
          }
          rows.push({ ...data, occurrences: 1, resolvedAt: null })
          return Promise.resolve(data)
        }
      }
    } as never
  }
}

const input = { storeId: 's1', connectionId: 'c1', providerCode: 'zzz', rawStatus: 'Zzz' }

describe('recordUnmappedStatus', () => {
  it('creates the row on the first sighting and counts the next ones', async () => {
    const { client, rows } = fakeClient([])
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: true,
      firstSighting: true
    })
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: true,
      firstSighting: false
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.occurrences).toBe(2)
  })

  it('opens again a code the owner had mapped, as a first sighting', async () => {
    const { client, rows } = fakeClient([
      { ...input, sampleRawStatus: 'old', occurrences: 3, resolvedAt: new Date() }
    ])
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: true,
      firstSighting: true
    })
    expect(rows[0]).toMatchObject({ occurrences: 4, resolvedAt: null, sampleRawStatus: 'Zzz' })
  })

  it('keeps the sample short', async () => {
    const { client, rows } = fakeClient([])
    await recordUnmappedStatus(client, { ...input, rawStatus: 'x'.repeat(5000) })
    expect(rows[0]?.sampleRawStatus).toHaveLength(CarrierStatusLimits.SAMPLE_MAX_LENGTH)
  })

  it('does not keep a code that is too long, nor one past the cap of the connection', async () => {
    const { client, rows } = fakeClient([])
    expect(
      await recordUnmappedStatus(client, {
        ...input,
        providerCode: 'a'.repeat(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH + 1)
      })
    ).toEqual({ recorded: false, firstSighting: false })
    for (let i = 0; i < CarrierStatusLimits.MAX_UNMAPPED_PER_CONNECTION; i++) {
      rows.push({
        ...input,
        providerCode: `code-${i}`,
        occurrences: 1,
        sampleRawStatus: '',
        resolvedAt: null
      })
    }
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: false,
      firstSighting: false
    })
    expect(rows).toHaveLength(CarrierStatusLimits.MAX_UNMAPPED_PER_CONNECTION)
  })

  it('does not count the codes the owner already mapped against the room', async () => {
    const mapped = Array.from(
      { length: CarrierStatusLimits.MAX_UNMAPPED_PER_CONNECTION },
      (_v, i) => ({
        ...input,
        providerCode: `done-${i}`,
        occurrences: 1,
        sampleRawStatus: '',
        resolvedAt: new Date()
      })
    )
    const { client } = fakeClient(mapped)
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: true,
      firstSighting: true
    })
  })

  it('refuses a code with a control character or nothing in it', async () => {
    const { client, rows } = fakeClient([])
    for (const providerCode of ['', 'a\u0000b', 'x\u0007']) {
      expect(await recordUnmappedStatus(client, { ...input, providerCode })).toEqual({
        recorded: false,
        firstSighting: false
      })
    }
    expect(rows).toHaveLength(0)
  })

  it('counts itself on the row of the winner when two events of a new code race', async () => {
    const { client, rows } = fakeClient([], { raceOnCreate: true })
    expect(await recordUnmappedStatus(client, input)).toEqual({
      recorded: true,
      firstSighting: false
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.occurrences).toBe(2)
  })
})
