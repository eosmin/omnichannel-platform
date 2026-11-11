import type { Locale } from '@platform/core/i18n'
import { createTranslator, hasTranslation } from '@platform/core/i18n-server'
import type { CarrierPlugin } from '@platform/plugins/sdk'

// What a store reads of a carrier, in its language. The plugin gives its own words in English (like every carrier's own
// words); a key `shipping.carriers.<id>.name` or `.services.<code>` in the message files overrides them, so the official
// carriers speak the language of the store and a private plugin keeps what it declared (rule 6).

export function carrierNameOf(plugin: Pick<CarrierPlugin, 'id' | 'name'>, locale: Locale): string {
  const key = `shipping.carriers.${plugin.id}.name`
  // A dot in an id would walk into the keys of another carrier: only ids with none are translated
  return !plugin.id.includes('.') && hasTranslation(locale, key)
    ? createTranslator(locale, 'shipping.carriers')(`${plugin.id}.name`)
    : plugin.name
}

export function carrierServiceLabelOf(
  carrierId: string,
  service: { code: string; label: string },
  locale: Locale
): string {
  const key = `shipping.carriers.${carrierId}.services.${service.code}`
  return !carrierId.includes('.') && !service.code.includes('.') && hasTranslation(locale, key)
    ? createTranslator(locale, 'shipping.carriers')(`${carrierId}.services.${service.code}`)
    : service.label
}
