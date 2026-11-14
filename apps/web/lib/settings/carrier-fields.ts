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
