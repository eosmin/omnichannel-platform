import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, ChannelIds, OutboundLimits } from '@platform/core/domain'
import { OutboundQueue } from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import { WidgetDelivery } from '../widget/widget-delivery.service'

// Shows the customer that an agent is typing, on the channels that can: the web widget through its
// socket, the others through the outbound queue and the worker (only when the plugin declares
// TYPING_INDICATOR). Best effort. Calls for one conversation run one after another, so a start and the
// stop that follows it reach the channel in that order. The first start in a slot does the work and the
// repeats the client sends while the agent types are dropped before the database; a stop goes only after
// a start that went, and a start after a stop waits a short gap, so a client that alternates the two
// cannot flicker the indicator. A start that is going to reach the channel first asks `mayStart`, which
// looks at what the agent may do now and not at what their socket held a while ago. The memory is per
// process, which is enough for one api instance: with several, each one lets a start through per slot.
// If two agents type in one conversation, the stop of the first also takes the indicator away: the next
// start of the other brings it back.
interface TypingState {
  // Whether the channel was last told "typing"
  on: boolean
  // When it was last told, whichever it was: the slot of a start and the gap after a stop count from it
  at: number
}

@Injectable()
export class AgentTypingRelay {
  // Insertion order is the order of `at` (a send deletes before it sets), so the old ones are at the front
  private readonly states = new Map<string, TypingState>()
  private readonly tails = new Map<string, Promise<void>>()
  private lastStamp = 0

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly outbound: OutboundQueue,
    private readonly widget: WidgetDelivery
  ) {}

  relay(
    storeId: string,
    conversationId: string,
    active: boolean,
    mayStart?: () => Promise<boolean>
  ): Promise<void> {
    const previous = this.tails.get(conversationId) ?? Promise.resolve()
    const run = previous.then(() => this.deliver(storeId, conversationId, active, mayStart))
    // A failure belongs to the caller of this call, not to the one queued behind it
    const tail = run.catch(() => undefined)
    this.tails.set(conversationId, tail)
    void tail.then(() => {
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId)
    })
    return run
  }

  private async deliver(
    storeId: string,
    conversationId: string,
    active: boolean,
    mayStart: (() => Promise<boolean>) | undefined
  ): Promise<void> {
    const now = Date.now()
    const state = this.states.get(conversationId)
    if (active) {
      if (state?.on === true && now - state.at < OutboundLimits.TYPING_ON_SLOT_MS) return
      if (state?.on === false && now - state.at < OutboundLimits.TYPING_MIN_GAP_MS) return
    } else if (state?.on !== true) {
      return
    }
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: {
        channelConnection: { select: { pluginId: true, connectionId: true, status: true } },
        customerIdentity: { select: { channelIdentity: true } }
      }
    })
    // A stop that finds nothing to tell leaves nothing remembered: the channel is not showing it any more
    if (conversation === null) {
      this.forget(conversationId, active)
      return
    }
    const { pluginId, connectionId: siteKey, status } = conversation.channelConnection
    if (status !== String(ChannelConnectionStatus.ACTIVE)) {
      this.forget(conversationId, active)
      return
    }
    const isWidget = pluginId === ChannelIds.WEB_WIDGET
    const queued =
      !isWidget && this.registry.hasCapability(pluginId, ChannelCapability.TYPING_INDICATOR)
    // A channel with nobody to tell is remembered too, so that its repeats stop at the memory and not at
    // the database
    if (active && (isWidget || queued) && mayStart !== undefined && !(await mayStart())) return
    // Remembered after the delivery, and only for a conversation of this store: a start that could not
    // be queued leaves no slot behind
    if (isWidget) {
      this.widget.typingToVisitor(siteKey, conversation.customerIdentity.channelIdentity, active)
    } else if (queued) {
      await this.outbound.enqueueTyping({ storeId, conversationId, active, at: this.stamp(now) })
    }
    this.remember(conversationId, { on: active, at: Date.now() })
  }

  private forget(conversationId: string, active: boolean): void {
    if (!active) this.states.delete(conversationId)
  }

  // Each job is stamped later than the one before, so the worker can tell which is newer even inside
  // one millisecond
  private stamp(now: number): number {
    this.lastStamp = Math.max(now, this.lastStamp + 1)
    return this.lastStamp
  }

  // A conversation stays in the map for as long as the indicator can be on; an agent who walks away
  // without a stop leaves it there, so the old ones go whenever a new one comes in
  private remember(conversationId: string, state: TypingState): void {
    this.states.delete(conversationId)
    this.states.set(conversationId, state)
    for (const [id, old] of this.states) {
      if (state.at - old.at < OutboundLimits.TYPING_ACTIVE_MS) break
      this.states.delete(id)
    }
  }
}
