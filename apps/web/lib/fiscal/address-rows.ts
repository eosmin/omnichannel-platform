import { FiscalFieldLimits } from '@platform/core/domain'

// An address as the fiscal routes take it: short lines keyed by the provider's own field names. A person writes them as rows (a name and
// a value); a row left empty is no row, and nothing left is no address.
export interface AddressRow {
  // Only for the list of the form to tell its rows apart while they are edited and removed; never sent
  id: string
  key: string
  value: string
}

export const AddressProblems = {
  // A value with no name, or a name with no value
  INCOMPLETE: 'incomplete',
  // The same name twice
  DUPLICATE: 'duplicate',
  TOO_LONG: 'tooLong',
  TOO_MANY: 'tooMany'
} as const
export type AddressProblem = (typeof AddressProblems)[keyof typeof AddressProblems]

let rowCount = 0
const nextRowId = (): string => `address-row-${String((rowCount += 1))}`

export const emptyAddressRow = (): AddressRow => ({ id: nextRowId(), key: '', value: '' })

export const addressRowsOf = (address: Readonly<Record<string, unknown>>): AddressRow[] =>
  Object.entries(address).flatMap(([key, value]) =>
    typeof value === 'string' ? [{ id: nextRowId(), key, value }] : []
  )

const filled = (rows: readonly AddressRow[]): { key: string; value: string }[] =>
  rows
    .map(row => ({ key: row.key.trim(), value: row.value.trim() }))
    .filter(row => row.key !== '' || row.value !== '')

export function addressProblemOf(rows: readonly AddressRow[]): AddressProblem | null {
  const used = filled(rows)
  if (used.length > FiscalFieldLimits.ADDRESS_MAX_FIELDS) return AddressProblems.TOO_MANY
  if (used.some(row => row.key === '' || row.value === '')) return AddressProblems.INCOMPLETE
  if (
    used.some(
      row =>
        row.key.length > FiscalFieldLimits.ADDRESS_KEY ||
        row.value.length > FiscalFieldLimits.ADDRESS_VALUE
    )
  ) {
    return AddressProblems.TOO_LONG
  }
  if (new Set(used.map(row => row.key)).size !== used.length) return AddressProblems.DUPLICATE
  return null
}

// Call only after `addressProblemOf` said null
export const addressOf = (rows: readonly AddressRow[]): Record<string, string> =>
  Object.fromEntries(filled(rows).map(row => [row.key, row.value]))
