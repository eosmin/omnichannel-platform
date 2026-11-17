import { ApiError } from '@platform/api-client'
import { FinanceConflicts } from '@platform/core/domain'

import messages from '../../messages/en.json'
import esMessages from '../../messages/es.json'

import { reverseConflictOf } from './entry-conflict'

const error = (metadata: Record<string, unknown>): ApiError =>
  new ApiError(409, 'RESOURCE_CONFLICT', 'refused', null, metadata)

describe('the kind of refusal of a reversal of an entry', () => {
  it('reads the conflicts the reversal names, and only those', () => {
    expect(reverseConflictOf(error({ conflict: FinanceConflicts.REVERSAL_NOT_REVERSIBLE }))).toBe(
      'reversal_not_reversible'
    )
    expect(
      reverseConflictOf(error({ conflict: FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION }))
    ).toBe('entry_owned_by_transaction')
    expect(reverseConflictOf(error({ conflict: FinanceConflicts.ACCOUNT_LIMIT }))).toBeNull()
    expect(reverseConflictOf(error({ conflict: 7 }))).toBeNull()
  })

  it('is null for what is not an api error', () => {
    expect(reverseConflictOf(new Error('x'))).toBeNull()
    expect(reverseConflictOf(null)).toBeNull()
  })

  it('has a sentence in both languages for every conflict it reads', () => {
    for (const kind of [
      FinanceConflicts.REVERSAL_NOT_REVERSIBLE,
      FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION
    ]) {
      const en = messages.finance.entry.reverse.conflicts as Record<string, string>
      const es = esMessages.finance.entry.reverse.conflicts as Record<string, string>
      expect(en[kind]).toBeTruthy()
      expect(es[kind]).toBeTruthy()
    }
  })
})
