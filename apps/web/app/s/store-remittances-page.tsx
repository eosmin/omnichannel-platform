'use client'

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { AppPaths, type RemittanceView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { RemittanceStatus } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { PendingPanel } from '../../components/remittances/pending-panel'
import { RemittanceStatusText } from '../../components/remittances/remittance-badges'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button, buttonVariants } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { formatCents } from '../../lib/products/money'
import {
  type RemittanceListFilter,
  useRemittanceConnections,
  useRemittances
} from '../../lib/remittances/use-remittances'

const ALL = ''
const NONE: readonly never[] = []

function Row({ remittance }: { remittance: RemittanceView }): ReactElement {
  const t = useTranslations('remittances.list')
  const format = useFormatter()
  const { storeId } = useStore()
  const made = new Date(remittance.createdAt)
  const label = remittance.reference ?? t('noReference')
  const difference = remittance.totals.differenceCents
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        <Link
          href={AppPaths.store.remittance(storeId, remittance.id)}
          className="underline-offset-2 hover:underline"
          aria-label={t('openRemittance', { name: label })}
        >
          {label}
        </Link>
      </td>
      <td className="py-2 pr-3 text-sm">{remittance.connectionName}</td>
      <td className="py-2 pr-3 text-sm">
        <RemittanceStatusText status={remittance.status} />
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm whitespace-nowrap">
        {Number.isNaN(made.getTime()) ? '' : format.dateTime(made, { dateStyle: 'medium' })}
      </td>
      <td className="py-2 pr-3 text-right text-sm">{remittance.lineCount}</td>
      <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
        {formatCents(format, remittance.totals.expectedCents)}
      </td>
      <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
        {formatCents(format, remittance.totals.reportedCents)}
      </td>
      <td
        className={
          difference === 0
            ? 'py-2 text-right text-sm whitespace-nowrap'
            : 'text-destructive py-2 text-right text-sm whitespace-nowrap'
        }
      >
        {formatCents(format, difference)}
      </td>
    </tr>
  )
}

function History(): ReactElement {
  const t = useTranslations('remittances.list')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const [status, setStatus] = useState(ALL)
  const [connectionId, setConnectionId] = useState(ALL)
  const connections = useRemittanceConnections(storeId, can(ClientPermissions.SHIPPING_VIEW))
  const filter = useMemo<RemittanceListFilter>(
    () => ({
      status: status === ALL ? null : (status as RemittanceStatus),
      connectionId: connectionId === ALL ? null : connectionId
    }),
    [status, connectionId]
  )
  const list = useRemittances(storeId, filter, true)
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.data) ?? NONE, [list.data])
  const isFiltered = filter.status !== null || filter.connectionId !== null
  return (
    <section aria-labelledby="remittances-history-title" className="flex flex-col gap-3">
      <h2 id="remittances-history-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="remittances-status">{t('filters.status')}</Label>
          <select
            id="remittances-status"
            className={SELECT_CLASS}
            value={status}
            onChange={event => setStatus(event.target.value)}
          >
            <option value={ALL}>{t('filters.anyStatus')}</option>
            {Object.values(RemittanceStatus).map(value => (
              <option key={value} value={value}>
                {tAll(`remittances.status.${value}`)}
              </option>
            ))}
          </select>
        </div>
        {connections.data === undefined ? null : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="remittances-carrier">{t('filters.carrier')}</Label>
            <select
              id="remittances-carrier"
              className={SELECT_CLASS}
              value={connectionId}
              onChange={event => setConnectionId(event.target.value)}
            >
              <option value={ALL}>{t('filters.anyCarrier')}</option>
              {connections.data.map(connection => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {list.isError ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 && !list.isPlaceholderData ? (
        <p className="text-muted-foreground text-sm">
          {isFiltered ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <div
          className={list.isPlaceholderData ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}
          aria-busy={list.isPlaceholderData}
        >
          <table className="w-full text-left">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="border-b text-sm">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.reference')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.carrier')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.status')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.created')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('columns.lines')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('columns.expected')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('columns.reported')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('columns.difference')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(remittance => (
                <Row key={remittance.id} remittance={remittance} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </section>
  )
}

// The cash that carriers collect on delivery and the settlements that bring it (TDD_17 §4.15): what is still owed, and the
// remittances, drafts included. Opening asks for remittances:view; what changes a remittance is on its own page.
export function StoreRemittancesPage(): ReactElement {
  const t = useTranslations('remittances.list')
  const { storeId, can } = useStore()
  if (!can(ClientPermissions.REMITTANCES_VIEW)) {
    return <PermissionDenied permission={ClientPermissions.REMITTANCES_VIEW} />
  }
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {can(ClientPermissions.REMITTANCES_MANAGE) && can(ClientPermissions.SHIPPING_VIEW) ? (
          <Link
            href={AppPaths.store.remittanceImport(storeId)}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('importAction')}
          </Link>
        ) : null}
      </header>
      <PendingPanel />
      <History />
    </div>
  )
}
