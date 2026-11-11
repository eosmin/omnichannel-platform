import { CountLimits, InventoryMovementType } from '@platform/core/domain'

// The pure rules of a physical count (TDD_16 §4.6). No database here: the services read the rows and these decide.

export interface CountLineFacts {
  // The on-hand snapshot taken when the count started
  expectedQuantity: number
  // Null until somebody counts it
  countedQuantity: number | null
}

// What the staff found against what the shelf was expected to hold when the count began. Null: not counted, which
// means "unknown", never "zero".
export function varianceOf(line: CountLineFacts): number | null {
  return line.countedQuantity === null ? null : line.countedQuantity - line.expectedQuantity
}

export interface CountMovement {
  type: typeof InventoryMovementType.COUNT_IN | typeof InventoryMovementType.COUNT_OUT
  quantity: number
}

// The movement that applying a line writes: the VARIANCE, never "counted minus what is there now". Sales and
// transfers that happened while the count was open already moved the level; the variance is the only thing the count
// knows about, so it is the only thing it writes. A line that was not counted, or whose variance is zero, writes none.
export function movementOf(line: CountLineFacts): CountMovement | null {
  const variance = varianceOf(line)
  if (variance === null || variance === 0) return null
  return variance > 0
    ? { type: InventoryMovementType.COUNT_IN, quantity: variance }
    : { type: InventoryMovementType.COUNT_OUT, quantity: -variance }
}

// The key of the movement of a line: a retry of the apply (or a second apply that raced the first) finds the movement
// it already wrote, so a line is never applied twice whatever happens to the request
export const countMovementKey = (countId: string, lineId: string): string =>
  `count:${countId}:${lineId}`

// CT-0001, CT-0002 ... (at least four digits; a fifth appears after 9999)
export function countNumber(sequence: number): string {
  return `${CountLimits.NUMBER_PREFIX}${String(sequence).padStart(CountLimits.NUMBER_MIN_DIGITS, '0')}`
}

export function sequenceOf(number: string): number | null {
  if (!number.startsWith(CountLimits.NUMBER_PREFIX)) return null
  const digits = number.slice(CountLimits.NUMBER_PREFIX.length)
  return /^[0-9]+$/.test(digits) ? Number(digits) : null
}
