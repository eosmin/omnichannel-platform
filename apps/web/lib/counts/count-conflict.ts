import { ApiError } from '@platform/api-client'
import { CountConflicts } from '@platform/core/domain'

// The lines a refused apply names, from `metadata.lines` of the api: the ones the stock cannot cover (`requested` is
// what the variance takes out, `onHand` what the warehouse holds now) or the ones the engine refused for another reason
export interface ShortLine {
  lineId: string
  requested: number
  onHand: number | null
}
export interface RefusedLine {
  lineId: string
  code: string
}

export type ApplyRefusal =
  { kind: 'short_stock'; lines: ShortLine[] } | { kind: 'lines_refused'; lines: RefusedLine[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The refusal the apply screen explains line by line, or null for any other error (shown by its code)
export function applyRefusalOf(error: unknown): ApplyRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const lines = error.metadata['lines']
  if (!Array.isArray(lines)) return null
  if (error.metadata['conflict'] === CountConflicts.SHORT_STOCK) {
    return {
      kind: 'short_stock',
      lines: lines.flatMap(item =>
        isRecord(item) &&
        typeof item['lineId'] === 'string' &&
        typeof item['requested'] === 'number'
          ? [
              {
                lineId: item['lineId'],
                requested: item['requested'],
                onHand: typeof item['onHand'] === 'number' ? item['onHand'] : null
              }
            ]
          : []
      )
    }
  }
  if (error.metadata['conflict'] === CountConflicts.LINES_REFUSED) {
    return {
      kind: 'lines_refused',
      lines: lines.flatMap(item =>
        isRecord(item) && typeof item['lineId'] === 'string' && typeof item['code'] === 'string'
          ? [{ lineId: item['lineId'], code: item['code'] }]
          : []
      )
    }
  }
  return null
}

// Why a create or a start was refused with a 409, by `metadata.conflict`, or null
export function conflictOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const conflict = error.metadata['conflict']
  return typeof conflict === 'string' ? conflict : null
}
