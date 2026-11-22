import { z } from 'zod'

import { DigestFrequency } from '@platform/core/domain'
import { Locales } from '@platform/core/i18n'

import { EmailTemplates, type EmailTemplate } from './email-templates'
import { exactly } from './exact-schema'
import { JobCorrelationIdLimits } from './job-payload-limits'
import type {
  CheckRemittancesJob,
  DeliverInvitationEmailJob,
  FetchCustomerProfileJob,
  QueueEmailDigestJob,
  RequestMagicLinkJob,
  SendEmailDigestJob,
  SendEmailJob,
  SendWebPushJob
} from './job-types'

// Bounded: the id is logged and echoed in a header
export const jobCorrelationIdSchema = z.string().max(JobCorrelationIdLimits.MAX_LENGTH).optional()

const EmailJobLimits = {
  ADDRESS_MAX_LENGTH: 320,
  RECIPIENTS_MAX: 50,
  ATTACHMENTS_MAX: 5,
  // A file of 8 MiB (what a report attaches at most) as base64; the size limit of the queue is the total
  ATTACHMENT_BASE64_MAX_LENGTH: Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4,
  NAME_MAX_LENGTH: 255,
  HEADERS_MAX: 20,
  HEADER_VALUE_MAX_LENGTH: 998 // RFC 5322: the line of a header
} as const

const emailAddress = z.string().min(1).max(EmailJobLimits.ADDRESS_MAX_LENGTH)
const emailTemplate = z.custom<EmailTemplate>(
  value => typeof value === 'string' && Object.values<string>(EmailTemplates).includes(value)
)

// The general email. What `data` holds is checked against the schema of its template when the template is rendered (`EmailService`)
export const sendEmailJobSchema = exactly<SendEmailJob>()(
  z.object({
    template: emailTemplate,
    to: z.union([emailAddress, z.array(emailAddress).min(1).max(EmailJobLimits.RECIPIENTS_MAX)]),
    locale: z.enum(Locales),
    data: z.record(z.string(), z.unknown()),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(EmailJobLimits.NAME_MAX_LENGTH),
          contentBase64: z.string().max(EmailJobLimits.ATTACHMENT_BASE64_MAX_LENGTH),
          contentType: z.string().min(1).max(EmailJobLimits.NAME_MAX_LENGTH)
        })
      )
      .max(EmailJobLimits.ATTACHMENTS_MAX)
      .optional(),
    headers: z
      .record(
        z.string().min(1).max(EmailJobLimits.NAME_MAX_LENGTH),
        z.string().max(EmailJobLimits.HEADER_VALUE_MAX_LENGTH)
      )
      .refine(headers => Object.keys(headers).length <= EmailJobLimits.HEADERS_MAX)
      .optional(),
    tags: z.object({ storeId: z.uuid().optional(), template: emailTemplate }),
    correlationId: jobCorrelationIdSchema
  })
)

export const requestMagicLinkJobSchema = exactly<RequestMagicLinkJob>()(
  z.object({ email: emailAddress, correlationId: jobCorrelationIdSchema })
)

export const deliverInvitationEmailJobSchema = exactly<DeliverInvitationEmailJob>()(
  z.object({ storeId: z.uuid(), invitationId: z.uuid(), correlationId: jobCorrelationIdSchema })
)

// The notifications queue
export const sendWebPushJobSchema = exactly<SendWebPushJob>()(
  z.object({ userId: z.uuid(), notificationId: z.uuid(), correlationId: jobCorrelationIdSchema })
)
export const queueEmailDigestJobSchema = exactly<QueueEmailDigestJob>()(
  z.object({ userId: z.uuid(), notificationId: z.uuid(), correlationId: jobCorrelationIdSchema })
)
export const sendEmailDigestJobSchema = exactly<SendEmailDigestJob>()(
  z.object({
    userId: z.uuid(),
    frequency: z.enum(DigestFrequency),
    correlationId: jobCorrelationIdSchema
  })
)
export const checkRemittancesJobSchema = exactly<CheckRemittancesJob>()(
  z.object({ storeId: z.uuid(), correlationId: jobCorrelationIdSchema })
)

export const fetchCustomerProfileJobSchema = exactly<FetchCustomerProfileJob>()(
  z.object({
    storeId: z.uuid(),
    identityId: z.uuid(),
    connectionRowId: z.uuid(),
    correlationId: jobCorrelationIdSchema
  })
)
