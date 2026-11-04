'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { errorCodeOf, firstIssueOf, missingPermissionsOf } from './error-message'

// The words to show for an error: the text of its code, and for a refusal for lack of permission the
// permission that is missing, by the name the team settings give it, so the person knows what to ask
// an administrator for. The api already says which one (`metadata.required`).
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
      return t(`errors.${errorCodeOf(error)}`)
    },
    [t]
  )
}
