import { Body, Container, Head, Hr, Html, Link, Section, Text } from 'react-email'
import { z } from 'zod'

import type { Locale } from '@platform/core/i18n'
import type { Translator } from '@platform/core/i18n-server'
import { DigestLinkKinds } from '@platform/core/notifications'

import { container, footer, heading, hr, link, main, paragraph } from './styles'

const itemSchema = z.object({
  storeName: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  // Absolute, or null when the notification points nowhere
  url: z.url({ protocol: /^https?$/ }).nullable(),
  // How many notifications the block stands for; more than one says so under the text
  count: z.number().int().min(1),
  // The text already says how many they are: the line "N notifications like this" is left out
  saysCount: z.boolean().default(false),
  // Where the link goes, which words it: a conversation, the channels, the team, the exports, the app
  linkKind: z.enum(DigestLinkKinds).default(DigestLinkKinds.APP),
  // When it happened (the newest of the block), already written on the clock of the reader. Optional
  // so that a job queued before the time existed still renders.
  at: z.string().min(1).optional()
})

export const notificationDigestSchema = z.object({
  items: z.array(itemSchema).min(1),
  // Notifications that did not fit in the email; they wait in the center
  moreCount: z.number().int().nonnegative(),
  appUrl: z.url({ protocol: /^https?$/ }),
  settingsUrl: z.url({ protocol: /^https?$/ })
})
export type NotificationDigestProps = z.infer<typeof notificationDigestSchema>

export function NotificationDigest({
  items,
  moreCount,
  appUrl,
  settingsUrl,
  locale,
  t
}: NotificationDigestProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>
            {t('heading', {
              count: items.reduce((sum, item) => sum + item.count, 0) + moreCount
            })}
          </Text>
          {items.map((item, index) => (
            <Section key={`${index}-${item.title}`}>
              <Text style={paragraph}>
                <strong>{item.title}</strong>
                <br />
                {item.body}
                <br />
                {item.count > 1 && !item.saysCount ? (
                  <>
                    {item.at === undefined
                      ? t('repeatedNoTime', { count: item.count })
                      : t('repeated', { count: item.count, at: item.at })}
                    <br />
                  </>
                ) : null}
                <span style={footer}>
                  {item.at === undefined
                    ? item.storeName
                    : t('storeAt', { store: item.storeName, at: item.at })}
                </span>
              </Text>
              {item.url === null ? null : (
                <Link style={link} href={item.url}>
                  {t(`open.${item.linkKind}`)}
                </Link>
              )}
            </Section>
          ))}
          {moreCount > 0 ? <Text style={paragraph}>{t('more', { count: moreCount })}</Text> : null}
          <Hr style={hr} />
          <Link style={link} href={appUrl}>
            {t('center')}
          </Link>
          <Text style={footer}>
            {t('settings')}{' '}
            <Link style={link} href={settingsUrl}>
              {t('settingsLink')}
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  )
}
