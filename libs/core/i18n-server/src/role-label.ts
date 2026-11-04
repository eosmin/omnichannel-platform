import type { Locale } from '@platform/core/i18n'

import { messagesFor } from './messages'

// The name a role shows in a language. The four system roles are stored in English and are the same
// in every store, so an email names them from the message files ("Administrador", "Solo lectura");
// a role the store made keeps the name it was given.
export function roleLabelOf(locale: Locale, roleName: string): string {
  const names: Record<string, string> = messagesFor(locale).settings.team.roleNames
  return Object.hasOwn(names, roleName) ? (names[roleName] ?? roleName) : roleName
}
