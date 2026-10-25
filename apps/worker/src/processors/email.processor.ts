import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import { EmailService } from '@platform/core/email'
import { QueueNames, type SendEmailJob } from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

@Processor(QueueNames.EMAIL, {
  concurrency: 10,
  limiter: { max: 100, duration: 1000 } // Respect the provider's rate limit
})
export class EmailProcessor extends BaseProcessor<SendEmailJob> {
  constructor(
    support: ProcessorSupport,
    private readonly email: EmailService
  ) {
    super(QueueNames.EMAIL, support)
  }

  protected async handle(job: Job<SendEmailJob>): Promise<void> {
    try {
      await this.email.send(job.data)
    } catch (error) {
      // A payload the template rejects will be rejected again: retrying it only delays the dead letter
      if (error instanceof ZodError) throw new UnrecoverableError(error.message)
      throw error
    }
  }
}
