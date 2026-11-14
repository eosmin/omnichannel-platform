import {
  metricMessageKey,
  MetricUnits,
  type ReportMetric,
  RolledUpMetricUnits
} from '@platform/core/analytics'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'

import type { SheetTexts } from './sheet'

const NAMESPACE = 'email.scheduledReport'

// The language of a file is the one of the person it is made for. A stored value that is no supported language reads the default.
export function localeOf(value: string | null | undefined): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}

// The words of a sheet and of the email of a report, from the message files of the web app (the emails share them)
export function reportTexts(
  locale: Locale,
  options: { name?: string; from: string; to: string }
): SheetTexts & { metricLabel: (metric: ReportMetric) => string } {
  const t = createTranslator(locale, NAMESPACE)
  const metricLabel = (metric: ReportMetric): string => t(`metrics.${metricMessageKey(metric)}`)
  return {
    title: options.name ?? t('defaultTitle'),
    subtitle: t('periodLine', { from: options.from, to: options.to }),
    dayHeader: t('dayHeader'),
    totalLabel: t('totalLabel'),
    metricLabel,
    header: metric => {
      const unit = RolledUpMetricUnits[metric]
      if (unit === MetricUnits.SECONDS) return `${metricLabel(metric)} (${t('unitSeconds')})`
      if (unit === MetricUnits.CENTS) return `${metricLabel(metric)} (${t('unitCents')})`
      return metricLabel(metric)
    }
  }
}
