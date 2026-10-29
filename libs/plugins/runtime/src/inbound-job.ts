import { createHash } from 'node:crypto'

import type { ValidChannelEvent } from './channel-event.schema'

// The payload of a job of the INBOUND queue. It lives here and not with the other job types because
// it carries the event of a plugin, and the core does not depend on the plugin SDK.
export interface ProcessChannelEventJob {
  correlationId?: string
  pluginId: string
  event: ValidChannelEvent
  receivedAt: string
}

// The same event delivered twice gets the same id, so a retry of the provider is one job while the
// first is still in Redis. The parts are length-prefixed: a ':' or a '|' in an id cannot make two
// different events look alike. The connection is a part because two accounts number their messages
// alike. What makes a duplicate harmless afterwards is the unique index of Message.
//
// A reaction is told apart by the id the provider gave it; without one, by who reacted, to what, with
// which emoji and when, so that two customers reacting in the same second are two jobs. An edit and a
// deletion are told apart the same way: a second edit of a message is another job, not a repeat of the
// first (a finished job keeps its id for a day).
export function inboundJobId(pluginId: string, event: ValidChannelEvent): string {
  const reaction = event.reaction
  const change = reaction ?? event.edit ?? event.deletion
  const externalId =
    event.message?.externalId ??
    event.status?.externalId ??
    change?.targetExternalId ??
    event.timestamp
  const changeParts =
    change === undefined
      ? []
      : change.eventId === undefined
        ? [
            event.channelIdentity,
            change.from ?? '',
            reaction === undefined ? (event.edit?.content ?? '') : (reaction.emoji ?? ''),
            event.timestamp
          ]
        : [change.eventId]
  const hash = createHash('sha256')
  for (const part of [pluginId, event.connectionId, event.type, externalId, ...changeParts]) {
    hash.update(`${part.length}:${part}`)
  }
  return hash.digest('hex')
}
