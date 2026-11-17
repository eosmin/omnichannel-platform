'use client'

import { useLocale } from 'next-intl'
import { useCallback } from 'react'

import { moneyText, percentFigureText } from './money'

// The text of an amount of cents in the language of the person
export function useMoney(): (cents: string | number) => string {
  const locale = useLocale()
  return useCallback((cents: string | number) => moneyText(locale, cents), [locale])
}

// The figure of a rate in the language of the person (see `percentFigureText`)
export function usePercentFigure(): (bps: number) => string {
  const locale = useLocale()
  return useCallback((bps: number) => percentFigureText(locale, bps), [locale])
}

// A rate or a margin written in basis points (1250 is 12.5 %) in the language of the person: the separator and the sign of the percent
// follow the locale. It is a label, not an amount of money: the figure is exact to two decimals.
export function usePercent(): (bps: number) => string {
  const locale = useLocale()
  return useCallback(
    (bps: number) =>
      new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(bps / 10_000),
    [locale]
  )
}
