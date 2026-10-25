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

export const invitationSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  inviterName: z.string().min(1),
  storeName: z.string().min(1),
  roleName: z.string().min(1),
  expiresInDays: z.number().int().positive()
})
export type InvitationProps = z.infer<typeof invitationSchema>

export function Invitation({
  url,
  inviterName,
  storeName,
  roleName,
  expiresInDays,
  locale,
  t
}: InvitationProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Text style={heading}>{t('heading', { store: storeName })}</Text>
          <Text style={paragraph}>
            {t('body', { inviter: inviterName, store: storeName, role: roleName })}
          </Text>
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
