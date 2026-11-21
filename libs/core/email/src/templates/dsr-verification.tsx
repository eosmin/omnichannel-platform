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

// The mail that asks the person to confirm a data request (TDD_05 §10.2). The link carries the token in its fragment.
export const dsrVerificationSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresInDays: z.number().int().positive(),
  requestType: z.enum([
    'access',
    'portability',
    'rectification',
    'erasure',
    'restriction',
    'objection'
  ])
})
export type DsrVerificationProps = z.infer<typeof dsrVerificationSchema>

export function DsrVerification({
  url,
  expiresInDays,
  requestType,
  locale,
  t
}: DsrVerificationProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>{t('heading')}</Text>
          <Text style={paragraph}>{t('body', { type: t(`types.${requestType}`) })}</Text>
          <Section style={buttonContainer}>
            <Button style={button} href={url}>
              {t('cta')}
            </Button>
          </Section>
          <Text style={paragraph}>{t('fallback')}</Text>
          <Text style={link}>{url}</Text>
          <Hr style={hr} />
          <Text style={footer}>{t('expiry', { days: expiresInDays })}</Text>
          <Text style={footer}>{t('ignore')}</Text>
        </Container>
      </Body>
    </Html>
  )
}
