'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { ApiError } from '@platform/api-client'

import { useErrorText } from '../use-error-text'

import { conflictReasonOf } from './document-rules'

// The words for an error of a fiscal screen: the specific reason when the api names one (`metadata.reason`), else the message of its code
export function useFiscalErrorText(): (error: unknown) => string {
  const t = useTranslations('finance.fiscal.conflicts')
  const generic = useErrorText()
  return useCallback(
    (error: unknown): string => {
      const reason = error instanceof ApiError ? conflictReasonOf(error.metadata['reason']) : null
      return reason !== null && t.has(reason as 'already_replaced')
        ? t(reason as 'already_replaced')
        : generic(error)
    },
    [t, generic]
  )
}
