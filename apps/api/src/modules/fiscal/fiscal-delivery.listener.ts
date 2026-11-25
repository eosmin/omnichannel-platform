import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { type EventContext, InEventOrganization } from '@platform/core/database'
import { errorName } from '@platform/core/errors'
import { Events, type FiscalDocumentAcceptedPayload } from '@platform/core/events'

import { FiscalDeliveryService } from './fiscal-delivery.service'

// How many times the delivery is tried before the people who manage the fiscal documents are told that nobody gave the files, and how long
// the first wait is (it grows with each try)
export const FISCAL_DELIVERY_ATTEMPTS = 3
export const FISCAL_DELIVERY_RETRY_MS = 1000

// An accepted document owes its files to the receiver (the rule on delivering the files of a document). The worker says it when it accepts one, the api
// when it does: both reach this listener (the event is bridged). A failure here never reaches the document: it is decided and kept.
@Injectable()
export class FiscalDeliveryListener {
  constructor(
    private readonly events: EventContext,
    private readonly delivery: FiscalDeliveryService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalDeliveryListener.name)
  }

  @OnEvent(Events.FISCAL_DOCUMENT_ACCEPTED)
  @InEventOrganization()
  async onAccepted(payload: FiscalDocumentAcceptedPayload): Promise<void> {
    const input = {
      organizationId: payload.organizationId,
      storeId: payload.storeId,
      documentId: payload.documentId
    }
    for (let attempt = 1; attempt <= FISCAL_DELIVERY_ATTEMPTS; attempt++) {
      try {
        await this.delivery.deliver(input)
        return
      } catch (error) {
        this.logger.warn(
          { documentId: payload.documentId, attempt, err: errorName(error) },
          'the files of a fiscal document were not delivered'
        )
        if (attempt < FISCAL_DELIVERY_ATTEMPTS) await wait(FISCAL_DELIVERY_RETRY_MS * attempt)
      }
    }
    // Nobody will try again by itself: the person is told, and gives the files by hand
    try {
      await this.delivery.recordFailure(input)
    } catch (error) {
      this.logger.error(
        { documentId: payload.documentId, err: errorName(error) },
        'the failure to deliver the files of a fiscal document could not be recorded'
      )
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
