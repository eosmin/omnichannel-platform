import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { CarrierConnectionStatus, CarrierId, type CarrierIdType } from '@platform/core/domain'

export interface CarrierConnectionInput {
  storeId: string
  carrierId?: CarrierIdType
  displayName?: string
  status?: CarrierConnectionStatus
  // The prefix of the guides of a `local` connection; one per connection of a store, as the api requires
  prefix?: string
}

export interface BuiltCarrierConnection {
  id: string
  displayName: string
  // The one service of the connection
  serviceId: string
  serviceCode: string
  // The prefix of the guides of a `local` connection
  prefix: string | null
}

export const BUILT_SERVICE_CODE = 'local'

// A connection of a store as the owner of the database writes it: with its one service, and the numbering when it is a `local` courier.
// It holds no credentials: a suite that needs a carrier that is called connects it through the api.
export async function createCarrierConnection(
  owner: OwnerClient,
  input: CarrierConnectionInput
): Promise<BuiltCarrierConnection> {
  const carrierId = input.carrierId ?? CarrierId.LOCAL
  const displayName = input.displayName ?? `Courier ${randomUUID().slice(0, 8)}`
  const connection = await owner.carrierConnection.create({
    data: {
      storeId: input.storeId,
      carrierId,
      displayName,
      status: input.status ?? CarrierConnectionStatus.ACTIVE,
      defaultServiceCode: BUILT_SERVICE_CODE,
      contact: { phone: '70000000' }
    },
    select: { id: true }
  })
  const service = await owner.carrierService.create({
    data: {
      storeId: input.storeId,
      connectionId: connection.id,
      code: BUILT_SERVICE_CODE,
      label: 'Local delivery'
    },
    select: { id: true }
  })
  const prefix = carrierId === CarrierId.LOCAL ? (input.prefix ?? 'T') : null
  if (prefix !== null) {
    await owner.guideSequence.create({
      data: { storeId: input.storeId, connectionId: connection.id, prefix }
    })
  }
  return {
    id: connection.id,
    displayName,
    serviceId: service.id,
    serviceCode: BUILT_SERVICE_CODE,
    prefix
  }
}
