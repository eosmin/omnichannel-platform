import { CountLimits } from '@platform/core/domain'

// What a person typed as the quantity found on the shelf. Empty takes the quantity back (the line is not counted);
// anything that is not whole units from 0 up to the ceiling of a movement is refused, never rounded.
export type ParsedQuantity = { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'invalid' }

export function parseCountedQuantity(text: string): ParsedQuantity {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (!/^\d{1,9}$/.test(trimmed)) return { kind: 'invalid' }
  const value = Number(trimmed)
  return value > CountLimits.MAX_COUNTED_QUANTITY ? { kind: 'invalid' } : { kind: 'ok', value }
}
