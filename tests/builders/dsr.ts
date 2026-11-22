import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, DsrStatus, DsrType } from '@platform/core/domain'

// The sentence the isolation suite leaves in the notes of a row: a change through the api would replace it
export const DSR_FIXTURE_NOTE = 'isolation-fixture'

// A data subject request in review, as the intake and the verification leave it, written as the owner. It names no customer and holds no
// address: the cases of the suite only need a row of the store to ask for.
export async function createDataSubjectRequest(
  owner: OwnerClient,
  input: { storeId: string; status?: string; erasureDueAt?: Date }
): Promise<{ id: string }> {
  const store = await owner.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { organizationId: true }
  })
  return owner.dataSubjectRequest.create({
    data: {
      organizationId: store.organizationId,
      storeId: input.storeId,
      type: DsrType.ERASURE,
      status: input.status ?? DsrStatus.MANUAL_REVIEW,
      subjectType: 'customer',
      notes: DSR_FIXTURE_NOTE,
      verifiedAt: new Date(),
      deadlineAt: new Date(Date.now() + 30 * DAY_MS),
      ...(input.erasureDueAt === undefined ? {} : { erasureDueAt: input.erasureDueAt })
    },
    select: { id: true }
  })
}
