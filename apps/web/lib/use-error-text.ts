'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { accountHolderOf, errorCodeOf, firstIssueOf, missingPermissionsOf } from './error-message'

// What the pieces below need of the translator, said loosely: the typed one of next-intl builds a union of
// every message key that is too big to compare a computed key against
export interface Translate {
  (key: string): string
  has(key: string): boolean
}

// The message of a code, or the generic one when the page has none for it (a code of a server newer than
// the page). Every code the api sends has its `errors.<code>` (validate:translations), so the messages
// are the list of the codes the page knows.
export function textOfCode(t: Translate, code: string): string {
  const key = `errors.${code}`
  return t.has(key) ? t(key) : t('errors.INTERNAL_ERROR')
}

// For a code that came as plain text (the reason a message was not delivered, a failed upload)
export function useCodeText(): (code: string) => string {
  const t = useTranslations() as unknown as Translate
  return useCallback((code: string): string => textOfCode(t, code), [t])
}

// The words to show for an error: the text of its code, and for a refusal for lack of permission the
// permission that is missing, by the name the team settings give it, so the person knows what to ask
// an administrator for. The api already says which one (`metadata.required` or `metadata.permissions`).
export function useErrorText(): (error: unknown) => string {
  const t = useTranslations()
  return useCallback(
    (error: unknown): string => {
      const missing = missingPermissionsOf(error)
      if (missing.length > 0) {
        const names = missing.map(permission => {
          const key = `settings.team.permissions.${permission.replace(':', '.')}`
          return t.has(key as 'errors.INTERNAL_ERROR')
            ? t(key as 'errors.INTERNAL_ERROR')
            : permission
        })
        return t('permissionDenied.named', { permission: names.join(', ') })
      }
      const issue = firstIssueOf(error)
      if (issue !== null) {
        const key = `validation.fields.${issue.field}`
        if (t.has(key as 'errors.INTERNAL_ERROR')) {
          const field = t(key as 'errors.INTERNAL_ERROR')
          return issue.index === null
            ? t('validation.check', { field })
            : t('validation.checkLine', { field, line: issue.index + 1 })
        }
      }
      const holder = accountHolderOf(error)
      if (holder !== null) return t('settings.channels.accountInUseNamed', { storeName: holder })
      return textOfCode(t as unknown as Translate, errorCodeOf(error))
    },
    [t]
  )
}
