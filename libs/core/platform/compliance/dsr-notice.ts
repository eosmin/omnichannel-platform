import type { JobsOptions } from 'bullmq'

import type { Locale } from '@platform/core/i18n'

import { EmailTemplates } from '../queues/email-templates'
import { type SendEmailJob } from '../queues/job-types'
import { dsrResultMailJobId, JobNames } from '../queues/queue-names'

import { ComplianceConfig, type DsrResultOutcome } from './compliance-constants'

// The closing mail of a data request, as the job the mail queue takes (Step 7.2-H2b-2). One builder for every flow that ends a request (the
// review queue, the expiry sweep, the erasure sweep), so the job always carries the ids the mail processor needs to confirm it on the request
// and never the address anywhere but `to`.
export interface DsrNoticeInput {
  requestId: string
  storeId: string
  to: string
  locale: Locale
  outcome: DsrResultOutcome
  requestType: string
  // What an erasure kept, for the legal-basis paragraph of the mail
  retainedOrders?: number
}

export interface DsrNoticeJob {
  name: typeof JobNames.SEND_EMAIL
  data: Omit<SendEmailJob, 'correlationId'>
  opts: JobsOptions
}

export function dsrNoticeJob(input: DsrNoticeInput): DsrNoticeJob {
  return {
    name: JobNames.SEND_EMAIL,
    data: {
      template: EmailTemplates.DSR_RESULT,
      to: input.to,
      locale: input.locale,
      data: {
        outcome: input.outcome,
        requestType: input.requestType,
        ...(input.retainedOrders === undefined ? {} : { retainedOrders: input.retainedOrders })
      },
      tags: { storeId: input.storeId, template: EmailTemplates.DSR_RESULT },
      dsrNotice: { requestId: input.requestId, storeId: input.storeId }
    },
    opts: {
      // One notice per request: asking again while one waits adds nothing. A job that failed is removed (it holds the address), so the sweep
      // that queues it again is not ignored
      jobId: dsrResultMailJobId(input.requestId),
      removeOnComplete: true,
      // The job holds the address in the clear: gone as soon as it is sent or fails. The request carries the outcome (`notice_failed_at`)
      removeOnFail: true,
      // Long enough for a mail server that is down for a few minutes (the default of the queue gives up in six seconds)
      attempts: ComplianceConfig.DSR_NOTICE_MAIL_ATTEMPTS,
      backoff: { type: 'exponential', delay: ComplianceConfig.DSR_NOTICE_MAIL_BACKOFF_MS }
    }
  }
}
