import { DestructiveActionTiers } from '@platform/core/domain'

import {
  ConfirmationStyles,
  confirmationStyleFor,
  needsDestructiveButton,
  phraseMatches
} from './destructive-action'

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
