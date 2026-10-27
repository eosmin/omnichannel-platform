import { z } from 'zod'

import { CHANNEL_ID_PATTERN } from '@platform/core/domain'

import type { PluginRegistry } from './plugin-registry'

// A channel taken from a request (a filter, a routing condition, a connection route): a well-formed
// id that the registry knows. The registry is read when the schema parses, so a plugin registered
// later is accepted without building the schema again.
export function registeredChannelSchema(
  registry: Pick<PluginRegistry, 'isVisibleTo'>,
  storeId: string
): z.ZodString {
  return z
    .string()
    .regex(CHANNEL_ID_PATTERN)
    .refine(id => registry.isVisibleTo(id, storeId), { message: 'unknown channel' })
}
