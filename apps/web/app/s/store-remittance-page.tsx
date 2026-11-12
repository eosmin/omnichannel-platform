'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, fetchMediaUrls, type RemittanceDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { RemittanceStatus } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import {
  ConfirmPanel,
  DiscardButton,
  VoidPanel
} from '../../components/remittances/remittance-actions'
import { RemittanceStatusText } from '../../components/remittances/remittance-badges'
import { RemittanceLines } from '../../components/remittances/remittance-lines'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'
import { formatCents } from '../../lib/products/money'
import { isDraft } from '../../lib/remittances/remittance-rules'
import { useRemittance } from '../../lib/remittances/use-remittances'

function Figure({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-base font-semibold">{value}</dd>
    </div>
  )
}

// The file the draft was imported from, as a signed link asked for when the person presses. A file that the scan refused is gone
// from the bucket: the api says so, and the page says it too instead of offering a link that does nothing.
function SourceFile({ mediaId }: { mediaId: string }): ReactElement {
  const t = useTranslations('remittances.detail')
  const { storeId } = useStore()
  const [state, setState] = useState<'idle' | 'busy' | 'gone'>('idle')
  const open = async (): Promise<void> => {
    setState('busy')
    try {
      const urls = await fetchMediaUrls(apiClient, storeId, mediaId)
      window.open(urls.url, '_blank', 'noopener,noreferrer')
      setState('idle')
    } catch {
      setState('gone')
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={state === 'busy'}
        onClick={() => void open()}
      >
        {t('openFile')}
      </Button>
      {state === 'gone' ? (
        <p role="alert" className="text-destructive text-sm">
          {t('fileGone')}
        </p>
      ) : null}
    </div>
  )
}

function Detail({ remittance }: { remittance: RemittanceDetailView }): ReactElement {
  const t = useTranslations('remittances.detail')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.REMITTANCES_MANAGE)
  const draft = isDraft(remittance)
  const day = (value: string | null): string | null => {
    if (value === null) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : format.dateTime(date, { dateStyle: 'medium' })
  }
  const received = day(remittance.receivedOn)
  const confirmed = day(remittance.confirmedAt)
  const voided = day(remittance.voidedAt)
  return (
    <div className="flex flex-col gap-5">
      <Link
        href={AppPaths.store.remittances(storeId)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm pointer-coarse:min-h-10"
      >
        <ArrowLeft aria-hidden className="size-4" />
        {t('back')}
      </Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{remittance.reference ?? t('noReference')}</h1>
          <RemittanceStatusText status={remittance.status} />
          {draft && canManage ? <DiscardButton remittance={remittance} /> : null}
        </div>
        <p className="text-muted-foreground text-sm">
          {remittance.connectionName}
          {received === null ? '' : ` · ${t('receivedOn', { date: received })}`}
          {confirmed === null ? '' : ` · ${t('confirmedOn', { date: confirmed })}`}
        </p>
        {remittance.status === RemittanceStatus.VOIDED ? (
          <p role="status" className="text-sm">
            {t('voidedOn', { date: voided ?? '' })}
            {remittance.voidReason === null ? '' : ` · ${remittance.voidReason}`}
          </p>
        ) : null}
        {remittance.note === null ? null : <p className="text-sm">{remittance.note}</p>}
        {remittance.sourceMediaId === null ? null : (
          <SourceFile mediaId={remittance.sourceMediaId} />
        )}
      </header>
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        <Figure
          label={t('totals.expected')}
          value={formatCents(format, remittance.totals.expectedCents)}
        />
        <Figure
          label={t('totals.reported')}
          value={formatCents(format, remittance.totals.reportedCents)}
        />
        <Figure label={t('totals.fee')} value={formatCents(format, remittance.totals.feeCents)} />
        <Figure
          label={t('totals.difference')}
          value={formatCents(format, remittance.totals.differenceCents)}
        />
      </dl>
      {draft ? <p className="text-muted-foreground text-sm">{t('draftNote')}</p> : null}
      <RemittanceLines
        remittanceId={remittance.id}
        lines={remittance.lines}
        canEdit={draft && canManage}
      />
      {draft && canManage ? <ConfirmPanel remittance={remittance} /> : null}
      {remittance.status === RemittanceStatus.CONFIRMED && canManage ? (
        <VoidPanel remittance={remittance} />
      ) : null}
    </div>
  )
}

// One remittance (TDD_17 §4.15): its lines with the result of matching each, the corrections of a draft, and the two moves that
// change money records: confirming a draft and voiding a confirmed remittance. Opening asks for remittances:view; the moves ask
// for remittances:manage and are not drawn without it.
export function StoreRemittancePage(): ReactElement {
  const { storeId, can } = useStore()
  const { remittanceId = '' } = useParams<{ remittanceId?: string }>()
  const canView = can(ClientPermissions.REMITTANCES_VIEW)
  const query = useRemittance(storeId, remittanceId, canView)
  if (!canView) return <PermissionDenied permission={ClientPermissions.REMITTANCES_VIEW} />
  if (query.isError) return <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
  if (query.data === undefined) return <PageLoading />
  return <Detail remittance={query.data} />
}
