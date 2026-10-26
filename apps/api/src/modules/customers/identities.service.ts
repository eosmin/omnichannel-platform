import { Injectable } from '@nestjs/common'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import type { LinkIdentityBody } from './customers.schemas'
import { lockCustomerForWrite } from './customers.support'
import { IDENTITY_SELECT, type IdentityView } from './customers.views'

export interface LinkedIdentity {
  identity: IdentityView
  created: boolean
}

// The handles a customer writes from. A handle belongs to one customer of the store.
@Injectable()
export class IdentitiesService {
  constructor(private readonly prisma: PrismaService) {}

  // Linking a handle the customer already has answers with that identity (`created: false`), so a
  // retry after a timeout is harmless
  async link(storeId: string, customerId: string, body: LinkIdentityBody): Promise<LinkedIdentity> {
    try {
      return await this.prisma.transaction(async tx => {
        await lockCustomerForWrite(tx, storeId, customerId)
        const taken = await tx.customerIdentity.findFirst({
          where: { storeId, channelType: body.channelType, channelIdentity: body.channelIdentity },
          select: { ...IDENTITY_SELECT, customerId: true }
        })
        if (taken !== null) {
          if (taken.customerId !== customerId) throw this.taken(taken.customerId)
          return {
            identity: {
              id: taken.id,
              channelType: taken.channelType,
              channelIdentity: taken.channelIdentity,
              displayName: taken.displayName,
              lastInboundAt: taken.lastInboundAt
            },
            created: false
          }
        }
        const identity = await tx.customerIdentity.create({
          data: {
            storeId,
            customerId,
            channelType: body.channelType,
            channelIdentity: body.channelIdentity,
            displayName: body.displayName ?? null
          },
          select: IDENTITY_SELECT
        })
        return { identity, created: true }
      })
    } catch (error) {
      // Two links of the same handle at once: the unique index let one through
      if (!isUniqueViolation(error)) throw error
      const owner = await this.prisma.client.customerIdentity.findFirst({
        where: { storeId, channelType: body.channelType, channelIdentity: body.channelIdentity },
        select: { customerId: true }
      })
      throw this.taken(owner?.customerId ?? null)
    }
  }

  // An identity with conversations stays: they point to it, and the history would lose its channel
  async unlink(storeId: string, customerId: string, identityId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      const identity = await tx.customerIdentity.findFirst({
        where: { id: identityId, storeId, customerId },
        select: { id: true }
      })
      if (identity === null) throw resourceNotFound('identity')
      const conversations = await tx.conversation.count({
        where: { storeId, customerIdentityId: identityId }
      })
      if (conversations > 0) {
        throw resourceConflict('an identity with conversations cannot be unlinked', {
          conversations
        })
      }
      await tx.customerIdentity.delete({ where: { id: identityId } })
    })
  }

  // "Merge instead" (TDD_09 §6): the answer says whose the handle is
  private taken(ownerId: string | null) {
    return resourceConflict('the handle already belongs to a customer of the store', {
      customerId: ownerId
    })
  }
}
