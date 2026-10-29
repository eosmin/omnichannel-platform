import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { CHANNEL_ID_PATTERN } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import {
  InboundMessageChangesService,
  InboundMessageService,
  MessageReactionsService
} from '@platform/core/messaging'
import { QueueNames } from '@platform/core/queues'
import { channelEventSchema, type ProcessChannelEventJob } from '@platform/plugins/runtime'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { ProfileRequester } from '../inbound/profile-requester.service'
import { ChannelReceipts } from '../outbound/channel-receipts.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

// The worker half of TDD_10 §4: the controller of the api queued what the plugin normalized, and this
// does the work. The job crossed Redis, so the event is checked again before anything reads it.
@Processor(QueueNames.INBOUND, { concurrency: 20 })
export class InboundProcessor extends BaseProcessor<ProcessChannelEventJob> {
  constructor(
    support: ProcessorSupport,
    private readonly inbound: InboundMessageService,
    private readonly reactions: MessageReactionsService,
    private readonly changes: InboundMessageChangesService,
    private readonly receipts: ChannelReceipts,
    private readonly profiles: ProfileRequester,
    private readonly logger: PinoLogger
  ) {
    super(QueueNames.INBOUND, support)
    this.logger.setContext(InboundProcessor.name)
  }

  protected async handle(job: Job<ProcessChannelEventJob>): Promise<void> {
    const { pluginId } = job.data
    const parsed = channelEventSchema.safeParse(job.data.event)
    // What does not fit now will not fit when it is tried again: it goes to the dead letter queue
    if (!CHANNEL_ID_PATTERN.test(pluginId) || !parsed.success) {
      throw new UnrecoverableError('the channel event does not fit its schema')
    }
    const event = parsed.data

    switch (event.type) {
      case ChannelEventTypes.MESSAGE_RECEIVED: {
        if (event.message === undefined) throw new UnrecoverableError('no message to receive')
        try {
          await this.inbound.handleMessageReceived(
            pluginId,
            { ...event, message: event.message },
            new Date(job.data.receivedAt)
          )
        } catch (error) {
          throw unrecoverableIfInvalid(error)
        }
        await this.profiles.request(pluginId, event.connectionId, event.channelIdentity)
        return
      }
      case ChannelEventTypes.MESSAGE_ECHO: {
        if (event.message === undefined) throw new UnrecoverableError('no message to echo')
        try {
          await this.inbound.handleMessageEcho(
            pluginId,
            { ...event, message: event.message },
            isLastAttempt(job),
            new Date(job.data.receivedAt)
          )
        } catch (error) {
          throw unrecoverableIfInvalid(error)
        }
        return
      }
      case ChannelEventTypes.MESSAGE_REACTION:
        if (event.reaction === undefined) throw new UnrecoverableError('no reaction to apply')
        await this.reactions.handleInbound(
          pluginId,
          { ...event, reaction: event.reaction },
          isLastAttempt(job)
        )
        return
      case ChannelEventTypes.MESSAGE_EDITED:
        if (event.edit === undefined) throw new UnrecoverableError('no edit to apply')
        await this.changes.handleEdited(
          pluginId,
          { ...event, edit: event.edit },
          isLastAttempt(job)
        )
        return
      case ChannelEventTypes.MESSAGE_DELETED:
        if (event.deletion === undefined) throw new UnrecoverableError('no deletion to apply')
        await this.changes.handleDeleted(
          pluginId,
          { ...event, deletion: event.deletion },
          isLastAttempt(job)
        )
        return
      case ChannelEventTypes.MESSAGE_DELIVERED:
      case ChannelEventTypes.MESSAGE_READ:
      case ChannelEventTypes.MESSAGE_FAILED:
        await this.receipts.handleReceipt(
          pluginId,
          { ...event, type: event.type },
          isLastAttempt(job)
        )
        return
      case ChannelEventTypes.CONNECTION_ERROR:
        await this.receipts.handleConnectionError(pluginId, { ...event, type: event.type })
        return
      default:
        // What the platform sends itself is not news, and the typing of the customer waits for the
        // inbox (Step 3.x)
        this.logger.debug({ pluginId, type: event.type }, 'channel event not handled')
    }
  }
}

// A handle that is not one on that channel will not become one
function unrecoverableIfInvalid(error: unknown): unknown {
  return error instanceof PlatformException && error.code === ErrorCodes.VALIDATION_INVALID_INPUT
    ? new UnrecoverableError(error.message)
    : error
}
