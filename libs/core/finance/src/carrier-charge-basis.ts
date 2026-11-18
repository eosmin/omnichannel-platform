import { GuideMovementKind } from '@platform/core/domain'

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
  // One consume per guide (a partial unique index of the ledger of guides); a return guide consumes nothing
  guideMovements: {
    where: { kind: GuideMovementKind.CONSUME },
    select: { unitCostCents: true, onAdvance: true },
    take: 1
  }
} as const

export interface ChargeBasisRow {
  shippingPayer: string
  codAmountCents: number | null
  carrierCostCents: number | null
  carrierRateCents: number | null
  commissionBps: number | null
  guideMovements: readonly { unitCostCents: number | null; onAdvance: boolean }[]
}

// The cost of the guide the advance gave up, or null when no advance covered it: the guide was made while the connection did not prepay
// (the consume says so, `onAdvance`, and a later change of the model moves nothing), or it was made with no purchase on record (no
// average cost to take: the carrier will bill it, so it is charged as an invoice, as before)
export function prepaidGuideCostOf(
  consumed: readonly { unitCostCents: number | null; onAdvance: boolean }[]
): number | null {
  const guide = consumed[0]
  return guide !== undefined && guide.onAdvance ? guide.unitCostCents : null
}

export function chargeBasisOf(row: ChargeBasisRow): ChargeBasis {
  return {
    shippingPayer: row.shippingPayer,
    codAmountCents: row.codAmountCents,
    carrierCostCents: row.carrierCostCents,
    carrierRateCents: row.carrierRateCents,
    commissionBps: row.commissionBps,
    prepaidGuideCostCents: prepaidGuideCostOf(row.guideMovements)
  }
}
