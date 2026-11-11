import type { Locale } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'
import type { LabelTexts } from '@platform/plugins/sdk'

// The words a label prints, in the language of the store (the plugin only places them, TDD_17 §4.2). The keys are
// `shipping.label.*` in the message files; a missing one throws, so a label is never printed with a hole in it.
export function labelTextsFor(locale: Locale): LabelTexts {
  const t = createTranslator(locale, 'shipping.label')
  return {
    from: t('from'),
    to: t('to'),
    collect: t('collect'),
    paid: t('paid'),
    order: t('order'),
    packages: t('packages'),
    service: t('service'),
    notes: t('notes')
  }
}
