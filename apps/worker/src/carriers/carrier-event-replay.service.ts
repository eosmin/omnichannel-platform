import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { CarrierEventOutcomes, CarrierReplayLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import type { ReprocessCarrierEventsJob } from '@platform/core/queues'
import { ShipmentReplayer, StatusResolutionKinds } from '@platform/core/shipping'

import { CarrierEventApplier } from './carrier-event-applier.service'
import { CarrierEventResolver } from './carrier-event-resolver.service'

export interface ReplayReport {
  read: number
  applied: number
  stored: number
  // Lines whose code still has no status, or was settled by someone else while this ran
  left: number
  unconfirmed: number
  // Lines that threw: counted and said, and the rest go on. They stay as they were for the next mapping to try again
  failed: number
}

// The replay of TDD_17 §4.17: the owner said what a code means, so the lines the history kept under it (and under its reasons)
// go through the engine again, oldest first, as a new event would. The meaning is read again from the mapping for each line, so
// a reason with a mapping of its own keeps its own meaning. A replay writes to nobody outside the team: what it moves carries
// `replay`. A carrier that only shares a secret is asked about a delivery or a return, as for a new event. A line that cannot
// move (a later one already moved the shipment past it) is given its status in the history and nothing else.
@Injectable()
export class CarrierEventReplay {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CarrierEventResolver,
    private readonly applier: CarrierEventApplier,
    private readonly replayer: ShipmentReplayer,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierEventReplay.name)
  }

  async reprocess(job: ReprocessCarrierEventsJob): Promise<ReplayReport> {
    const { storeId, connectionId, providerCode } = job
    const report: ReplayReport = {
      read: 0,
      applied: 0,
      stored: 0,
      left: 0,
      unconfirmed: 0,
      failed: 0
    }
    const connection = await this.resolver.liveConnection(storeId, connectionId)
    if (connection === null) {
      this.logger.info({ connectionId }, 'carrier replay dropped: the connection is gone or let go')
      return report
    }
    let after: { occurredAt: Date; id: string } | null = null
    for (;;) {
      const page: {
        id: string
        shipmentId: string
        occurredAt: Date
        source: string
        payload: unknown
      }[] = await this.prisma.client.shipmentEvent.findMany({
        where: {
          storeId,
          status: null,
          shipment: { connectionId },
          OR: [
            { payload: { path: ['providerCode'], equals: providerCode } },
            { payload: { path: ['providerCode'], string_starts_with: `${providerCode}:` } }
          ],
          ...(after === null
            ? {}
            : {
                AND: [
                  {
                    OR: [
                      { occurredAt: { gt: after.occurredAt } },
                      { occurredAt: after.occurredAt, id: { gt: after.id } }
                    ]
                  }
                ]
              })
        },
        select: { id: true, shipmentId: true, occurredAt: true, source: true, payload: true },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: CarrierReplayLimits.PAGE_SIZE
      })
      for (const line of page) {
        report.read += 1
        try {
          await this.replayLine(storeId, connectionId, connection.carrierId, line, report)
        } catch (error) {
          // One line that cannot be settled (a lock that timed out, a carrier that is down) must not hold back the others
          report.failed += 1
          this.logger.warn(
            { connectionId, lineId: line.id, errorName: errorName(error) },
            'a kept carrier event could not be replayed'
          )
        }
      }
      const last = page.at(-1)
      if (page.length < CarrierReplayLimits.PAGE_SIZE || last === undefined) break
      after = { occurredAt: last.occurredAt, id: last.id }
    }
    this.logger.info({ connectionId, ...report }, 'carrier events replayed')
    return report
  }

  private async replayLine(
    storeId: string,
    connectionId: string,
    carrierId: string,
    line: { id: string; shipmentId: string; source: string; payload: unknown },
    report: ReplayReport
  ): Promise<void> {
    const code = codeOf(line.payload)
    if (code === null) {
      report.left += 1
      return
    }
    const resolution = await this.resolver.resolveStored(storeId, connectionId, code)
    if (resolution.kind !== StatusResolutionKinds.MAPPED) {
      report.left += 1
      return
    }
    if (
      !(await this.applier.confirmed(
        { storeId, connectionId },
        carrierId,
        line.shipmentId,
        resolution.status,
        line.source
      ))
    ) {
      report.unconfirmed += 1
      return
    }
    const outcome = await this.replayer.replay(storeId, line.id, resolution.status)
    if (outcome === CarrierEventOutcomes.APPLIED) report.applied += 1
    else if (outcome === CarrierEventOutcomes.STORED) report.stored += 1
    else report.left += 1
  }
}

// The normalized parts of the code a line was kept under; a line this layer did not write has none and is left alone
function codeOf(payload: unknown): { plainCode: string; reasonCode?: string } | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const plain: unknown = Reflect.get(payload, 'plainCode')
  const reason: unknown = Reflect.get(payload, 'reasonCode')
  if (typeof plain !== 'string' || plain === '') return null
  return typeof reason === 'string' && reason !== ''
    ? { plainCode: plain, reasonCode: reason }
    : { plainCode: plain }
}
