import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig } from '@platform/core/compliance'
import { DatabaseNull, PrismaService } from '@platform/core/database'
import { erasedHandleOf } from '@platform/core/domain'
import { errorName, resourceConflict } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { lockCustomerForWrite } from '@platform/core/messaging'
import {
  type EraseCustomerDataJob,
  eraseCustomerDataJobId,
  JobNames,
  QueueNames
} from '@platform/core/queues'

import { type Actor, auditActorOf, auditViaOf } from '../tenancy'

// What the erasure answers and the audit entry records: counts, never a value (the answer reaches whoever holds
// `customers:erase`, who may not read customers, and the audit log outlives the store's retention windows)
export interface ErasureView {
  erased: true
  erasedAt: string
  deleted: { notes: number; addresses: number; fiscalData: number }
  anonymized: { identities: number; consents: number; mergeSnapshots: number }
  // What stays because the store needs it as history or the law asks for it (TDD_05 §10.3): the orders and the conversations
  // still point to the customer, who now has no name
  retained: { orders: number; conversations: number }
}

// The erasure of the personal data of a customer (TDD_05 §10.3, Step 7.2): anonymization plus targeted deletion, never a
// blanket DELETE. The customer row stays (orders, conversations and the fiscal documents point to it) with the placeholder
// for a name, and every direct identifier goes: the contact data, the caution reason, the notes, the addresses, the
// profile of each channel handle, the sealed fiscal data and what a merge remembered of the person. The handles are
// anonymized in place, not deleted: a conversation needs its identity row. The handle is replaced, so a later message from
// it finds no customer and makes a new one. Consents stay as proof, revoked, without the address and browser of the person.
//
// Not done here, each with its owner in the plan (Step 7.2): the content of the messages and the files of the customer, the
// personal data an order copied (recipient, address, notes), and the verification by token of the request.
// The fiscal documents already made and the ledger are never touched.
@Injectable()
export class CustomerErasureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<EraseCustomerDataJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(CustomerErasureService.name)
  }

  async erase(storeId: string, customerId: string, actor: Actor): Promise<ErasureView> {
    const { view, done, pending } = await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId, { allowErased: true })
      const current = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { erasedAt: true, erasedDataPurgedAt: true }
      })
      const [orders, conversations] = await Promise.all([
        tx.order.count({ where: { storeId, customerId } }),
        tx.conversation.count({ where: { storeId, customerId } })
      ])
      // Erasing again answers the same and changes nothing: the first erasure keeps its date
      if (current.erasedAt !== null) {
        return {
          done: false,
          // Asked again while its data is not all cleared: the job is asked again too (the same job id adds nothing while one waits)
          pending: current.erasedDataPurgedAt === null,
          view: {
            erased: true as const,
            erasedAt: current.erasedAt.toISOString(),
            deleted: { notes: 0, addresses: 0, fiscalData: 0 },
            anonymized: { identities: 0, consents: 0, mergeSnapshots: 0 },
            retained: { orders, conversations }
          }
        }
      }
      // A merge into this customer that can still be undone brings the absorbed customer back, whole: the survivor cannot be
      // erased under it (the same rule as deleting a customer)
      const undoable = await tx.customerMerge.count({
        where: {
          storeId,
          survivorId: customerId,
          unmergedAt: null,
          unmergeUntil: { gt: new Date() }
        }
      })
      if (undoable > 0) {
        throw resourceConflict(
          'a customer cannot be erased while a merge into it can still be undone',
          {
            merges: undoable
          }
        )
      }

      const now = new Date()
      await tx.customer.update({
        where: { id: customerId },
        data: {
          name: ComplianceConfig.ERASED_CONTENT_PLACEHOLDER,
          email: null,
          phone: null,
          phoneNormalized: null,
          locale: null,
          // The reason, who set it and when are about the person; the flag itself holds no data (TDD_17 §4.16)
          cautionReason: null,
          cautionSetBy: null,
          cautionSetAt: null,
          erasedAt: now
        }
      })

      const identities = await tx.customerIdentity.findMany({
        where: { storeId, customerId },
        select: { id: true }
      })
      for (const identity of identities) {
        await tx.customerIdentity.update({
          where: { id: identity.id },
          data: {
            // Unique by the id of the row, so the key (store, channel, handle) cannot clash and never matches a real handle
            channelIdentity: erasedHandleOf(identity.id),
            displayName: null,
            channelMetadata: DatabaseNull,
            username: null,
            avatarUrl: null
          }
        })
      }
      const notes = await tx.customerNote.deleteMany({ where: { customerId } })
      const addresses = await tx.address.deleteMany({ where: { customerId } })
      // The fiscal documents already made hold their own copy of the receiver (Step 4B.7b-3): this row is only the data kept
      // to invoice the next sale
      const fiscalData = await tx.customerFiscalData.deleteMany({ where: { storeId, customerId } })
      const consents = await tx.consentRecord.findMany({
        where: { storeId, customerId },
        select: { id: true, revokedAt: true }
      })
      for (const consent of consents) {
        await tx.consentRecord.update({
          where: { id: consent.id },
          data: { revokedAt: consent.revokedAt ?? now, ipAddress: null, userAgent: null }
        })
      }
      // What a merge remembered of this customer (before and after values: name, email, phone). The rest of the snapshot is ids,
      // which the cleanup of the merge needs and which are no data of the person
      const merges = await tx.customerMerge.findMany({
        where: { storeId, survivorId: customerId },
        select: { id: true, snapshot: true }
      })
      let mergeSnapshots = 0
      for (const merge of merges) {
        // On the raw JSON, not through the schema: a snapshot an older version wrote, or a malformed one, must lose the values too
        const raw =
          typeof merge.snapshot === 'object' &&
          merge.snapshot !== null &&
          !Array.isArray(merge.snapshot)
            ? merge.snapshot
            : {}
        await tx.customerMerge.update({
          where: { id: merge.id },
          data: { snapshot: { ...raw, survivorBefore: {}, survivorAfter: {} } }
        })
        mergeSnapshots += 1
      }

      this.events.publish(tx, Events.CUSTOMER_UPDATED, { storeId, customerId })
      return {
        done: true,
        pending: true,
        view: {
          erased: true as const,
          erasedAt: now.toISOString(),
          deleted: {
            notes: notes.count,
            addresses: addresses.count,
            fiscalData: fiscalData.count
          },
          anonymized: {
            identities: identities.length,
            consents: consents.length,
            mergeSnapshots
          },
          retained: { orders, conversations }
        }
      }
    })
    // After the real commit: the job reads the customer as erased. A queue that is down does not undo the erasure; the daily sweep finds the
    // customer by the missing mark and finishes what the job would have done
    if (pending) await this.queueDataClearing(storeId, customerId)
    if (done) {
      this.audit.log({
        action: AuditAction.CUSTOMER_ERASED,
        actor: auditActorOf(actor),
        storeId,
        resourceType: 'customer',
        resourceId: customerId,
        metadata: {
          deleted: view.deleted,
          anonymized: view.anonymized,
          retained: view.retained,
          ...auditViaOf(actor)
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return view
  }

  private async queueDataClearing(storeId: string, customerId: string): Promise<void> {
    try {
      await this.prisma.afterCommitStep(this.prisma.client, () =>
        this.queue.add(
          JobNames.ERASE_CUSTOMER_DATA,
          { storeId, customerId },
          {
            jobId: eraseCustomerDataJobId(customerId),
            attempts: 5,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: true
          }
        )
      )
    } catch (error) {
      this.logger.warn(
        { storeId, customerId, errorName: errorName(error) },
        'the clearing of the data of an erased customer could not be queued; the sweep will find it'
      )
    }
  }
}
