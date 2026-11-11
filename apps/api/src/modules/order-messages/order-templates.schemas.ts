import { z } from 'zod'

import {
  CHANNEL_ID_PATTERN,
  MessageLimits,
  MisleadingTextPattern,
  OrderMessageKind,
  OrderMessageLimits,
  OrderMessageVariables,
  type OrderMessageVariable,
  singleLineText
} from '@platform/core/domain'
import { type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'

export const kindSchema = z.enum(OrderMessageKind)

// The languages the platform has texts for; a template of another language could never be chosen
export const localeSchema = z
  .string()
  .refine((value): value is Locale => (SUPPORTED_LOCALES as readonly string[]).includes(value), {
    message: 'not a supported language'
  })

// The text is kept as written: the line breaks are the owner's. A text with nothing visible, a NUL character (Postgres cannot
// hold it) or a character that reorders what the customer reads is refused.
const bodySchema = z
  .string()
  .max(OrderMessageLimits.BODY_MAX_LENGTH)
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
  .refine(value => !MisleadingTextPattern.test(value), {
    message: 'contains an invisible or direction-changing character'
  })
  .refine(value => value.trim() !== '', { message: 'is blank' })

const variableSchema = z.enum(
  Object.values(OrderMessageVariables) as [OrderMessageVariable, ...OrderMessageVariable[]]
)

// The template of the channel that the owner got approved, by name and language, and which variable of ours fills each of its
// numbered placeholders, in order (TDD_17 §4.7). Whether the channel takes one at all is checked against its declaration.
export const channelTemplateSchema = z.strictObject({
  pluginId: z.string().regex(CHANNEL_ID_PATTERN),
  // What the owner copied from the channel: one visible line with no space at its ends, as the manual send takes it
  name: singleLineText(MessageLimits.TEMPLATE_NAME_MAX_LENGTH, 1),
  language: singleLineText(MessageLimits.TEMPLATE_LANGUAGE_MAX_LENGTH, 1),
  variables: z.array(variableSchema).max(OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX)
})
export type ChannelTemplateLink = z.output<typeof channelTemplateSchema>

// The body of the PUT. `autoSend` left out takes the default of its kind; the kinds that follow a store preference refuse it
// when it is on (one source of truth, TDD_17 §4.7): the service checks it with the kind of the address.
export const putTemplateSchema = z.strictObject({
  body: bodySchema,
  autoSend: z.boolean().optional(),
  attachSummary: z.boolean().default(false),
  channelTemplate: channelTemplateSchema.nullable().default(null)
})
export type PutTemplateBody = z.output<typeof putTemplateSchema>

// The preview takes the text being edited and the language it is written in
export const previewTemplateSchema = z.strictObject({ body: bodySchema, locale: localeSchema })
export type PreviewTemplateBody = z.output<typeof previewTemplateSchema>
