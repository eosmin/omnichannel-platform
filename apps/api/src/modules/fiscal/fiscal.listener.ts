import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { EventContext, PrismaService } from '@platform/core/database'
import { FiscalIssueOn, OrderStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  Events,
  type OrderStatusChangedPayload,
  type ReturnEventPayload
} from '@platform/core/events'
import { FiscalDocumentsService } from '@platform/fiscal/runtime'

import { FiscalSubmissionQueue } from './fiscal-submission.queue'

// The sale makes its fiscal document (TDD_18 §8.3). When it is made is the issuer's setting (`issueOn`, owner and accountant,
// TDD_18 §13 row 3): at SHIPPED or at DELIVERED. A failure here never reaches the order: the sale stands and the document can be
// retried from the fiscal screens.
@Injectable()
export class FiscalListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventContext,
    private readonly logger: PinoLogger,
    private readonly documents: FiscalDocumentsService,
    private readonly queue: FiscalSubmissionQueue
  ) {
    this.logger.setContext(FiscalListener.name)
  }

  // A return was received: its credit note, linked to the sale document it cancels (part of). Like the sale, a failure here never reaches
  // the return; the credit note can be retried from the fiscal screens, and the sweep of Step 4B.8 finds the ones that were never made.
  @OnEvent(Events.RETURN_RECEIVED)
  async onReturnReceived(payload: ReturnEventPayload): Promise<void> {
    try {
      const organizationId = await this.organizationOf(payload.storeId)
      if (organizationId === null) return
      const documentId = await this.events.inOrganizationOfStore(payload.storeId, () =>
        this.documents.createCreditNoteForReturn(organizationId, payload.returnId)
      )
      if (documentId !== undefined && documentId !== null)
        await this.queue.enqueue(organizationId, documentId, 1)
    } catch (error) {
      this.logger.error(
        { err: errorName(error), returnId: payload.returnId },
        'the credit note of a return was not made'
      )
    }
  }

  // Read with no tenant context on purpose: `stores` has no row policy (`neverPolicy` in scripts/rls-exceptions.ts). The documents are
  // made inside `inOrganizationOfStore`; the queue is Redis, outside any transaction. tests/api/fiscal-credit-notes.spec.ts and
  // fiscal-documents.spec.ts drive both handlers under RLS.
  private async organizationOf(storeId: string): Promise<string | null> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { organizationId: true }
    })
    return store?.organizationId ?? null
  }

  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatus(payload: OrderStatusChangedPayload): Promise<void> {
    if (payload.to === OrderStatus.RETURNED) {
      await this.onOrderReturned(payload)
      return
    }
    let moment: FiscalIssueOn
    if (payload.to === OrderStatus.DELIVERED) moment = FiscalIssueOn.DELIVERED
    else if (payload.to === OrderStatus.SHIPPED) moment = FiscalIssueOn.SHIPPED
    else return
    try {
      const store = await this.prisma.client.store.findUnique({
        where: { id: payload.storeId },
        select: { organizationId: true }
      })
      if (store === null) return
      const documentId = await this.events.inOrganizationOfStore(payload.storeId, () =>
        this.documents.createForOrder(store.organizationId, payload.orderId, moment)
      )
      // A document that has just been made is the first submission
      if (documentId !== undefined && documentId !== null)
        await this.queue.enqueue(store.organizationId, documentId, 1)
    } catch (error) {
      this.logger.error(
        { err: errorName(error), orderId: payload.orderId },
        'the fiscal document of a sale was not made'
      )
    }
  }

  // An order that came back as a whole with no return row: one credit note for every unit. An order with received returns has one per
  // return, so this makes none for it.
  private async onOrderReturned(payload: OrderStatusChangedPayload): Promise<void> {
    try {
      const organizationId = await this.organizationOf(payload.storeId)
      if (organizationId === null) return
      const documentId = await this.events.inOrganizationOfStore(payload.storeId, () =>
        this.documents.createCreditNoteForOrder(organizationId, payload.orderId)
      )
      if (documentId !== undefined && documentId !== null)
        await this.queue.enqueue(organizationId, documentId, 1)
    } catch (error) {
      this.logger.error(
        { err: errorName(error), orderId: payload.orderId },
        'the credit note of a returned order was not made'
      )
    }
  }
}
