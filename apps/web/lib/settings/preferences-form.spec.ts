import { OrderCancellationReasons } from '@platform/core/domain'
import { CancellationReasonLimits, storePreferencesSchema } from '@platform/core/store-preferences'

import {
  addCustomReason,
  factoryReasons,
  moveReason,
  nextReasonId,
  preferencesChanges,
  preferencesDraftOf,
  preferencesProblems,
  PreferencesProblems,
  removeReason,
  renameReason
} from './preferences-form'

const saved = storePreferencesSchema.parse({})
const draft = () => preferencesDraftOf(saved)

describe('the draft of the preferences', () => {
  it('starts from the saved values, which are the factory defaults for a store that chose none', () => {
    expect(draft()).toMatchObject({
      confirmOnCreate: false,
      sendSummaryOnCreate: true,
      overdueAfterDays: '7'
    })
    expect(draft().cancellationReasons).toEqual(factoryReasons())
  })

  it('copies the reasons, so editing the draft never edits the saved view', () => {
    const copy = draft()
    copy.cancellationReasons[0] = { id: 'x', label: 'X' }
    expect(saved.orders.cancellationReasons[0]?.id).toBe('CUSTOMER_REQUEST')
  })
})

describe('preferencesChanges', () => {
  it('is null when nothing changed', () => {
    expect(preferencesChanges(saved, draft())).toBeNull()
  })

  it('sends only the keys that changed, each in its block', () => {
    expect(
      preferencesChanges(saved, { ...draft(), confirmOnCreate: true, overdueAfterDays: '14' })
    ).toEqual({ orders: { confirmOnCreate: true }, remittances: { overdueAfterDays: 14 } })
    expect(
      preferencesChanges(saved, {
        ...draft(),
        failedAttemptMessages: 'first_only',
        freeShippingRule: 'any_item',
        sendSummaryOnCreate: false
      })
    ).toEqual({
      orders: {
        failedAttemptMessages: 'first_only',
        freeShippingRule: 'any_item',
        sendSummaryOnCreate: false
      }
    })
  })

  it('sends the reasons whole, with the text of a custom one trimmed, when the list changed', () => {
    const reasons = addCustomReason(draft().cancellationReasons, '  Fraud suspected ')
    const changes = preferencesChanges(saved, { ...draft(), cancellationReasons: reasons })
    expect(changes?.orders?.cancellationReasons).toHaveLength(7)
    expect(changes?.orders?.cancellationReasons?.at(-1)).toEqual({
      id: 'custom-1',
      label: 'Fraud suspected'
    })
  })

  it('does not send a number that cannot be read', () => {
    expect(preferencesChanges(saved, { ...draft(), overdueAfterDays: '0' })).toBeNull()
  })
})

describe('preferencesProblems', () => {
  it('finds none in the defaults', () => {
    expect(preferencesProblems(draft())).toEqual([])
  })

  it.each(['0', '91', 'x', '7.5', ''])('refuses %p days', overdueAfterDays => {
    expect(preferencesProblems({ ...draft(), overdueAfterDays })).toEqual([
      PreferencesProblems.OVERDUE_DAYS
    ])
  })

  it('accepts the ends of the range', () => {
    expect(preferencesProblems({ ...draft(), overdueAfterDays: '90' })).toEqual([])
    expect(preferencesProblems({ ...draft(), overdueAfterDays: '1' })).toEqual([])
  })

  it('refuses an empty list, too many, a blank text, a long one and a repeated one', () => {
    const base = draft()
    expect(preferencesProblems({ ...base, cancellationReasons: [] })).toEqual([
      PreferencesProblems.REASONS_EMPTY
    ])
    const many = Array.from({ length: CancellationReasonLimits.MAX_ENTRIES + 1 }, (_, i) => ({
      id: `c${i}`,
      label: `Reason ${i}`
    }))
    expect(preferencesProblems({ ...base, cancellationReasons: many })).toEqual([
      PreferencesProblems.REASONS_TOO_MANY
    ])
    expect(
      preferencesProblems({ ...base, cancellationReasons: [{ id: 'a', label: '   ' }] })
    ).toEqual([PreferencesProblems.REASON_BLANK])
    expect(
      preferencesProblems({
        ...base,
        cancellationReasons: [
          { id: 'a', label: 'x'.repeat(CancellationReasonLimits.MAX_LABEL_LENGTH + 1) }
        ]
      })
    ).toEqual([PreferencesProblems.REASON_TOO_LONG])
    expect(
      preferencesProblems({
        ...base,
        cancellationReasons: [
          { id: 'a', label: 'Fraud' },
          { id: 'b', label: ' fraud ' }
        ]
      })
    ).toEqual([PreferencesProblems.REASON_DUPLICATE])
  })
})

describe('the list of cancellation reasons', () => {
  it('gives a new reason the smallest id not in use', () => {
    expect(nextReasonId([])).toBe('custom-1')
    expect(
      nextReasonId([
        { id: 'custom-1', label: 'a' },
        { id: 'custom-3', label: 'b' }
      ])
    ).toBe('custom-2')
  })

  it('renames only a reason of the store, never a factory one', () => {
    const list = addCustomReason(factoryReasons(), 'Fraud')
    const renamed = renameReason(list, 'custom-1', 'Fraud suspected')
    expect(renamed.at(-1)).toEqual({ id: 'custom-1', label: 'Fraud suspected' })
    expect(renameReason(list, 'OTHER', 'Anything')).toEqual(list)
  })

  it('removes a reason by id', () => {
    expect(removeReason(factoryReasons(), 'OTHER').map(reason => reason.id)).not.toContain('OTHER')
  })

  it('moves a reason one place and leaves the edges alone', () => {
    const list = factoryReasons()
    expect(
      moveReason(list, 'OUT_OF_STOCK', -1)
        .map(reason => reason.id)
        .slice(0, 2)
    ).toEqual(['OUT_OF_STOCK', 'CUSTOMER_REQUEST'])
    expect(moveReason(list, 'CUSTOMER_REQUEST', -1)).toEqual(list)
    expect(moveReason(list, 'OTHER', 1)).toEqual(list)
    expect(moveReason(list, 'missing', 1)).toEqual(list)
  })

  it('restores the factory list, with the keys the dialog translates', () => {
    expect(factoryReasons()[0]).toEqual({
      id: 'CUSTOMER_REQUEST',
      labelKey: OrderCancellationReasons.CUSTOMER_REQUEST
    })
  })
})
