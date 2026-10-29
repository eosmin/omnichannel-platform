import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { CustomerLimits, type ProfileFailureKind, ProfileFailureKinds } from '@platform/core/domain'
import type { ErrorCode } from '@platform/core/errors'

import { plainHttpsUrl, retryAfterOutage } from './customer-profile.support'
import { cleanText } from './customers.support'

// What a channel plugin handed over about a customer (ChannelCustomerProfile), or null when it has none
export interface ProfileRead {
  name?: string | undefined
  username?: string | undefined
  avatarUrl?: string | undefined
}

// Stores what a channel keeps for a customer: the name, the username and the link of the photo. A try
// that settled is stamped even when it found nothing, so that the next message does not ask again.
@Injectable()
export class CustomerProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async recordRead(storeId: string, identityId: string, read: ProfileRead | null): Promise<void> {
    const name = cleanText(read?.name, CustomerLimits.NAME_MAX_LENGTH)
    const username = cleanText(read?.username, CustomerLimits.USERNAME_MAX_LENGTH)
    const avatarUrl = plainHttpsUrl(read?.avatarUrl, CustomerLimits.AVATAR_URL_MAX_LENGTH)
    await this.prisma.transaction(async tx => {
      const identity = await tx.customerIdentity.findFirst({
        where: { id: identityId, storeId },
        select: { customerId: true }
      })
      if (identity === null) return // Erased or merged away since the job was queued
      // What the channel shows now replaces what was read before, field by field: a field it does not
      // give is left as it was. The photo link is the exception: it expires, so a read that found
      // something never leaves an old one behind. A read that found nothing changes none of them.
      const found = name !== undefined || username !== undefined || avatarUrl !== undefined
      await tx.customerIdentity.update({
        where: { id: identityId },
        data: {
          ...(name === undefined ? {} : { displayName: name }),
          ...(username === undefined ? {} : { username }),
          ...(found ? { avatarUrl: avatarUrl ?? null } : {}),
          profileFetchedAt: new Date(),
          profileRetryAfter: null,
          profileFetchError: null
        }
      })
      // The customer's own name is the agents' and wins over the channel's: only an empty one takes it.
      // The identity keeps the name the channel shows now.
      if (name !== undefined) {
        await tx.customer.updateMany({
          where: { id: identity.customerId, storeId, name: null },
          data: { name }
        })
      }
    })
  }

  // The read failed. A refusal is final: the profile is stamped now and not asked again until it is
  // stale. An outage got no answer: the date of the last real read stays, and the next message must
  // wait a short while before it asks again.
  async recordFailure(
    storeId: string,
    identityId: string,
    errorCode: ErrorCode,
    kind: ProfileFailureKind
  ): Promise<void> {
    const now = new Date()
    await this.prisma.client.customerIdentity.updateMany({
      where: { id: identityId, storeId },
      data:
        kind === ProfileFailureKinds.OUTAGE
          ? { profileFetchError: errorCode, profileRetryAfter: retryAfterOutage(now) }
          : {
              profileFetchError: errorCode,
              profileFetchedAt: now,
              profileRetryAfter: null,
              // Signed and short-lived: after a refusal nobody knows it still opens
              avatarUrl: null
            }
    })
  }
}
