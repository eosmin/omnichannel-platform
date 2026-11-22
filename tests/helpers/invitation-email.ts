import type { INestApplication } from '@nestjs/common'

import { CredentialCipher } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import { type InvitationEmail, openInvitationEmail } from '@platform/core/email'

import { emailsOf } from './email'

// The email of an invitation waits sealed in the row of the invitation (the outbox) until the worker sends it; the suites of the api read
// it from there, as the worker does. Only a row that still has its outbox counts: a replaced, revoked or accepted invitation cleared it.
export async function outboxEmailTo(
  app: INestApplication,
  owner: OwnerClient,
  address: string,
  storeId?: string
): Promise<InvitationEmail | undefined> {
  const row = await owner.invitation.findFirst({
    where: {
      email: address.toLowerCase(),
      emailOutbox: { not: null },
      ...(storeId ? { storeId } : {})
    },
    orderBy: { createdAt: 'desc' },
    select: { emailOutbox: true, id: true, storeId: true }
  })
  if (row?.emailOutbox == null) return undefined
  return openInvitationEmail(app.get(CredentialCipher, { strict: false }), row.emailOutbox, {
    storeId: row.storeId,
    invitationId: row.id
  })
}

// How many deliveries the api asked the queue for, for the invitations of one address
export async function deliveryRequestsFor(
  app: INestApplication,
  owner: OwnerClient,
  address: string
): Promise<number> {
  const rows = await owner.invitation.findMany({
    where: { email: address.toLowerCase() },
    select: { id: true }
  })
  const ids = new Set(rows.map(row => row.id))
  return emailsOf(app).deliveries.filter(job => ids.has(job.invitationId)).length
}
