import {
  SAFETY_SWITCHES,
  safetyChanged,
  safetyDraftOf,
  safetyInputOf,
  toggleRole
} from './safety-form'
import type { SafetyView } from './safety-requests'

const saved: SafetyView = {
  confirmDeleteCustomer: true,
  confirmDisconnectChannel: true,
  confirmRemoveMember: true,
  applyToRoles: ['Agent', 'Supervisor'],
  moderateRiskMode: 'dialog'
}

describe('safety form', () => {
  it('starts as what is saved and changes nothing', () => {
    const draft = safetyDraftOf(saved)
    expect(safetyChanged(saved, draft)).toBe(false)
    expect(safetyInputOf(saved, draft)).toEqual({})
  })

  it('sends only the keys that changed', () => {
    const draft = {
      ...safetyDraftOf(saved),
      confirmRemoveMember: false,
      moderateRiskMode: 'undo' as const
    }
    expect(safetyInputOf(saved, draft)).toEqual({
      confirmRemoveMember: false,
      moderateRiskMode: 'undo'
    })
    expect(safetyChanged(saved, draft)).toBe(true)
  })

  it('keeps the roles in the order of the preset, so the clicks leave no phantom change', () => {
    const added = toggleRole(safetyDraftOf(saved), 'Admin')
    expect(added.applyToRoles).toEqual(['Agent', 'Supervisor', 'Admin'])
    expect(safetyInputOf(saved, added)).toEqual({ applyToRoles: ['Agent', 'Supervisor', 'Admin'] })
    const back = toggleRole(added, 'Admin')
    expect(safetyChanged(saved, back)).toBe(false)
    // The saved list in another order is the same list
    expect(
      safetyChanged({ ...saved, applyToRoles: ['Supervisor', 'Agent'] }, safetyDraftOf(saved))
    ).toBe(false)
  })

  it('can send an empty list of roles', () => {
    const none = toggleRole(toggleRole(safetyDraftOf(saved), 'Agent'), 'Supervisor')
    expect(safetyInputOf(saved, none)).toEqual({ applyToRoles: [] })
  })

  it('lists the three switches of the settings', () => {
    expect(SAFETY_SWITCHES).toEqual([
      'confirmDeleteCustomer',
      'confirmDisconnectChannel',
      'confirmRemoveMember'
    ])
  })
})
