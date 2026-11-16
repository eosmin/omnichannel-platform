import { FiscalFieldLimits, fiscalReceiverPatchSchema } from '@platform/core/domain'

import { emptyAddressRow } from './address-rows'
import { emptyReceiverDraft, receiverPatchOf, receiverProblem } from './receiver-form'

describe('the form that fixes a receiver', () => {
  it('asks for at least one field, because the api refuses an empty change', () => {
    expect(receiverProblem(emptyReceiverDraft())).toEqual({ field: null, kind: 'nothing' })
    expect(fiscalReceiverPatchSchema.safeParse(receiverPatchOf(emptyReceiverDraft())).success).toBe(
      false
    )
  })

  it('sends only what was written, trimmed, and leaves the rest as it is', () => {
    const draft = { ...emptyReceiverDraft(), name: ' Ana ', phone: '555' }
    expect(receiverProblem(draft)).toBeNull()
    expect(receiverPatchOf(draft)).toEqual({ name: 'Ana', phone: '555' })
  })

  it('sends an address only when a line was written', () => {
    const draft = {
      ...emptyReceiverDraft(),
      email: 'a@example.com',
      address: [{ ...emptyAddressRow(), key: 'line1', value: 'Street 1' }]
    }
    expect(receiverPatchOf(draft)).toEqual({
      email: 'a@example.com',
      address: { line1: 'Street 1' }
    })
  })

  it('agrees with the schema of the api for every body it makes', () => {
    const drafts = [
      { ...emptyReceiverDraft(), taxId: '12345678' },
      { ...emptyReceiverDraft(), name: 'n'.repeat(FiscalFieldLimits.NAME) },
      {
        ...emptyReceiverDraft(),
        registrationId: 'r',
        address: [{ ...emptyAddressRow(), key: 'k', value: 'v' }]
      }
    ]
    for (const draft of drafts) {
      expect(receiverProblem(draft)).toBeNull()
      expect(fiscalReceiverPatchSchema.safeParse(receiverPatchOf(draft)).success).toBe(true)
    }
  })

  it('refuses a text longer than the api takes before sending it', () => {
    const draft = { ...emptyReceiverDraft(), name: 'n'.repeat(FiscalFieldLimits.NAME + 1) }
    expect(receiverProblem(draft)).toEqual({ field: 'name', kind: 'tooLong' })
    expect(fiscalReceiverPatchSchema.safeParse({ name: draft.name }).success).toBe(false)
  })

  it('refuses an address line with no value', () => {
    const draft = {
      ...emptyReceiverDraft(),
      name: 'Ana',
      address: [{ ...emptyAddressRow(), key: 'line1', value: '' }]
    }
    expect(receiverProblem(draft)).toEqual({ field: 'address', kind: 'incomplete' })
  })
})
