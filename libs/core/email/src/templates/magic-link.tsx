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

export const magicLinkSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  expiresInMinutes: z.number().int().positive()
})
export type MagicLinkProps = z.infer<typeof magicLinkSchema>

export function MagicLink({
  url,
  expiresInMinutes,
  locale,
  t
}: MagicLinkProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Text style={heading}>{t('heading')}</Text>
          <Text style={paragraph}>{t('body')}</Text>
          <Section style={buttonContainer}>
            <Button style={button} href={url}>
              {t('cta')}
            </Button>
          </Section>
          <Text style={paragraph}>{t('fallback')}</Text>
          <Text style={link}>{url}</Text>
          <Hr style={hr} />
          <Text style={footer}>{t('expiry', { minutes: expiresInMinutes })}</Text>
          <Text style={footer}>{t('ignore')}</Text>
        </Container>
      </Body>
    </Html>
  )
}
