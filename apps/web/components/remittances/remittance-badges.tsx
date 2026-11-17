import { AlertTriangle, Check, CircleSlash, FileEdit, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { RemittanceLineOutcome, RemittanceStatus } from '@platform/core/domain'

import { type OutcomeTone, outcomeTone } from '../../lib/remittances/remittance-rules'
import { cn } from '../../lib/utils'

const TONE_CLASS: Record<OutcomeTone, string> = {
  ok: 'text-foreground',
  warning: 'text-amber-700 dark:text-amber-400',
  problem: 'text-destructive'
}

const TONE_ICON = { ok: Check, warning: AlertTriangle, problem: X } as const

// The state of a remittance, in words and with an icon (never colour alone)
export function RemittanceStatusText({ status }: { status: RemittanceStatus }): ReactElement {
  const t = useTranslations('remittances.status')
  const Icon =
    status === RemittanceStatus.DRAFT
      ? FileEdit
      : status === RemittanceStatus.CONFIRMED
        ? Check
        : CircleSlash
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <Icon aria-hidden className="size-4" />
      {t(status)}
    </span>
  )
}

// The result of matching one line against the shipments of the store: what the agent must read before confirming
// `feeConsumesCash`: the line matches because the fee of the carrier takes all the cash (what was expected is zero), which is
// worth saying next to the warning so that "matches" is not read as "paid in full"
export function LineOutcomeText({
  outcome,
  feeConsumesCash = false
}: {
  outcome: RemittanceLineOutcome
  feeConsumesCash?: boolean
}): ReactElement {
  const t = useTranslations('remittances.outcome')
  const tone = outcomeTone(outcome)
  const Icon = TONE_ICON[tone]
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', TONE_CLASS[tone])}>
      <Icon aria-hidden className="size-4" />
      {feeConsumesCash && outcome === RemittanceLineOutcome.MATCHED
        ? t('matchedFeeConsumesCash')
        : t(outcome)}
    </span>
  )
}
