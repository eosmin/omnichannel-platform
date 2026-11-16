'use client'

import { ShieldAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { knownChainReason } from '../../lib/finance/chain-reasons'
import { useFinanceChainStatus } from '../../lib/finance/use-finance-tax'
import { useStore } from '../providers/store-context'

// The weekly check of the chain of the journal (TDD_18 §11) leaves an incident open when it finds the journal altered, and an open
// incident stops every close. This says so where the close is, with what the check found, so a refused close is never a mystery. It reads
// one row, not the journal; a person who may not read the reports sees nothing here and still gets the api's refusal when they close.
export function ChainIncidentNotice(): ReactElement | null {
  const t = useTranslations('finance.chainIncident')
  const tReasons = useTranslations('finance.reports.chain.reasons')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const status = useFinanceChainStatus(storeId, can(ClientPermissions.FINANCE_VIEW_REPORTS))
  const open = status.data?.open ?? null
  // A read that failed is not "no incident": a person who may read it is told, so a refused close is not a mystery
  if (status.isError) {
    return (
      <p
        role="status"
        data-testid="finance-chain-incident-unreadable"
        className="bg-muted/50 rounded-md p-3 text-sm"
      >
        {t('unreadable')}
      </p>
    )
  }
  if (open === null) return null
  const reason = knownChainReason(open.reason)
  return (
    <div
      role="alert"
      data-testid="finance-chain-incident"
      className="border-destructive/40 bg-destructive/5 flex items-start gap-3 rounded-md border p-3 text-sm"
    >
      <ShieldAlert aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t('title')}</p>
        <p>{t('blocksClose')}</p>
        <p data-testid="finance-chain-incident-reason">
          {t('found', { reason: reason === null ? tReasons('unknown') : tReasons(reason) })}
        </p>
        {open.entryNumber === null ? null : (
          <p data-testid="finance-chain-incident-entry">
            {t('atEntry', { number: open.entryNumber })}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {t('seen', {
            checked: open.entriesChecked,
            first: format.dateTime(new Date(open.detectedAt), { dateStyle: 'medium' }),
            last: format.dateTime(new Date(open.lastSeenAt), { dateStyle: 'medium' })
          })}
        </p>
        <p className="text-muted-foreground text-xs">{t('whatToDo')}</p>
      </div>
    </div>
  )
}
