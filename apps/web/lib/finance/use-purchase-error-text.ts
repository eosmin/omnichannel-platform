'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { useErrorText } from '../use-error-text'

import { purchaseErrorKeyOf } from './purchase-error'

// The words for an error of a purchase screen: the specific reason when the api names one, else the message of its code
export function usePurchaseErrorText(): (error: unknown) => string {
  const t = useTranslations('finance.purchases')
  const generic = useErrorText()
  return useCallback(
    (error: unknown): string => {
      const key = purchaseErrorKeyOf(error)
      return key !== null && t.has(key as 'status.draft')
        ? t(key as 'status.draft')
        : generic(error)
    },
    [t, generic]
  )
}
