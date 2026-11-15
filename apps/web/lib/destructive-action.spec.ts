import { DestructiveActionTiers } from '@platform/core/domain'

import {
  ConfirmationStyles,
  confirmationStyleFor,
  needsDestructiveButton,
  phraseMatches
} from './destructive-action'
import type { SafetyPolicy } from './safety-policy'

describe('confirmationStyleFor', () => {
  it('asks to type a phrase for a critical action', () => {
    expect(confirmationStyleFor('DELETE_STORE')).toBe(ConfirmationStyles.TYPED_PHRASE)
  })

  it('shows a dialog for a high or moderate action', () => {
    expect(confirmationStyleFor('DISCONNECT_CHANNEL')).toBe(ConfirmationStyles.DIALOG)
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION')).toBe(ConfirmationStyles.DIALOG)
  })

  it('offers an undo toast for a low action', () => {
    expect(confirmationStyleFor('SEND_MESSAGE')).toBe(ConfirmationStyles.UNDO_TOAST)
  })

  it('has a style for every action of the tier table', () => {
    for (const action of Object.keys(
      DestructiveActionTiers
    ) as (keyof typeof DestructiveActionTiers)[]) {
      expect(Object.values(ConfirmationStyles)).toContain(confirmationStyleFor(action))
    }
  })
})

describe('phraseMatches', () => {
  it('ignores the whitespace around the typed text but not its case', () => {
    expect(phraseMatches('  Mi tienda ', 'Mi tienda')).toBe(true)
    expect(phraseMatches('mi tienda', 'Mi tienda')).toBe(false)
    expect(phraseMatches('', 'Mi tienda')).toBe(false)
  })

  it('matches a phrase that has whitespace of its own', () => {
    expect(phraseMatches('Mi tienda', 'Mi tienda ')).toBe(true)
  })
})

describe('needsDestructiveButton', () => {
  it('is true for the critical and high tiers and false for the others', () => {
    expect(needsDestructiveButton('DELETE_STORE')).toBe(true)
    expect(needsDestructiveButton('DISCONNECT_CHANNEL')).toBe(true)
    expect(needsDestructiveButton('ARCHIVE_CONVERSATION')).toBe(false)
    expect(needsDestructiveButton('SEND_MESSAGE')).toBe(false)
  })
})

// What the store chose (TDD_09 §11.2). The factory settings: the three switches on, Agent and Supervisor asked, a dialog for the moderate ones
function policyOf(role: string, change: Partial<SafetyPolicy> = {}): SafetyPolicy {
  return {
    role,
    confirm: {
      confirmDeleteCustomer: true,
      confirmDisconnectChannel: true,
      confirmRemoveMember: true
    },
    applyToRoles: ['Agent', 'Supervisor'],
    moderateRiskMode: 'dialog',
    ...change
  }
}

describe('confirmationStyleFor with the settings of the store', () => {
  it('asks as the tier table says when no settings are known', () => {
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, null)).toBe(ConfirmationStyles.DIALOG)
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION', true, null)).toBe(ConfirmationStyles.DIALOG)
  })

  it('never lets the settings take the typed phrase away from a critical action, whatever the role', () => {
    const off = policyOf('Admin', {
      confirm: {
        confirmDeleteCustomer: false,
        confirmDisconnectChannel: false,
        confirmRemoveMember: false
      },
      applyToRoles: [],
      moderateRiskMode: 'none'
    })
    for (const action of [
      'DELETE_CONVERSATION',
      'REVOKE_API_KEY',
      'DELETE_STORE',
      'REVOKE_ALL_PLUGIN_ACCESS'
    ] as const) {
      expect(confirmationStyleFor(action, true, off)).toBe(ConfirmationStyles.TYPED_PHRASE)
    }
  })

  it('asks the roles that are listed and lets the others act, for a switched action', () => {
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, policyOf('Agent'))).toBe(
      ConfirmationStyles.DIALOG
    )
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, policyOf('Supervisor'))).toBe(
      ConfirmationStyles.DIALOG
    )
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, policyOf('Admin'))).toBe(
      ConfirmationStyles.NONE
    )
    expect(
      confirmationStyleFor('DELETE_CUSTOMER', false, policyOf('Admin', { applyToRoles: ['Admin'] }))
    ).toBe(ConfirmationStyles.DIALOG)
  })

  it('stops asking a preset role when the switch of the action is off, and only for that action', () => {
    const policy = policyOf('Agent', {
      confirm: {
        confirmDeleteCustomer: false,
        confirmDisconnectChannel: true,
        confirmRemoveMember: true
      }
    })
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, policy)).toBe(ConfirmationStyles.NONE)
    expect(confirmationStyleFor('DISCONNECT_CHANNEL', false, policy)).toBe(
      ConfirmationStyles.DIALOG
    )
    expect(confirmationStyleFor('REMOVE_TEAM_MEMBER', false, policy)).toBe(
      ConfirmationStyles.DIALOG
    )
  })

  it('always asks a custom role, even with every switch off and no role listed', () => {
    const off = policyOf('Warehouse lead', {
      confirm: {
        confirmDeleteCustomer: false,
        confirmDisconnectChannel: false,
        confirmRemoveMember: false
      },
      applyToRoles: []
    })
    expect(confirmationStyleFor('DELETE_CUSTOMER', false, off)).toBe(ConfirmationStyles.DIALOG)
    expect(confirmationStyleFor('DISCONNECT_CHANNEL', false, off)).toBe(ConfirmationStyles.DIALOG)
    expect(confirmationStyleFor('REMOVE_TEAM_MEMBER', false, off)).toBe(ConfirmationStyles.DIALOG)
  })

  it('keeps asking for a high action that has no switch, whatever the settings', () => {
    const off = policyOf('Admin', {
      confirm: {
        confirmDeleteCustomer: false,
        confirmDisconnectChannel: false,
        confirmRemoveMember: false
      },
      applyToRoles: []
    })
    for (const action of [
      'APPLY_STOCK_COUNT',
      'DELETE_WEBHOOK',
      'ROTATE_WEBHOOK_SECRET',
      'MARK_GUIDE_VOIDED_BY_HAND',
      'CANCEL_ORDER_WITH_SHIPMENT'
    ] as const) {
      expect(confirmationStyleFor(action, false, off)).toBe(ConfirmationStyles.DIALOG)
    }
  })

  it('follows the moderate mode, and keeps the dialog for an action that cannot be undone', () => {
    const undo = policyOf('Agent', { moderateRiskMode: 'undo' })
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION', true, undo)).toBe(
      ConfirmationStyles.UNDO_TOAST
    )
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION', false, undo)).toBe(
      ConfirmationStyles.DIALOG
    )
    const none = policyOf('Agent', { moderateRiskMode: 'none' })
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION', true, none)).toBe(ConfirmationStyles.NONE)
    expect(confirmationStyleFor('EDIT_CUSTOMER_IDENTITY', false, none)).toBe(
      ConfirmationStyles.NONE
    )
    expect(
      confirmationStyleFor(
        'ARCHIVE_CONVERSATION',
        true,
        policyOf('Agent', { moderateRiskMode: 'dialog' })
      )
    ).toBe(ConfirmationStyles.DIALOG)
  })

  it('leaves a low action as an undo toast', () => {
    expect(
      confirmationStyleFor('SEND_MESSAGE', true, policyOf('Admin', { moderateRiskMode: 'none' }))
    ).toBe(ConfirmationStyles.UNDO_TOAST)
  })

  it('reads the policy of the store on screen when none is passed', async () => {
    const { setSafetyPolicy } = await import('./safety-policy')
    setSafetyPolicy(policyOf('Agent', { moderateRiskMode: 'none' }))
    try {
      expect(confirmationStyleFor('ARCHIVE_CONVERSATION')).toBe(ConfirmationStyles.NONE)
    } finally {
      setSafetyPolicy(null)
    }
    expect(confirmationStyleFor('ARCHIVE_CONVERSATION')).toBe(ConfirmationStyles.DIALOG)
  })
})
