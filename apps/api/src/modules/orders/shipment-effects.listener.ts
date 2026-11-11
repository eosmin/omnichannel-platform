import { Injectable } from '@nestjs/common'
import { OnEvent } from '@nestjs/event-emitter'

import { ShipmentLeftStatuses } from '@platform/core/domain'
import { Events, type ShipmentStatusChangedPayload } from '@platform/core/events'

import { OrderShipmentEffects } from './order-shipment-effects.service'

// A failure of the effects (a lock that timed out, a deadlock) is asked again a few times before a person is told
const RETRY_PAUSES_MS = [250, 1000, 3000] as const
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Every move of a shipment, wherever it came from (a person in the api, or the worker through the bridge), reaches the order
// here (TDD_17 §4.9), after the shipment's own transaction committed: the carrier's word is recorded whatever the order does
// with it. A bridged event is heard by one api instance only; and the effects are derived from the state, so a lost event is
// healed by the next one of the same shipment.
@Injectable()
export class ShipmentEffectsListener {
  constructor(private readonly effects: OrderShipmentEffects) {}

  @OnEvent(Events.SHIPMENT_STATUS_CHANGED)
  async onShipmentStatusChanged(payload: ShipmentStatusChangedPayload): Promise<void> {
    const { storeId, shipmentId, actor, from, to } = payload
    const justLeft = !ShipmentLeftStatuses.includes(from) && ShipmentLeftStatuses.includes(to)
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.effects.follow(storeId, shipmentId, actor, justLeft)
        return
      } catch (error) {
        const pause = RETRY_PAUSES_MS[attempt]
        if (pause === undefined) {
          await this.effects.reportFailure(storeId, shipmentId, actor, error)
          return
        }
        await wait(pause)
      }
    }
  }
}
