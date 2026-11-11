import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  CarrierConnectionStatus,
  providerStatusCodeOf,
  ShipmentStatus
} from '@platform/core/domain'
import { resolveProviderStatus, type StatusResolution } from '@platform/core/shipping'
import type { ProcessCarrierEventJob } from '@platform/plugins/runtime'

export interface ResolvedCarrierEvent {
  resolution: StatusResolution
  carrierId: string
}

// The two parts of a code, normalized: the status and the reason that came beside it (`undefined` when none)
export interface StoredCode {
  plainCode: string
  reasonCode?: string | undefined
}

const SHIPMENT_STATUSES = Object.values(ShipmentStatus)

// What one event of a carrier means for its connection (TDD_17 §4.17). It reads and decides; it writes nothing. What is done
// with the answer (the record of a code nobody mapped, the move of the shipment) is `CarrierEventApplier`. The connection is
// read with the store of the job, which came from the connection the signature authenticated.
@Injectable()
export class CarrierEventResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierEventResolver.name)
  }

  // `null` when the event is for nobody: a connection that was let go (or deleted) while the job waited takes nothing, and
  // trying again would change nothing
  async resolve(job: ProcessCarrierEventJob): Promise<ResolvedCarrierEvent | null> {
    const { storeId, connectionId, event } = job
    const connection = await this.liveConnection(storeId, connectionId)
    if (connection === null) {
      this.logger.info({ connectionId }, 'carrier event dropped: the connection is gone or let go')
      return null
    }
    const resolution = await this.resolveCode(
      storeId,
      connectionId,
      {
        plainCode: providerStatusCodeOf(event.rawStatus),
        reasonCode:
          event.rawReason === undefined ? undefined : providerStatusCodeOf(event.rawReason)
      },
      event.status
    )
    return { resolution, carrierId: connection.carrierId }
  }

  // The same decision for a line the history kept: what the plugin said is not kept, so only the mapping of the connection
  // can give it a status now
  resolveStored(
    storeId: string,
    connectionId: string,
    code: StoredCode
  ): Promise<StatusResolution> {
    return this.resolveCode(storeId, connectionId, code, null)
  }

  async liveConnection(
    storeId: string,
    connectionId: string
  ): Promise<{ carrierId: string } | null> {
    const connection = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { carrierId: true, status: true }
    })
    if (connection === null || connection.status === String(CarrierConnectionStatus.DISABLED)) {
      return null
    }
    return { carrierId: connection.carrierId }
  }

  private async resolveCode(
    storeId: string,
    connectionId: string,
    code: StoredCode,
    pluginStatus: ShipmentStatus | null
  ): Promise<StatusResolution> {
    const composite =
      code.reasonCode === undefined || code.reasonCode === ''
        ? code.plainCode
        : `${code.plainCode}:${code.reasonCode}`
    const rows = await this.prisma.client.carrierStatusMapping.findMany({
      // Only the two codes the event can match (the composite and the plain one), through the unique index
      where: { storeId, connectionId, providerCode: { in: [code.plainCode, composite] } },
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
    return resolveProviderStatus(
      {
        rawStatus: code.plainCode,
        ...(code.reasonCode === undefined ? {} : { rawReason: code.reasonCode }),
        status: pluginStatus
      },
      mappings
    )
  }
}
