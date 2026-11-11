import { isUniqueViolation, type PrismaService } from '@platform/core/database'
import { CarrierStatusLimits, isStorableProviderCode } from '@platform/core/domain'

export interface UnmappedStatusInput {
  storeId: string
  connectionId: string
  // Normalized (`providerStatusCodeOf`), composite when the carrier sent a reason
  providerCode: string
  // What the carrier called it, as it sent it. Only the status text is kept: a description can carry a name or an address
  rawStatus: string
}

export interface UnmappedStatusRecord {
  // False when the code was not kept (too long, or the connection already waits on as many codes as it may)
  recorded: boolean
  // The first time the owner has to hear of the code: a new row, or one he had mapped and that came back
  firstSighting: boolean
}

type Client = Pick<PrismaService['client'], 'carrierUnmappedStatus'>

// Records a code that arrived with no mapping and no default (TDD_17 §4.17): one row per connection and code, so the owner
// is told once and the screen lists what waits. The row of a code he had mapped and later removed opens again, and counts
// as a first sighting. The room of a connection is approximate under concurrency (the count and the create are two steps). Every write names the store. Two events of the same new code at once end with one row: the loser of
// the unique index counts itself on the winner's row.
export async function recordUnmappedStatus(
  client: Client,
  input: UnmappedStatusInput
): Promise<UnmappedStatusRecord> {
  const { storeId, connectionId, providerCode } = input
  if (!isStorableProviderCode(providerCode)) {
    return { recorded: false, firstSighting: false }
  }
  const sample = input.rawStatus.slice(0, CarrierStatusLimits.SAMPLE_MAX_LENGTH)
  const key = { storeId, connectionId, providerCode }
  const now = new Date()

  const counted = await client.carrierUnmappedStatus.updateMany({
    where: { ...key, resolvedAt: null },
    data: { occurrences: { increment: 1 }, lastSeenAt: now }
  })
  if (counted.count > 0) return { recorded: true, firstSighting: false }

  // Only the codes that still wait: the ones the owner mapped are history, and must not fill the room
  const waiting = await client.carrierUnmappedStatus.count({
    where: { storeId, connectionId, resolvedAt: null }
  })
  if (waiting >= CarrierStatusLimits.MAX_UNMAPPED_PER_CONNECTION) {
    return { recorded: false, firstSighting: false }
  }
  // Full: a code that comes back is not reopened either, or the waiting set would grow past its room
  const reopened = await client.carrierUnmappedStatus.updateMany({
    where: { ...key, resolvedAt: { not: null } },
    data: {
      occurrences: { increment: 1 },
      lastSeenAt: now,
      resolvedAt: null,
      sampleRawStatus: sample
    }
  })
  if (reopened.count > 0) return { recorded: true, firstSighting: true }

  try {
    await client.carrierUnmappedStatus.create({
      data: { ...key, sampleRawStatus: sample, firstSeenAt: now, lastSeenAt: now }
    })
    return { recorded: true, firstSighting: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    await client.carrierUnmappedStatus.updateMany({
      where: key,
      data: { occurrences: { increment: 1 }, lastSeenAt: now }
    })
    return { recorded: true, firstSighting: false }
  }
}
