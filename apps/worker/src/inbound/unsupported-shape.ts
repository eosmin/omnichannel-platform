import { z } from 'zod'

import { MessageMetadataKeys, UnsupportedShapeLimits } from '@platform/core/domain'

// A name of a field, or `payload.coordinates`: plain characters only, so a value of the customer or a link
// can never be what the log holds
const part = `[A-Za-z0-9_]{1,${UnsupportedShapeLimits.NAME_MAX_LENGTH}}`
const name = z.string().regex(new RegExp(`^${part}(\\.${part})?$`))
const names = z.array(name).max(UnsupportedShapeLimits.MAX_NAMES)

const shapeSchema = z.object({
  messageFields: names,
  attachments: z
    .array(z.object({ type: name, fields: names, payloadFields: names }))
    .max(UnsupportedShapeLimits.MAX_ATTACHMENTS)
})

const typeSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/)

export interface UnsupportedShape {
  unsupportedType: string
  shape: z.infer<typeof shapeSchema>
}

// What the log of the worker keeps when a customer sends a type the channel cannot show (a place from
// Instagram, say): the type and the names of what it carried, to decide how to read it. Never a value.
export function unsupportedShapeOf(message: {
  metadata?: Record<string, unknown> | undefined
}): UnsupportedShape | null {
  const metadata = message.metadata
  if (metadata === undefined) return null
  const type = typeSchema.safeParse(metadata[MessageMetadataKeys.UNSUPPORTED_TYPE])
  const shape = shapeSchema.safeParse(metadata[MessageMetadataKeys.UNSUPPORTED_SHAPE])
  return type.success && shape.success ? { unsupportedType: type.data, shape: shape.data } : null
}
