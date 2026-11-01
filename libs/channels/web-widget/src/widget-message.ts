import { z } from 'zod'

import { WidgetLimits } from '@platform/core/domain'

// eslint-disable-next-line no-control-regex -- the point is to refuse them
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const INVISIBLE_ONLY = /^[\s\u200b-\u200f\u2060\ufeff]*$/

// What the pre-chat form collects, all of it optional and none of it proved. Only the size is checked
// here: a value the core cannot read (an address with no @) is dropped there, so that a typo does not
// cost the visitor their message.
export const widgetProfileSchema = z.strictObject({
  name: z.string().max(WidgetLimits.PROFILE_FIELD_MAX_LENGTH).optional(),
  email: z.string().max(WidgetLimits.PROFILE_FIELD_MAX_LENGTH).optional(),
  phone: z.string().max(WidgetLimits.PROFILE_FIELD_MAX_LENGTH).optional()
})
export type WidgetProfile = z.output<typeof widgetProfileSchema>

const contentSchema = z
  .string()
  .trim()
  .min(1)
  .max(WidgetLimits.CONTENT_MAX_LENGTH)
  // A NUL cannot be stored in text and the other controls are noise, but a line break and a tab are
  // what people type; a text of zero-width characters shows nothing
  .refine(text => !CONTROL_CHARACTERS.test(text), { message: 'control characters' })
  .refine(text => !INVISIBLE_ONLY.test(text), { message: 'nothing to show' })

// What a visitor sends: the token from the bootstrap, an id the browser made for the message (sending
// it again stores it once), the text and the files it asked `upload-url` for. The token travels in the
// body, beside what it authorizes, so that the plugin can check it where it reads the message. A
// message has text, files or both. Unknown keys are dropped, so `attachments` below cannot be sent.
// What both forms of the message share, so that a rule changed here changes for the api and the plugin
const messageBase = {
  visitorToken: z.string().min(1).max(512),
  clientMessageId: z
    .string()
    .min(1)
    .max(WidgetLimits.CLIENT_MESSAGE_ID_MAX_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/),
  content: contentSchema.optional(),
  // Sent with the first message once the visitor filled the form
  profile: widgetProfileSchema.optional()
}

export const widgetMessageSchema = z
  .object({
    ...messageBase,
    uploadIds: z.array(z.uuid()).max(WidgetLimits.UPLOADS_PER_MESSAGE).optional()
  })
  .refine(message => message.content !== undefined || (message.uploadIds?.length ?? 0) > 0, {
    message: 'nothing to send'
  })
export type WidgetMessage = z.output<typeof widgetMessageSchema>

// A file the api checked and recorded when it signed the url, handed to the plugin by the api and
// never read from a visitor's request: `id` is the upload id, the only thing the worker needs to find it
export const widgetAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(127)
})
export type WidgetAttachment = z.output<typeof widgetAttachmentSchema>

// The message as the api gives it to the plugin
export const widgetInboundSchema = z.object({
  ...messageBase,
  attachments: z.array(widgetAttachmentSchema).max(WidgetLimits.UPLOADS_PER_MESSAGE).optional()
})
export type WidgetInbound = z.output<typeof widgetInboundSchema>
