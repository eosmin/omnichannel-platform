import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { CHANNEL_ID_PATTERN } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { InboundMessageService } from '@platform/core/messaging'
import { QueueNames } from '@platform/core/queues'
import { channelEventSchema, type ProcessChannelEventJob } from '@platform/plugins/runtime'
import { ChannelEventTypes } from '@platform/plugins/sdk'

import { ChannelReceipts } from '../outbound/channel-receipts.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// The worker half of TDD_10 §4: the controller of the api queued what the plugin normalized, and this
// does the work. The job crossed Redis, so the event is checked again before anything reads it.
@Processor(QueueNames.INBOUND, { concurrency: 20 })
export class InboundProcessor extends BaseProcessor<ProcessChannelEventJob> {
  constructor(
    support: ProcessorSupport,
    private readonly inbound: InboundMessageService,
    private readonly receipts: ChannelReceipts,
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
          // A handle that is not one on that channel will not become one
          if (
            error instanceof PlatformException &&
            error.code === ErrorCodes.VALIDATION_INVALID_INPUT
          ) {
            throw new UnrecoverableError(error.message)
          }
          throw error
        }
        return
      }
      case ChannelEventTypes.MESSAGE_DELIVERED:
      case ChannelEventTypes.MESSAGE_READ:
      case ChannelEventTypes.MESSAGE_FAILED:
        await this.receipts.handleReceipt(
          pluginId,
          { ...event, type: event.type },
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
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
