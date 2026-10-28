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
// which emoji and when, so that two customers reacting in the same second are two jobs.
export function inboundJobId(pluginId: string, event: ValidChannelEvent): string {
  const reaction = event.reaction
  const externalId =
    event.message?.externalId ??
    event.status?.externalId ??
    reaction?.targetExternalId ??
    event.timestamp
  const reactionParts =
    reaction === undefined
      ? []
      : reaction.eventId === undefined
        ? [event.channelIdentity, reaction.from ?? '', reaction.emoji ?? '', event.timestamp]
        : [reaction.eventId]
  const hash = createHash('sha256')
  for (const part of [pluginId, event.connectionId, event.type, externalId, ...reactionParts]) {
    hash.update(`${part.length}:${part}`)
  }
  return hash.digest('hex')
}
