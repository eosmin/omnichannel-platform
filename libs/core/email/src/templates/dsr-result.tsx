import { Body, Button, Container, Head, Hr, Html, Section, Text } from 'react-email'
import { z } from 'zod'

import type { Locale } from '@platform/core/i18n'
import type { Translator } from '@platform/core/i18n-server'

import {
  button,
  buttonContainer,
  container,
  footer,
  heading,
  hr,
  link,
  main,
  paragraph
} from './styles'

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
  retainedOrders: z.number().int().nonnegative().optional(),
  // The page that hands over the file of an access or portability request: a link that works once (Step 7.2-H2b-3)
  downloadUrl: z.url({ protocol: /^https?$/ }).optional()
})
export type DsrResultProps = z.infer<typeof dsrResultSchema>

export function DsrResult({
  outcome,
  requestType,
  retainedOrders,
  downloadUrl,
  locale,
  t
}: DsrResultProps & { locale: Locale; t: Translator }): React.JSX.Element {
  const kept = outcome === 'completed' && requestType === 'erasure' && (retainedOrders ?? 0) > 0
  // The file of an export never travels in the mail: a link to the page that hands it over does, and a store with no link says it will hand it over
  // by a safe way (Step 7.2-H2b-2, H2b-3)
  const delivered =
    outcome === 'completed' && (requestType === 'access' || requestType === 'portability')
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>{t(`${outcome}.heading`)}</Text>
          <Text style={paragraph}>{t(`${outcome}.body`, { type: t(`types.${requestType}`) })}</Text>
          {delivered && downloadUrl !== undefined ? (
            <>
              <Text style={paragraph}>{t('exportLink')}</Text>
              <Section style={buttonContainer}>
                <Button style={button} href={downloadUrl}>
                  {t('exportLinkLabel')}
                </Button>
              </Section>
              <Text style={link}>{downloadUrl}</Text>
              <Text style={paragraph}>{t('exportLinkOnce')}</Text>
            </>
          ) : null}
          {delivered && downloadUrl === undefined ? (
            <Text style={paragraph}>{t('exportDelivery')}</Text>
          ) : null}
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
