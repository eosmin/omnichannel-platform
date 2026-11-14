import type { ReactElement } from 'react'
import type { z } from 'zod'

import type { Locale } from '@platform/core/i18n'
import { createTranslator, type Translator } from '@platform/core/i18n-server'
import { type EmailTemplate, EmailTemplates } from '@platform/core/queues'

import { Invitation, invitationSchema } from './invitation'
import { MagicLink, magicLinkSchema } from './magic-link'
import { NotificationDigest, notificationDigestSchema } from './notification-digest'
import { OrderMessage, orderMessageSchema } from './order-message'
import { ScheduledReport, scheduledReportSchema } from './scheduled-report'

// What the renderer needs from a template: its data schema (the job payload is data from outside the
// type system), the namespace of its messages (which holds the subject) and its component.
interface TemplateDefinition<Props> {
  namespace: string
  // Values the subject needs (the name of the store in an invitation)
  subjectParams?: (props: Props) => Record<string, string | number>
  schema: z.ZodType<Props>
  element: (props: Props, locale: Locale, t: Translator) => ReactElement
}

// A name that goes into a subject: free text of whoever invites, so it loses control and invisible
// characters (a line break would end the header) and is cut
const SUBJECT_NAME_MAX = 60

export function inSubject(value: string): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(clean).slice(0, SUBJECT_NAME_MAX).join('')
}

function define<Props>(definition: TemplateDefinition<Props>): RegisteredTemplate {
  return {
    build: (data, locale) => {
      const t = createTranslator(locale, definition.namespace)
      const props = definition.schema.parse(data)
      return {
        subject: t('subject', definition.subjectParams?.(props)),
        element: definition.element(props, locale, t)
      }
    }
  }
}

export interface RegisteredTemplate {
  build: (data: unknown, locale: Locale) => { subject: string; element: ReactElement }
}

// Record<EmailTemplate, ...>: adding a template to EmailTemplates without registering it is a type error
export const templateRegistry: Record<EmailTemplate, RegisteredTemplate> = {
  [EmailTemplates.MAGIC_LINK]: define({
    namespace: 'email.magicLink',
    schema: magicLinkSchema,
    element: (props, locale, t) => MagicLink({ ...props, locale, t })
  }),
  [EmailTemplates.INVITATION]: define({
    namespace: 'email.invitation',
    schema: invitationSchema,
    subjectParams: props => ({ store: inSubject(props.storeName) }),
    element: (props, locale, t) => Invitation({ ...props, locale, t })
  }),
  [EmailTemplates.NOTIFICATION_DIGEST]: define({
    namespace: 'email.notificationDigest',
    schema: notificationDigestSchema,
    element: (props, locale, t) => NotificationDigest({ ...props, locale, t })
  }),
  [EmailTemplates.ORDER_MESSAGE]: define({
    namespace: 'email.orderMessage',
    schema: orderMessageSchema,
    subjectParams: props => ({
      order: inSubject(props.orderNumber),
      store: inSubject(props.storeName)
    }),
    element: (props, locale, t) => OrderMessage({ ...props, locale, t })
  }),
  [EmailTemplates.SCHEDULED_REPORT]: define({
    namespace: 'email.scheduledReport',
    schema: scheduledReportSchema,
    subjectParams: props => ({ name: inSubject(props.name), store: inSubject(props.storeName) }),
    element: (props, locale, t) => ScheduledReport({ ...props, locale, t })
  })
}
