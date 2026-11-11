import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  CarrierConnectionStatus,
  providerStatusCodeOf,
  ShipmentStatus
} from '@platform/core/domain'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  recordUnmappedStatus,
  resolveProviderStatus,
  type StatusResolution,
  StatusResolutionKinds
} from '@platform/core/shipping'
import type { ProcessCarrierEventJob } from '@platform/plugins/runtime'

export interface ResolvedCarrierEvent {
  resolution: StatusResolution
  // True the first time the owner has to hear of an unmapped code (the notification of Step 4.8 PR C2c hangs from it)
  firstUnmappedSighting: boolean
}

const SHIPMENT_STATUSES = Object.values(ShipmentStatus)

// What one event of a carrier means for its connection (TDD_17 §4.17), and the record of a code nobody has mapped. It does
// NOT touch a shipment: finding the shipment, the dedupe, the transition table and the order effects are the status engine
// of Step 4.8 PR C2c, which starts from what this returns. The connection is read with the store of the job, which came
// from the connection the signature authenticated.
@Injectable()
export class CarrierEventResolver {
  constructor(
    private readonly prisma: PrismaService,
    @InjectMetric(MetricNames.SHIPMENT_UNKNOWN_STATUS_TOTAL)
    private readonly unknownStatus: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierEventResolver.name)
  }

  // `null` when the event is for nobody: a connection that was let go (or deleted) while the job waited takes nothing, and
  // trying again would change nothing
  async resolve(job: ProcessCarrierEventJob): Promise<ResolvedCarrierEvent | null> {
    const { storeId, connectionId, event } = job
    const connection = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { carrierId: true, status: true }
    })
    if (connection === null || connection.status === String(CarrierConnectionStatus.DISABLED)) {
      this.logger.info({ connectionId }, 'carrier event dropped: the connection is gone or let go')
      return null
    }
    const rows = await this.prisma.client.carrierStatusMapping.findMany({
      // Only the two codes the event can match (the composite and the plain one), through the unique index
      where: {
        storeId,
        connectionId,
        providerCode: {
          in: [
            providerStatusCodeOf(event.rawStatus),
            providerStatusCodeOf(event.rawStatus, event.rawReason)
          ]
        }
      },
      select: { providerCode: true, status: true }
    })
    // A row whose status is not one we know is left out, not read as "ignore": the code is then unmapped and the owner is asked
    const mappings = new Map<string, ShipmentStatus | null>()
    for (const row of rows) {
      if (row.status === null) {
        mappings.set(row.providerCode, null)
        continue
      }
      const known = SHIPMENT_STATUSES.find(status => status === row.status)
      if (known !== undefined) mappings.set(row.providerCode, known)
    }
    const resolution = resolveProviderStatus(event, mappings)

    let firstUnmappedSighting = false
    if (resolution.kind === StatusResolutionKinds.UNMAPPED) {
      this.unknownStatus.inc({ carrier: connection.carrierId })
      const recorded = await recordUnmappedStatus(this.prisma.client, {
        storeId,
        connectionId,
        providerCode: resolution.code,
        // The reason too: two reasons of one status are two rows, and the owner has to tell them apart
        rawStatus:
          event.rawReason === undefined ? event.rawStatus : `${event.rawStatus}:${event.rawReason}`
      })
      firstUnmappedSighting = recorded.firstSighting
      if (!recorded.recorded) {
        // The record is full (or the code is not one): counted and said, not kept
        this.logger.warn(
          { connectionId, carrierId: connection.carrierId },
          'an unmapped carrier status was not recorded'
        )
      }
    }
    return { resolution, firstUnmappedSighting }
  }
}
