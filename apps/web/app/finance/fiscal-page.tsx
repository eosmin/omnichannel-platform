'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { AppPaths, type FiscalDocumentView } from '@platform/api-client'
import { FiscalDocumentStatus } from '@platform/core/domain'

import { AttentionBanner } from '../../components/fiscal/attention-banner'
import { DocumentDetailDialog } from '../../components/fiscal/document-detail-dialog'
import { FiscalGate } from '../../components/fiscal/fiscal-gate'
import { FiscalStatusBadge } from '../../components/fiscal/fiscal-status-badge'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useMoney } from '../../lib/finance/use-money'
import { fiscalAttentionOf, replacedIdsOf } from '../../lib/fiscal/document-rules'
import { type PeriodDraft, periodFiltersOf, periodProblem } from '../../lib/fiscal/period-filter'
import {
  useFiscalDocuments,
  useFiscalIssuer,
  useFiscalProviders
} from '../../lib/fiscal/use-fiscal'

// Finance → Fiscal documents (TDD_18 §8): the documents of the organization's sales and of its returns, with the state each is in. They
// are made by themselves when the sale is recognized (the issuer chooses the moment), so there is no button to make one here: a person
// follows them, fixes a receiver, sends one again, voids an accepted one and makes a voided sale document again.
export function FiscalPage(): ReactElement {
  return <FiscalGate>{() => <Fiscal />}</FiscalGate>
}

function Fiscal(): ReactElement {
  const t = useTranslations('finance.fiscal')
  const { storeId } = useStore()
  const ids = useId()
  const [status, setStatus] = useState<FiscalDocumentStatus | ''>('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [period, setPeriod] = useState<PeriodDraft>({ from: '', to: '' })
  // The days as they were last asked: a period that is wrong is told and not asked, so the list keeps the last good one until the days are right
  const [periodFilters, setPeriodFilters] = useState<ReturnType<typeof periodFiltersOf>>({})
  const problem = periodProblem(period)
  const editPeriod = (next: PeriodDraft): void => {
    setPeriod(next)
    if (periodProblem(next) === null) setPeriodFilters(periodFiltersOf(next))
  }
  const providers = useFiscalProviders(storeId, true)
  const issuer = useFiscalIssuer(storeId, true)
  const documents = useFiscalDocuments(
    storeId,
    { ...(status === '' ? {} : { status }), ...periodFilters },
    true
  )
  const rows = useMemo(
    () => documents.data?.pages.flatMap(page => page.data) ?? [],
    [documents.data]
  )
  const replacedIds = useMemo(() => replacedIdsOf(rows), [rows])
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <p
        className="text-muted-foreground bg-muted/50 rounded-md border p-3 text-xs"
        data-testid="fiscal-caution"
      >
        {t('caution')}
      </p>
      {issuer.data === null ? (
        <p className="rounded-md border p-3 text-sm" data-testid="fiscal-no-issuer">
          {t('noIssuer')}{' '}
          <Link
            href={AppPaths.finance.fiscalIssuer}
            className="text-primary inline-flex items-center underline underline-offset-2 pointer-coarse:min-h-11"
          >
            {t('noIssuerLink')}
          </Link>
        </p>
      ) : null}
      <AttentionBanner
        onShowRejected={() => setStatus(FiscalDocumentStatus.REJECTED)}
        onShowStuck={() => setStatus(FiscalDocumentStatus.QUEUED)}
      />
      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor={`${ids}-status`}>{t('filters.status')}</Label>
        <select
          id={`${ids}-status`}
          className={SELECT_CLASS}
          value={status}
          onChange={event => setStatus(event.target.value as FiscalDocumentStatus | '')}
        >
          <option value="">{t('filters.allStatuses')}</option>
          {Object.values(FiscalDocumentStatus).map(value => (
            <option key={value} value={value}>
              {t(`status.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap items-end gap-3" data-testid="fiscal-period">
        <legend className="sr-only">{t('filters.period')}</legend>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-from`}>{t('filters.from')}</Label>
          <Input
            id={`${ids}-from`}
            type="date"
            value={period.from}
            onChange={event => editPeriod({ ...period, from: event.target.value })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-to`}>{t('filters.to')}</Label>
          <Input
            id={`${ids}-to`}
            type="date"
            value={period.to}
            onChange={event => editPeriod({ ...period, to: event.target.value })}
          />
        </div>
        {period.from === '' && period.to === '' ? null : (
          <Button variant="outline" size="sm" onClick={() => editPeriod({ from: '', to: '' })}>
            {t('filters.clear')}
          </Button>
        )}
      </fieldset>
      {problem === null ? null : (
        <p role="alert" className="text-destructive text-sm" data-testid="fiscal-period-problem">
          {t(`filters.problems.${problem}`)}
        </p>
      )}
      {documents.isError && documents.data === undefined ? (
        <LoadFailed error={documents.error} onRetry={() => void documents.refetch()} />
      ) : documents.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="fiscal-empty">
          {status === '' && Object.keys(periodFilters).length === 0
            ? t('empty')
            : t('emptyFiltered')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="fiscal-documents">
          {rows.map(document => (
            <DocumentRow
              key={document.id}
              document={document}
              onOpen={() => setOpenId(document.id)}
            />
          ))}
        </ul>
      )}
      {documents.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={documents.isFetchingNextPage}
            onClick={() => void documents.fetchNextPage()}
          >
            {t('more')}
          </Button>
        </div>
      ) : null}
      <DocumentDetailDialog
        documentId={openId}
        providers={providers.data ?? []}
        replacedIds={replacedIds}
        onOpenChange={open => {
          if (!open) setOpenId(null)
        }}
      />
    </section>
  )
}

function DocumentRow({
  document,
  onOpen
}: {
  document: FiscalDocumentView
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal')
  const format = useFormatter()
  const money = useMoney()
  const attention = fiscalAttentionOf(document)
  return (
    <li
      data-testid="fiscal-document-row"
      data-number={String(document.sequenceNumber)}
      data-status={document.status}
    >
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-muted/50 flex w-full flex-col gap-2 px-4 py-3 text-left sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {t('row.number', { number: document.sequenceNumber })}
            </span>
            <FiscalStatusBadge status={document.status} />
            <span className="text-muted-foreground text-xs">{t(`kind.${document.kind}`)}</span>
            {attention === null ? null : (
              <span className="text-destructive text-xs font-medium">
                {t(`row.attention.${attention}`)}
              </span>
            )}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {document.receiver.name ?? t('row.noReceiver')} ·{' '}
            {format.dateTime(new Date(document.createdAt), { dateStyle: 'medium' })}
          </span>
        </span>
        <span className="font-medium">{money(document.totalCents)}</span>
      </button>
    </li>
  )
}
