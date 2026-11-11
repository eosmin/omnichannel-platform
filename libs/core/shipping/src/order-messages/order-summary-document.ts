import { createElement, type ReactElement } from 'react'

import type { Locale } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'

import {
  formatAddress,
  formatItemLine,
  formatLongDate,
  formatMoney,
  type OrderMessageSource
} from './message-values'

const FONT_REGULAR = 'Helvetica'
const FONT_BOLD = 'Helvetica-Bold'
const PAGE_PADDING_PT = 40
const TITLE_SIZE_PT = 18
const TEXT_SIZE_PT = 11
const GAP_PT = 6

export interface SummaryLine {
  label: string
  value: string
}

// What the document says, in order, as label and value pairs: the same list is what the PDF draws, so a test can read it
// without opening a file. Rows the order has no value for (no address, no date, not cash on delivery) are left out.
export function orderSummaryLines(source: OrderMessageSource, locale: Locale): SummaryLine[] {
  const t = createTranslator(locale, 'email.orderMessage.summary')
  const lines: SummaryLine[] = [{ label: t('order'), value: source.orderNumber }]
  if (source.customerName !== null && source.customerName.trim() !== '') {
    lines.push({ label: t('customer'), value: source.customerName })
  }
  // The label of the list is written once, on its first row
  lines.push(
    ...source.items.map((item, index) => ({
      label: index === 0 ? t('items') : '',
      value: formatItemLine(item, source.currency, locale)
    }))
  )
  lines.push({ label: t('total'), value: formatMoney(source.totalCents, source.currency, locale) })
  if (source.codAmountCents !== null) {
    lines.push({
      label: t('codAmount'),
      value: formatMoney(source.codAmountCents, source.currency, locale)
    })
  }
  if (source.shippingAddress !== null) {
    lines.push({ label: t('address'), value: formatAddress(source.shippingAddress) })
  }
  if (source.scheduledDeliveryDate !== null) {
    lines.push({
      label: t('deliveryDate'),
      value: formatLongDate(source.scheduledDeliveryDate, locale)
    })
  }
  return lines
}

// The order summary the customer can receive with the summary message (TDD_17 §4.7, TDD_09 §5.4): one A4 page in the language
// of the template, drawn with the standard faces every reader has. Pure but for the renderer.
export async function renderOrderSummaryPdf(
  source: OrderMessageSource,
  locale: Locale
): Promise<Uint8Array> {
  const t = createTranslator(locale, 'email.orderMessage.summary')
  // The package is ESM only, and it is loaded the first time a document is drawn
  const pdf = await import('@react-pdf/renderer')
  const rows: ReactElement[] = orderSummaryLines(source, locale).map((line, index) =>
    createElement(
      pdf.View,
      { key: index, style: { flexDirection: 'row', marginBottom: GAP_PT } },
      createElement(
        pdf.Text,
        { style: { width: '35%', fontFamily: FONT_BOLD, fontSize: TEXT_SIZE_PT } },
        line.label
      ),
      createElement(
        pdf.Text,
        { style: { width: '65%', fontFamily: FONT_REGULAR, fontSize: TEXT_SIZE_PT } },
        line.value
      )
    )
  )
  const page = createElement(
    pdf.Page,
    { size: 'A4', style: { padding: PAGE_PADDING_PT } },
    createElement(
      pdf.Text,
      {
        style: {
          fontFamily: FONT_BOLD,
          fontSize: TITLE_SIZE_PT,
          marginBottom: GAP_PT * 2
        }
      },
      `${t('title')} · ${source.storeName}`
    ),
    ...rows
  )
  const buffer = await pdf.renderToBuffer(createElement(pdf.Document, null, page))
  return new Uint8Array(buffer)
}
