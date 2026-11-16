'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { useErrorText } from '../use-error-text'

import { bankConflictOf } from './bank-statement'

// The words for a refusal of the reconciliation: a 409 names its kind (`metadata.conflict`) and each kind has its own sentence
// (`finance.reconciliation.conflicts.<kind>`); anything else is the common text of its code.
export function useBankErrorText(): (error: unknown) => string {
  const t = useTranslations('finance.reconciliation.conflicts')
  const errorText = useErrorText()
  return useCallback(
    (error: unknown): string => {
      const conflict = bankConflictOf(error)
      if (conflict !== null && t.has(conflict as 'bank_changed')) {
        return t(conflict as 'bank_changed')
      }
      return errorText(error)
    },
    [t, errorText]
  )
}
