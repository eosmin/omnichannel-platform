import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  customerMessageOfShipment,
  FailedAttemptMessagePolicy,
  OrderMessageKind,
  type OrderMessageKindType,
  OrderMessageRoutes,
  OrderMessageSendFailed,
  OrderMessageTriggers,
  OrderStatus,
  OrderStatusMessageKinds,
  ShipmentKind,
  ShipmentStatus,
  ShipmentStatusesTold
} from '@platform/core/domain'
import { ErrorCodes, errorName, PlatformException } from '@platform/core/errors'
import {
  Events,
  type OrderCreatedPayload,
  type OrderStatusChangedPayload,
  type ShipmentStatusChangedPayload
} from '@platform/core/events'
import {
  automaticDispatchKey,
  creationDispatchKey,
  manualDispatchKey
} from '@platform/core/shipping'
import { readStorePreferences } from '@platform/core/store-preferences'

import { type SendOrderMessageInput, OrderMessagesService } from './order-messages.service'

// A failure of the send (the provider did not answer, a lock timed out) is asked again a few times before the team is told
const RETRY_PAUSES_MS = [250, 1000, 3000] as const
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// The messages that the orders send by themselves (TDD_17 §4.7, §4.9), after what happened committed: the summary when an order is
// created, the message of a status a person set with its "Notify customer" box, and the message of each status of a shipment. They
// run here and never inside the transaction or the webhook that caused them, and every one has the key that makes a repeated event
// send once. A bridged event (the worker moved the shipment) is heard by one api instance only.
@Injectable()
export class OrderMessageListener implements OnModuleDestroy {
  // The sends in flight: a stop of the process waits for them
  private readonly pending = new Set<Promise<void>>()
  private closing = false

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: OrderMessagesService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrderMessageListener.name)
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending])
  }

  // The summary of a new order goes if the person asked for it, and if they did not say, if the store asks for it
  @OnEvent(Events.ORDER_CREATED)
  onOrderCreated(payload: OrderCreatedPayload): Promise<void> {
    return this.track(async () => {
      const { storeId, orderId, actor } = payload
      const wanted =
        payload.sendSummary ?? (await this.preferencesOf(storeId)).orders.sendSummaryOnCreate
      if (!wanted) return
      await this.send({
        storeId,
        orderId,
        kind: OrderMessageKind.ORDER_SUMMARY,
        trigger: OrderMessageTriggers.AUTOMATIC,
        idempotencyKey: creationDispatchKey(orderId),
        requestedBy: actor.id
      })
    })
  }

  // A status a person set by hand: its box starts from the `autoSend` of the template of the kind, and the person may change it.
  // A status the order reached by following its shipment is told by the shipment's own message.
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  onOrderStatusChanged(payload: OrderStatusChangedPayload): Promise<void> {
    return this.track(async () => {
      const { storeId, orderId, actor, to } = payload
      if (actor.type !== 'user') return
      const kind: OrderMessageKindType | undefined = OrderStatusMessageKinds[to]
      if (kind === undefined || payload.notifyCustomer === false) return
      await this.send({
        storeId,
        orderId,
        kind,
        trigger: OrderMessageTriggers.AUTOMATIC,
        idempotencyKey: manualDispatchKey(orderId, kind, to),
        requestedBy: actor.id,
        // Checked: asked for, so a missing template is told. Not touched: what the template says
        onlyIfAutoSend: payload.notifyCustomer === null
      })
    })
  }

  // The customer is told what the carrier says about the package (the table of §4.9). A replay (the owner mapped a code late, and an
  // old event is read again) never writes to the customer: the package may have arrived days ago.
  @OnEvent(Events.SHIPMENT_STATUS_CHANGED)
  onShipmentStatusChanged(payload: ShipmentStatusChangedPayload): Promise<void> {
    return this.track(async () => {
      const { storeId, shipmentId, orderId, to } = payload
      // Most statuses say nothing to the customer: they cost no query
      if (payload.replay === true || !ShipmentStatusesTold.includes(to)) return
      const shipment = await this.prisma.client.shipment.findFirst({
        where: { id: shipmentId, storeId, orderId, kind: ShipmentKind.OUTBOUND },
        select: { failedAttempts: true, order: { select: { status: true } } }
      })
      // A package of an order that was cancelled is a matter for a person (the effects ask for a review), not a message
      if (shipment === null || shipment.order.status === String(OrderStatus.CANCELLED)) return
      // Only a failed attempt follows a preference
      const policy =
        to === ShipmentStatus.FAILED_ATTEMPT
          ? (await this.preferencesOf(storeId)).orders.failedAttemptMessages
          : FailedAttemptMessagePolicy.EVERY_ATTEMPT
      const message = customerMessageOfShipment({
        to,
        failedAttempts: shipment.failedAttempts,
        policy
      })
      if (message === null) return
      // A person who marked the order by hand before there was a package already told the customer: the package does not say it again
      if (await this.toldByHand(storeId, orderId, message.kind)) return
      await this.send({
        storeId,
        orderId,
        kind: message.kind,
        trigger: OrderMessageTriggers.AUTOMATIC,
        idempotencyKey: automaticDispatchKey(
          shipmentId,
          message.status,
          message.kind,
          message.attempt
        ),
        shipmentId,
        requestedBy: null,
        // The failed attempt follows its preference, not the `autoSend` of a template (TDD_17 §4.7)
        onlyIfAutoSend: message.kind !== OrderMessageKind.ORDER_FAILED_ATTEMPT
      })
    })
  }

  // The message of a kind that a person's change of status already sent for this order: the same key that change made (the status
  // that calls for the kind), so only that one is found, never another change of the order
  private async toldByHand(
    storeId: string,
    orderId: string,
    kind: OrderMessageKindType
  ): Promise<boolean> {
    const status = Object.entries(OrderStatusMessageKinds).find(([, of]) => of === kind)?.[0]
    if (status === undefined) return false
    const found = await this.prisma.client.orderMessageDispatch.findFirst({
      where: {
        storeId,
        idempotencyKey: manualDispatchKey(orderId, kind, status),
        route: { not: OrderMessageRoutes.NOT_SENT }
      },
      select: { id: true }
    })
    return found !== null
  }

  private async preferencesOf(storeId: string): Promise<ReturnType<typeof readStorePreferences>> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    return readStorePreferences(settings?.preferences ?? {})
  }

  // Asks again when the send fails for a cause that may pass. A cause that will not (the order is gone) is not asked again. When it
  // keeps failing the team is told, if the message is one that was asked for: a customer left untold in silence is something somebody
  // should know. A message that only goes if its template says so is not alerted (the store may never have wanted it), only logged.
  private async send(input: SendOrderMessageInput): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.messages.send(input)
        return
      } catch (error) {
        if (error instanceof PlatformException && error.code === ErrorCodes.RESOURCE_NOT_FOUND) {
          this.logger.warn(
            { orderId: input.orderId, kind: input.kind },
            'an order message was not sent: the order is gone'
          )
          return
        }
        const pause = RETRY_PAUSES_MS[attempt]
        // A stop of the process is not a reason to alert: what was not sent is sent by the next event
        if (this.closing) return
        if (pause === undefined) {
          this.logger.error(
            { orderId: input.orderId, kind: input.kind, errorName: errorName(error) },
            'an order message could not be sent'
          )
          if (input.onlyIfAutoSend !== true) await this.alert(input)
          return
        }
        await wait(pause)
      }
    }
  }

  private async alert(input: SendOrderMessageInput): Promise<void> {
    try {
      await this.messages.alertNotSent(input, OrderMessageSendFailed)
    } catch (error) {
      this.logger.error(
        { orderId: input.orderId, kind: input.kind, errorName: errorName(error) },
        'an unsent order message could not be reported'
      )
    }
  }

  private track(work: () => Promise<void>): Promise<void> {
    const running = work().catch((error: unknown) => {
      // Nothing here may reach the event that caused it: the order and the shipment are committed already
      this.logger.error({ errorName: errorName(error) }, 'an order message trigger failed')
    })
    this.pending.add(running)
    return running.finally(() => this.pending.delete(running))
  }
}
