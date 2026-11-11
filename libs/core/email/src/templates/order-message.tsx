import { Body, Container, Head, Hr, Html, Text } from 'react-email'
import { z } from 'zod'

import { OrderMessageLimits } from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'
import type { Translator } from '@platform/core/i18n-server'

import { container, footer, heading, hr, main, paragraph } from './styles'

// The generic order email (TDD_17 §4.7): the text of an order message, already rendered, for the customer a channel could
// not reach. It carries no variables of its own: the template of the store wrote the message.
export const orderMessageSchema = z.object({
  storeName: z.string().min(1),
  orderNumber: z.string().min(1),
  // The longest message an order can say: the body, with what its variables add
  text: z
    .string()
    .min(1)
    .max(OrderMessageLimits.VALUE_MAX_LENGTH * 8)
})
export type OrderMessageProps = z.infer<typeof orderMessageSchema>

// Line breaks of the message are kept: a list of items is one line per item
const keepsLineBreaks = { ...paragraph, whiteSpace: 'pre-line' } as const

export function OrderMessage({
  storeName,
  orderNumber,
  text,
  locale,
  t
}: OrderMessageProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>{t('heading', { order: orderNumber })}</Text>
          <Text style={keepsLineBreaks}>{text}</Text>
          <Hr style={hr} />
          <Text style={footer}>{t('footer', { store: storeName })}</Text>
        </Container>
      </Body>
    </Html>
  )
}
