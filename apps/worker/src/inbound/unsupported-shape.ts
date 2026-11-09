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
    .array(
      z.object({
        type: name,
        fields: names,
        payloadFields: names,
        elementFields: z.array(name).max(UnsupportedShapeLimits.MAX_ELEMENT_NAMES).optional()
      })
    )
    .max(UnsupportedShapeLimits.MAX_ATTACHMENTS)
})

const typeSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/)

export interface UnsupportedShape {
  unsupportedType: string
  // Absent when the channel sends the type alone (it has no shape to tell)
  shape?: z.infer<typeof shapeSchema>
}

// What the log of the worker keeps when a customer sends a type the channel cannot show: the type and, where
// the channel tells it, the names of what it carried, to decide how to read it. Never a value.
export function unsupportedShapeOf(message: {
  metadata?: Record<string, unknown> | undefined
}): UnsupportedShape | null {
  const metadata = message.metadata
  if (metadata === undefined) return null
  const type = typeSchema.safeParse(metadata[MessageMetadataKeys.UNSUPPORTED_TYPE])
  if (!type.success) return null
  // A channel with no shape sends the type alone: the type is what is worth a line. A shape that is there and
  // does not fit is not logged at all (the processor says so apart).
  if (metadata[MessageMetadataKeys.UNSUPPORTED_SHAPE] === undefined) {
    return { unsupportedType: type.data }
  }
  const shape = shapeSchema.safeParse(metadata[MessageMetadataKeys.UNSUPPORTED_SHAPE])
  return shape.success ? { unsupportedType: type.data, shape: shape.data } : null
}

// The one line the worker writes for each such message: which plugin, which type and the names it carried. No
// id of the message, of the connection or of the customer, and no value: the line says what to map, nothing more.
export function unsupportedLogFields(
  pluginId: string,
  unsupported: UnsupportedShape
): { pluginId: string } & UnsupportedShape {
  return { pluginId, ...unsupported }
}
