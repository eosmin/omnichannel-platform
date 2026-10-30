import { z } from 'zod'

import { MessageLimits } from '@platform/core/domain'

// What a template message keeps for the worker to send it: the `metadata` column is Json, so it is
// parsed again where it is read. The stored `content` is the text already filled in, for the thread.
export const templateMetadataSchema = z.object({
  template: z.object({
    name: z.string().min(1).max(MessageLimits.TEMPLATE_NAME_MAX_LENGTH),
    language: z.string().min(1).max(MessageLimits.TEMPLATE_LANGUAGE_MAX_LENGTH),
    variables: z.array(z.string().max(MessageLimits.TEMPLATE_VARIABLE_MAX_LENGTH))
  })
})

export type TemplateMetadata = z.output<typeof templateMetadataSchema>

// The approved template the agent chose, with its body filled in by the api before the message is stored
export interface RenderedTemplate {
  content: string
}
