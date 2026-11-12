import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { lockCustomerForWrite } from '@platform/core/messaging'

import type { Actor } from '../tenancy'

import type { SetCautionBody } from './customers.schemas'

// What the caution routes answer: the flag and its reason, not the profile (whoever flags a customer may not
// hold `customers:view`, and the profile carries contact data)
export interface CautionView {
  isCaution: boolean
  cautionReason: string | null
}

// The caution flag of a customer (TDD_17 §4.16): it informs the team and never blocks anything. Setting it
// again with another reason replaces the reason, the setter and the date; with the same one it changes nothing. The reason is free text about a person: it lives in the
// row only, and neither the audit entry nor the logs copy it, so that clearing the flag (or erasing the
// customer) leaves no copy behind.
@Injectable()
export class CustomerCautionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async set(
    storeId: string,
    customerId: string,
    body: SetCautionBody,
    actor: Actor
  ): Promise<CautionView> {
    const previous = await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      const current = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { isCaution: true, cautionReason: true, cautionSetBy: true }
      })
      // The same reason again changes nothing: it keeps who flagged the customer first, and when
      if (current.isCaution && current.cautionReason === body.reason) return null
      await tx.customer.update({
        where: { id: customerId },
        data: {
          isCaution: true,
          cautionReason: body.reason,
          cautionSetBy: actor.userId,
          cautionSetAt: new Date()
        }
      })
      return current
    })
    if (previous !== null) {
      this.audit.log({
        action: AuditAction.CUSTOMER_CAUTION_SET,
        actor: { userId: actor.userId },
        storeId,
        resourceType: 'customer',
        resourceId: customerId,
        // Who flagged it before, when this replaces a reason: the reason itself is never copied
        metadata: { replaced: previous.isCaution, previousSetBy: previous.cautionSetBy },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { isCaution: true, cautionReason: body.reason }
  }

  // Clearing a customer that is not flagged changes nothing and is not audited
  async clear(storeId: string, customerId: string, actor: Actor): Promise<CautionView> {
    const wasFlagged = await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      const current = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { isCaution: true }
      })
      if (!current.isCaution) return false
      await tx.customer.update({
        where: { id: customerId },
        data: { isCaution: false, cautionReason: null, cautionSetBy: null, cautionSetAt: null }
      })
      return true
    })
    if (wasFlagged) {
      this.audit.log({
        action: AuditAction.CUSTOMER_CAUTION_CLEARED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: 'customer',
        resourceId: customerId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { isCaution: false, cautionReason: null }
  }
}
