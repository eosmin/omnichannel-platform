import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { RemittanceLineOutcome, RemittanceStatus } from '@platform/core/domain'

// A draft remittance of a store with one connection and, when asked, one line, written as the owner: the way to put one in any
// store without the api. The line names no shipment (nothing was matched).
export async function createRemittance(
  owner: OwnerClient,
  input: { storeId: string; connectionId: string; withLine?: boolean }
): Promise<{ id: string; lineId: string | null }> {
  const author = await owner.membership.findFirstOrThrow({
    where: { storeId: input.storeId },
    select: { userId: true }
  })
  const remittance = await owner.codRemittance.create({
    data: {
      storeId: input.storeId,
      connectionId: input.connectionId,
      status: RemittanceStatus.DRAFT,
      createdBy: author.userId
    },
    select: { id: true }
  })
  if (input.withLine !== true) return { id: remittance.id, lineId: null }
  const line = await owner.codRemittanceLine.create({
    data: {
      storeId: input.storeId,
      remittanceId: remittance.id,
      position: 1,
      guideNumber: `NOGUIDE-${remittance.id.slice(0, 8)}`,
      reportedCents: 500,
      outcome: RemittanceLineOutcome.NOT_FOUND
    },
    select: { id: true }
  })
  return { id: remittance.id, lineId: line.id }
}

// A saved mapping of a carrier's settlement file, written as the owner
export async function createRemittanceImportProfile(
  owner: OwnerClient,
  input: { storeId: string; connectionId: string; name?: string }
): Promise<{ id: string }> {
  return owner.remittanceImportProfile.create({
    data: {
      storeId: input.storeId,
      connectionId: input.connectionId,
      name: input.name ?? `Profile ${randomUUID().slice(0, 8)}`,
      columns: { guideNumber: 'Guia', amount: 'Monto' }
    },
    select: { id: true }
  })
}
