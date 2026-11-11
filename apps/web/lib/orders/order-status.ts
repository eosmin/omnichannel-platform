import { OrderStatus } from '@platform/core/domain'

// A state of a server newer than this page is not one of ours: the screens draw it under "unknown" instead of as an
// empty cell. Null for one we do not know.
export function orderStatusKey(value: string): OrderStatus | null {
  return Object.values(OrderStatus).find(known => String(known) === value) ?? null
}
