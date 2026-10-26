import { Inject, Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import type { MessagingWindowPolicy } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

import { canSee, channelOf, type Db, type Viewer } from '../conversations'

import {
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource
} from './messaging-window.policy'

const HOUR_MS = 60 * 60 * 1000

// Whether the store may answer a customer with free text now. `closesAt` is the moment the window
// ends (null when the channel has no window, or when the customer never wrote and there is none to
// count from), so the composer can say how long is left.
export interface MessagingWindowState {
  open: boolean
  closesAt: Date | null
  requiresTemplate: boolean
}

// The 24-hour rule of WhatsApp, Instagram and Messenger. The window belongs to the customer and the
// channel (it is counted from the last message of that identity), not to one conversation.
@Injectable()
export class MessagingWindowService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_WINDOW_POLICIES) private readonly policies: MessagingWindowPolicySource
  ) {}

  // For the composer: only who may see the conversation asks
  async get(
    storeId: string,
    conversationId: string,
    viewer: Viewer
  ): Promise<MessagingWindowState> {
    return this.read(this.prisma.client, storeId, conversationId, viewer)
  }

  // Before a reply is stored: a closed window answers CHANNEL_WINDOW_EXPIRED, which the offline queue
  // of the client treats as final (TDD_06 §4). The reads run in the transaction of the caller.
  async requireOpen(db: Db, storeId: string, conversationId: string): Promise<void> {
    const state = await this.read(db, storeId, conversationId)
    if (state.open) return
    throw new PlatformException(
      ErrorCodes.CHANNEL_WINDOW_EXPIRED,
      'the messaging window of the channel is closed',
      HttpStatusCodes.CONFLICT,
      { requiresTemplate: state.requiresTemplate }
    )
  }

  private async read(
    db: Db,
    storeId: string,
    conversationId: string,
    viewer?: Viewer
  ): Promise<MessagingWindowState> {
    const row = await db.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: {
        channelType: true,
        status: true,
        assignedTo: true,
        customerIdentity: { select: { lastInboundAt: true } }
      }
    })
    if (row === null || !canSee(viewer, row)) throw resourceNotFound('conversation')
    const policy = this.policies.policyFor(channelOf(row.channelType))
    return stateOf(policy, row.customerIdentity.lastInboundAt, new Date())
  }
}

// A window opens when the customer writes and lasts `hours`; it is closed at the very moment it ends
export function stateOf(
  policy: MessagingWindowPolicy | null,
  lastInboundAt: Date | null,
  now: Date
): MessagingWindowState {
  if (policy === null) return { open: true, closesAt: null, requiresTemplate: false }
  // A message cannot come from the future: a clock that runs ahead does not make the window longer
  const closesAt =
    lastInboundAt === null
      ? null
      : new Date(Math.min(lastInboundAt.getTime(), now.getTime()) + policy.hours * HOUR_MS)
  const open = closesAt !== null && now.getTime() < closesAt.getTime()
  return { open, closesAt, requiresTemplate: !open && policy.requiresTemplateWhenClosed }
}
