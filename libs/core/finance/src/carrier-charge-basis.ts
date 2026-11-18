import { CarrierChargeModel, GuideMovementKind } from '@platform/core/domain'

import type { ChargeBasis } from './carrier-entry-rules'

// What E4 and everything that estimates it read of a guide: its own figures, the charge model of its connection and what the guide
// took out of the advance (HC-101). One select and one reading, so the posting, the sweep and the estimate of a remittance cannot
// disagree about what a guide costs.
export const chargeBasisSelect = {
  shippingPayer: true,
  codAmountCents: true,
  carrierCostCents: true,
  carrierRateCents: true,
  commissionBps: true,
  connection: { select: { chargeModel: true, chargeModelSince: true } },
  // One consume per guide (a partial unique index of the ledger of guides); a return guide consumes nothing
  guideMovements: {
    where: { kind: GuideMovementKind.CONSUME },
    select: { unitCostCents: true, occurredAt: true },
    take: 1
  }
} as const

export interface ChargeBasisRow {
  shippingPayer: string
  codAmountCents: number | null
  carrierCostCents: number | null
  carrierRateCents: number | null
  commissionBps: number | null
  connection: { chargeModel: string; chargeModelSince: Date }
  guideMovements: readonly { unitCostCents: number | null; occurredAt: Date }[]
}

// The cost of the guide the advance gave up, or null when no advance covered it: the connection does not prepay, the guide was made
// before the connection began to (what came before is in the opening balance), or it was made with no purchase on record (no average cost
// to take: the carrier will bill it, so it is charged as an invoice, as before)
export function prepaidGuideCostOf(
  connection: { chargeModel: string; chargeModelSince: Date },
  consumed: readonly { unitCostCents: number | null; occurredAt: Date }[]
): number | null {
  if (connection.chargeModel !== (CarrierChargeModel.PREPAID as string)) return null
  const guide = consumed[0]
  if (guide === undefined || guide.occurredAt < connection.chargeModelSince) return null
  return guide.unitCostCents
}

export function chargeBasisOf(row: ChargeBasisRow): ChargeBasis {
  return {
    shippingPayer: row.shippingPayer,
    codAmountCents: row.codAmountCents,
    carrierCostCents: row.carrierCostCents,
    carrierRateCents: row.carrierRateCents,
    commissionBps: row.commissionBps,
    prepaidGuideCostCents: prepaidGuideCostOf(row.connection, row.guideMovements)
  }
}
