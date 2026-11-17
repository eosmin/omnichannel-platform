'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { useErrorText } from '../use-error-text'

import { reverseConflictOf } from './entry-conflict'

// The words for a refusal of the reversal of an entry: the sentence of its kind when the api names one, else the message of its code
export function useReverseErrorText(): (error: unknown) => string {
  const t = useTranslations('finance.entry.reverse.conflicts')
  const generic = useErrorText()
  return useCallback(
    (error: unknown): string => {
      const conflict = reverseConflictOf(error)
      return conflict !== null && t.has(conflict as 'reversal_not_reversible')
        ? t(conflict as 'reversal_not_reversible')
        : generic(error)
    },
    [t, generic]
  )
}
