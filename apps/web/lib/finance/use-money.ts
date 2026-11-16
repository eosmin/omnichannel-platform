'use client'

import { useLocale } from 'next-intl'
import { useCallback } from 'react'

import { moneyText } from './money'

// The text of an amount of cents in the language of the person
export function useMoney(): (cents: string | number) => string {
  const locale = useLocale()
  return useCallback((cents: string | number) => moneyText(locale, cents), [locale])
}
