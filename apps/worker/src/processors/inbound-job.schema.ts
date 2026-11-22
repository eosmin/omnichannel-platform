import { z } from 'zod'

import { CHANNEL_ID_PATTERN } from '@platform/core/domain'
import { exactly, jobCorrelationIdSchema } from '@platform/core/queues'
import { channelEventSchema, type ProcessChannelEventJob } from '@platform/plugins/runtime'

// The job as it comes back from Redis: the keys of the job type (a compile error when they differ), the event with the schema the controller
// checked it with, the id of a channel and an instant that reads as a date. The runtime lib cannot import the queues, so it lives here, apart from the processor so that a spec can read it without the services.
export const processChannelEventJobSchema = exactly<ProcessChannelEventJob>()(
  z.object({
    correlationId: jobCorrelationIdSchema,
    pluginId: z.string().regex(CHANNEL_ID_PATTERN),
    event: channelEventSchema,
    receivedAt: z.iso.datetime({ offset: true })
  })
)
