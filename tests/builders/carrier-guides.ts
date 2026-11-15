import type { OwnerClient } from '@platform/core/database-testing'

// The ledger of guides of the stores of a run, and the periods the daily close judged, removed. The ledger is append-only for
// everyone, the owner included, so its triggers are switched off inside one transaction, the rows go (the voids first: a void
// points at its purchase), and they are switched on again before it commits.
export async function purgeCarrierGuides(
  owner: OwnerClient,
  where: { store: { organization: { slug: { startsWith: string } } } }
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
  await owner.$transaction(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE carrier_guide_movements DISABLE TRIGGER USER')
    await tx.carrierGuideMovement.deleteMany({ where: { ...where, kind: 'void' } })
    await tx.carrierGuideMovement.deleteMany({ where })
    await tx.carrierBenefitPeriod.deleteMany({ where })
    await tx.$executeRawUnsafe('ALTER TABLE carrier_guide_movements ENABLE TRIGGER USER')
  })
}
