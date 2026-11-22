import { Body, Container, Head, Hr, Html, Text } from 'react-email'
import { z } from 'zod'

import type { Locale } from '@platform/core/i18n'
import type { Translator } from '@platform/core/i18n-server'

import { container, footer, heading, hr, main, paragraph } from './styles'

// The closing mail of a data request: what was decided and, for an erasure, what the store keeps and why (TDD_05 §10.3: the notice
// states which records were retained and under which legal basis). Counts only, never a value.
export const dsrResultSchema = z.object({
  outcome: z.enum(['completed', 'rejected', 'expired', 'cancelled']),
  requestType: z.enum([
    'access',
    'portability',
    'rectification',
    'erasure',
    'restriction',
    'objection'
  ]),
  retainedOrders: z.number().int().nonnegative().optional()
})
export type DsrResultProps = z.infer<typeof dsrResultSchema>

export function DsrResult({
  outcome,
  requestType,
  retainedOrders,
  locale,
  t
}: DsrResultProps & { locale: Locale; t: Translator }): React.JSX.Element {
  const kept = outcome === 'completed' && requestType === 'erasure' && (retainedOrders ?? 0) > 0
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>{t(`${outcome}.heading`)}</Text>
          <Text style={paragraph}>{t(`${outcome}.body`, { type: t(`types.${requestType}`) })}</Text>
          {kept ? (
            <Text style={paragraph}>{t('retained', { orders: retainedOrders ?? 0 })}</Text>
          ) : null}
          <Hr style={hr} />
          <Text style={footer}>{t('footer')}</Text>
        </Container>
      </Body>
    </Html>
  )
}
