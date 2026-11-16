import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { FiscalIssueOn, OrderStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { Events, type OrderStatusChangedPayload } from '@platform/core/events'
import { FiscalDocumentsService } from '@platform/fiscal/runtime'

import { FiscalSubmissionQueue } from './fiscal-submission.queue'

// The sale makes its fiscal document (TDD_18 §8.3). When it is made is the issuer's setting (`issueOn`, owner and accountant,
// TDD_18 §13 row 3): at SHIPPED or at DELIVERED. A failure here never reaches the order: the sale stands and the document can be
// retried from the fiscal screens.
@Injectable()
export class FiscalListener {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly documents: FiscalDocumentsService,
    private readonly queue: FiscalSubmissionQueue
  ) {
    this.logger.setContext(FiscalListener.name)
  }

  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatus(payload: OrderStatusChangedPayload): Promise<void> {
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
      const documentId = await this.documents.createForOrder(
        store.organizationId,
        payload.orderId,
        moment
      )
      // A document that has just been made is the first submission
      if (documentId !== null) await this.queue.enqueue(store.organizationId, documentId, 1)
    } catch (error) {
      this.logger.error(
        { err: errorName(error), orderId: payload.orderId },
        'the fiscal document of a sale was not made'
      )
    }
  }
}
