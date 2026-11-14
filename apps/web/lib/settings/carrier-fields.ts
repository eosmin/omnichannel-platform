import type { CarrierConnectFieldView } from '@platform/api-client'

import { fieldHelpOf, fieldLabelOf } from './connect-form'

// The form of a carrier is drawn from what its plugin declares (`connectFields`, the registry's copy). A plugin names a field
// by a message key of this page's own section, so a key aimed at another part of the interface cannot relabel a field.
export const CarrierMessagePrefix = 'settings.carriers.connect.fields.'

export const carrierFieldLabelOf = (
  field: Pick<CarrierConnectFieldView, 'key' | 'labelKey' | 'label'>,
  locale: string,
  message: (key: string) => string | null
): string => fieldLabelOf(field, locale, message, CarrierMessagePrefix)

export const carrierFieldHelpOf = (
  field: Pick<CarrierConnectFieldView, 'helpKey'>,
  message: (key: string) => string | null
): string | null => fieldHelpOf(field, message, CarrierMessagePrefix)

// A rate service names itself the same way, by a message key of the rates section of this page
export const CarrierRateMessagePrefix = 'settings.carriers.rates.'

// The name of a service with a rate of its own: the message the plugin aims at, or else the code of the service
export function carrierRateLabelOf(
  service: { code: string; labelKey: string },
  message: (key: string) => string | null
): string {
  if (service.labelKey.startsWith(CarrierRateMessagePrefix)) {
    const text = message(service.labelKey)
    if (text !== null) return text
  }
  return service.code
}
