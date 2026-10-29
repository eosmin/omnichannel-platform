import { z } from 'zod'

import { WidgetLimits } from '@platform/core/domain'

// eslint-disable-next-line no-control-regex -- the point is to refuse them
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const INVISIBLE_ONLY = /^[\s\u200b-\u200f\u2060\ufeff]*$/

// What a visitor sends: the token from the bootstrap, an id the browser made for the message (sending
// it again stores it once) and the text. The token travels in the body, beside what it authorizes, so
// that the plugin can check it where it reads the message.
export const widgetMessageSchema = z.object({
  visitorToken: z.string().min(1).max(512),
  clientMessageId: z
    .string()
    .min(1)
    .max(WidgetLimits.CLIENT_MESSAGE_ID_MAX_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/),
  content: z
    .string()
    .trim()
    .min(1)
    .max(WidgetLimits.CONTENT_MAX_LENGTH)
    // A NUL cannot be stored in text and the other controls are noise, but a line break and a tab are
    // what people type; a text of zero-width characters shows nothing
    .refine(text => !CONTROL_CHARACTERS.test(text), { message: 'control characters' })
    .refine(text => !INVISIBLE_ONLY.test(text), { message: 'nothing to show' })
})
export type WidgetMessage = z.output<typeof widgetMessageSchema>
