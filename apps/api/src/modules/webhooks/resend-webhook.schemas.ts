import { z } from 'zod'

// Resend sends one event per call. The envelope is checked first; the data of each type we act on
// is checked when we reach it, so an event type we ignore can never fail validation.
export const resendEnvelopeSchema = z.object({
  type: z.string(),
  data: z.unknown()
})

// Tags are echoed back as a name -> value object (storeId and template, set when the email is sent)
export const engagementDataSchema = z.object({
  email_id: z.string(),
  tags: z.record(z.string(), z.string()).optional()
})

export const failureDataSchema = z.object({
  to: z.array(z.string()).min(1),
  bounce: z.object({ type: z.string() }).optional(), // Only on email.bounced
  tags: z.record(z.string(), z.string()).optional()
})
