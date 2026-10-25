import type { ReactElement } from 'react'
import type { z } from 'zod'

import type { Locale } from '@platform/core/i18n'
import { createTranslator, type Translator } from '@platform/core/i18n-server'
import { type EmailTemplate, EmailTemplates } from '@platform/core/queues'

import { Invitation, invitationSchema } from './invitation'
import { MagicLink, magicLinkSchema } from './magic-link'

// What the renderer needs from a template: its data schema (the job payload is data from outside the
// type system), the namespace of its messages (which holds the subject) and its component.
interface TemplateDefinition<Props> {
  namespace: string
  schema: z.ZodType<Props>
  element: (props: Props, locale: Locale, t: Translator) => ReactElement
}

function define<Props>(definition: TemplateDefinition<Props>): RegisteredTemplate {
  return {
    build: (data, locale) => {
      const t = createTranslator(locale, definition.namespace)
      return {
        subject: t('subject'),
        element: definition.element(definition.schema.parse(data), locale, t)
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
    element: (props, locale, t) => Invitation({ ...props, locale, t })
  })
}
