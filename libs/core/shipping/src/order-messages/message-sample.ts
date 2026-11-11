import type { Locale } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'

import {
  assertKnownVariables,
  type OrderMessageValues,
  renderOrderMessage,
  variablesNeededBy
} from './message-template'
import { buildOrderMessageValues, type OrderMessageSource } from './message-values'

const SAMPLE_CURRENCY = 'USD'
// A calendar day that is the same everywhere (the value of an order has no time of day)
const SAMPLE_DELIVERY_DAY = new Date(Date.UTC(2026, 9, 28))
const SAMPLE_TRACKING_NUMBER = 'GU-0001234'
const SAMPLE_TRACKING_URL = 'https://example.com/track/GU-0001234'
const SAMPLE_ORDER_NUMBER = 'ORD-1042'
const SAMPLE_COUNTRY = 'SV'
const SAMPLE_ATTEMPTS = { failed: 2, max: 3 } as const

// The order the editor of a template fills in to show how a message will read: invented, in the language of the template,
// with every variable a value so that the preview shows the whole message (what an order lacks is the send's business)
export function sampleOrderMessageSource(locale: Locale): OrderMessageSource {
  const t = createTranslator(locale, 'email.orderMessage.sample')
  return {
    customerName: t('customerName'),
    orderNumber: SAMPLE_ORDER_NUMBER,
    items: [
      {
        name: t('itemOne'),
        variantLabel: t('variantOne'),
        quantity: 1,
        unitPriceCents: 4500
      },
      { name: t('itemTwo'), variantLabel: null, quantity: 2, unitPriceCents: 750 }
    ],
    totalCents: 6000,
    currency: SAMPLE_CURRENCY,
    shippingAddress: {
      line1: t('addressLine'),
      city: t('city'),
      country: SAMPLE_COUNTRY
    },
    carrierName: t('carrierName'),
    trackingNumber: SAMPLE_TRACKING_NUMBER,
    trackingUrl: SAMPLE_TRACKING_URL,
    storeName: t('storeName'),
    codAmountCents: 6000,
    failedAttempts: SAMPLE_ATTEMPTS.failed,
    maxAttempts: SAMPLE_ATTEMPTS.max,
    scheduledDeliveryDate: SAMPLE_DELIVERY_DAY
  }
}

export function sampleOrderMessageValues(locale: Locale): OrderMessageValues {
  return buildOrderMessageValues(sampleOrderMessageSource(locale), locale)
}

export interface OrderMessagePreview {
  text: string
  // The variables the template uses, so the editor can list them
  variables: string[]
}

// The body being edited, rendered with the sample order. A body with a variable that does not exist is refused as it would
// be when saved, so the preview never shows what cannot be stored.
export function previewOrderMessage(body: string, locale: Locale): OrderMessagePreview {
  assertKnownVariables(body)
  const rendered = renderOrderMessage(body, sampleOrderMessageValues(locale))
  // The sample has a value for every variable of the allowlist, so a body that passed the check always renders
  if (!rendered.ok) throw new Error('the sample order lacks a variable of the allowlist')
  return { text: rendered.text, variables: variablesNeededBy(body) }
}
