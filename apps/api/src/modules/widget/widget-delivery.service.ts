import { Injectable } from '@nestjs/common'
import type { Namespace } from 'socket.io'

import { WidgetSocketEvents } from '@platform/core/domain'
import { RoomNames } from '@platform/core/realtime'

import type { WidgetMessageView } from './widget-message-view'

// The one way the api talks to the browsers of the visitors: a message into the room of one visitor,
// on whichever instance holds their socket. A visitor who is not connected loses nothing: the message
// is in the history the next bootstrap hands back.
@Injectable()
export class WidgetDelivery {
  private namespace: Namespace | null = null

  // Called once by the gateway when it starts
  attach(namespace: Namespace): void {
    this.namespace = namespace
  }

  typingToVisitor(siteKey: string, visitorId: string, active: boolean): void {
    this.namespace
      ?.to(RoomNames.widgetVisitor(siteKey, visitorId))
      .emit(WidgetSocketEvents.AGENT_TYPING, { active })
  }

  readToVisitor(siteKey: string, visitorId: string, messageId: string): void {
    this.namespace
      ?.to(RoomNames.widgetVisitor(siteKey, visitorId))
      .emit(WidgetSocketEvents.READ, { messageId })
  }

  toVisitor(siteKey: string, visitorId: string, message: WidgetMessageView): void {
    this.namespace
      ?.to(RoomNames.widgetVisitor(siteKey, visitorId))
      .emit(WidgetSocketEvents.MESSAGE, message)
  }
}
