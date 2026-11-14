import { Body, Container, Head, Hr, Html, Section, Text } from 'react-email'
import { z } from 'zod'

import { ReportLimits, ReportMetrics } from '@platform/core/analytics'
import type { Locale } from '@platform/core/i18n'
import type { Translator } from '@platform/core/i18n-server'

import { container, footer, heading, hr, main, paragraph } from './styles'

// A scheduled analytics report (TDD_11 §7.4): the totals of the period in the body and the file attached. The file travels with the
// email, because the people who receive it may have no account (the recipients are addresses), and a link to the exports center
// asks for one. Every text here was already written by the worker in the language of the report.
export const scheduledReportSchema = z.object({
  name: z.string().min(1).max(ReportLimits.NAME_MAX_LENGTH),
  storeName: z.string().min(1),
  // Calendar days: the first is in, the last is out
  from: z.iso.date(),
  to: z.iso.date(),
  // The figure of each metric over the period, already written for a person ("3 min 42 s", "1,250")
  // false when the file was too big to travel in the email: it waits in the exports center of the store
  attached: z.boolean().default(true),
  totals: z
    .array(z.object({ label: z.string().min(1), value: z.string().min(1) }))
    .max(ReportMetrics.length)
})
export type ScheduledReportProps = z.infer<typeof scheduledReportSchema>

export function ScheduledReport({
  name,
  storeName,
  from,
  to,
  totals,
  attached,
  locale,
  t
}: ScheduledReportProps & { locale: Locale; t: Translator }): React.JSX.Element {
  return (
    <Html lang={locale}>
      <Head />
      <Body lang={locale} style={main}>
        <Container style={container}>
          <Text style={heading}>{t('heading', { name })}</Text>
          <Text style={paragraph}>{t('period', { store: storeName, from, to })}</Text>
          <Section>
            {totals.map(total => (
              <Text key={total.label} style={paragraph}>
                <strong>{total.label}</strong>
                <br />
                {total.value}
              </Text>
            ))}
          </Section>
          <Text style={paragraph}>{t(attached ? 'attached' : 'notAttached')}</Text>
          <Hr style={hr} />
          <Text style={footer}>{t('footer', { store: storeName })}</Text>
        </Container>
      </Body>
    </Html>
  )
}
