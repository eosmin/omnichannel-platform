import { Injectable } from '@nestjs/common'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { lockCustomerForWrite, normalizeChannelIdentity } from '@platform/core/messaging'

import { RegisteredChannels } from '../channel-registry'

import type { LinkIdentityBody } from './customers.schemas'
import { IDENTITY_SELECT, type IdentityView } from './customers.views'

export interface LinkedIdentity {
  identity: IdentityView
  created: boolean
}

// The handles a customer writes from. A handle belongs to one customer of the store.
@Injectable()
export class IdentitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly channels: RegisteredChannels
  ) {}

  // Linking a handle the customer already has answers with that identity (`created: false`), so a
  // retry after a timeout is harmless
  async link(storeId: string, customerId: string, raw: LinkIdentityBody): Promise<LinkedIdentity> {
    // The handle is read as its channel says (a phone as digits, any other as it came): the plugin declared how
    const channelIdentity = normalizeChannelIdentity(
      this.channels.identityKindFor(storeId, raw.channelType),
      raw.channelIdentity
    )
    if (channelIdentity === null) {
      // The shape the zod pipe answers with, which the web reads to say which field to check
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'request validation failed',
        HttpStatusCodes.BAD_REQUEST,
        {
          issues: [
            {
              path: 'channelIdentity',
              code: 'custom',
              message: `not a valid ${raw.channelType} handle`
            }
          ],
          truncated: false
        }
      )
    }
    const body = { ...raw, channelIdentity }
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
        // Only a new identity is checked: linking the handle the customer already has writes nothing,
        // so it still answers when the plugin of that channel was removed
        this.channels.require(storeId, [body.channelType])
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
        this.events.publish(tx, Events.CUSTOMER_IDENTITY_LINKED, {
          storeId,
          customerId,
          identityId: identity.id,
          channelType: body.channelType
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
        throw new PlatformException(
          ErrorCodes.CUSTOMER_IDENTITY_HAS_CONVERSATIONS,
          'an identity with conversations cannot be unlinked',
          HttpStatusCodes.CONFLICT,
          { conversations }
        )
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
