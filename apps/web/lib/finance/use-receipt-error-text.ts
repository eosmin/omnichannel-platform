'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { useErrorText } from '../use-error-text'

import { receiptRefusalOf } from './receipt-refusal'

// The words for a receipt that was not attached: the sentence of its refusal when it is one (see `receiptRefusalOf`), else the message of
// its code, as everywhere
export function useReceiptErrorText(): (error: unknown) => string {
  const t = useTranslations('finance.transactions.receipt.refusals')
  const errorText = useErrorText()
  return useCallback(
    (error: unknown): string => {
      const refusal = receiptRefusalOf(error)
      return refusal === null ? errorText(error) : t(refusal)
    },
    [t, errorText]
  )
}
