'use client'

import { ArrowRight, Plus } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type TransferSummaryView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { TransferStatus } from '@platform/core/domain'

import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { NewTransferDialog } from '../../components/transfers/new-transfer-dialog'
import { TransferStatusBadge } from '../../components/transfers/transfer-status-badge'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { type TransferAccess, useTransferAccess } from '../../lib/transfers/use-transfer-access'
import { ALL_FILTER, useTransferList } from '../../lib/transfers/use-transfers'
import { useWarehouses } from '../../lib/warehouses/use-warehouses'

// Organization → Transfers (TDD_16 §4.5, TDD_09 §16): the moves of stock between the warehouses of the organization.
// Opening needs inventory:manage_transfers or inventory:receive_transfers; making a draft needs the first. What each
// transfer shows of its lines is the stores of the person, and the api decides every request.
export function TransfersPage(): ReactElement {
  const access = useTransferAccess()
  if (access === undefined) return <PageLoading />
  return access === null ? (
    <PermissionDenied
      anyOf={[
        ClientPermissions.INVENTORY_MANAGE_TRANSFERS,
        ClientPermissions.INVENTORY_RECEIVE_TRANSFERS
      ]}
    />
  ) : (
    <Transfers access={access} />
  )
}

function Transfers({ access }: { access: TransferAccess }): ReactElement {
  const t = useTranslations('transfers')
  const warehouses = useWarehouses(access.storeId)
  const [status, setStatus] = useState<TransferStatus | typeof ALL_FILTER>(ALL_FILTER)
  const [warehouseId, setWarehouseId] = useState('')
  const [creating, setCreating] = useState(false)
  const list = useTransferList(access.storeId, { status, warehouseId })

  const rows = list.data?.pages.flatMap(page => page.data) ?? []
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {access.manage ? (
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            disabled={warehouses.data === undefined}
          >
            <Plus aria-hidden />
            {t('new.open')}
          </Button>
        ) : null}
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="transfers-status">{t('filters.status')}</Label>
          <select
            id="transfers-status"
            className={SELECT_CLASS}
            value={status}
            onChange={event => setStatus(event.target.value as TransferStatus | typeof ALL_FILTER)}
          >
            <option value={ALL_FILTER}>{t('filters.allStatuses')}</option>
            {Object.values(TransferStatus).map(value => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="transfers-warehouse">{t('filters.warehouse')}</Label>
          <select
            id="transfers-warehouse"
            className={SELECT_CLASS}
            value={warehouseId}
            onChange={event => setWarehouseId(event.target.value)}
          >
            <option value="">{t('filters.allWarehouses')}</option>
            {(warehouses.data ?? []).map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {warehouses.isError ? (
        <LoadFailed error={warehouses.error} onRetry={() => void warehouses.refetch()} />
      ) : null}
      {list.isError ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map(row => (
            <TransferRow key={row.id} row={row} />
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            busy={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('more')}
          </Button>
        </div>
      ) : null}

      {warehouses.data === undefined ? null : (
        <NewTransferDialog
          storeId={access.storeId}
          warehouses={warehouses.data}
          open={creating}
          onOpenChange={setCreating}
        />
      )}
    </section>
  )
}

function TransferRow({ row }: { row: TransferSummaryView }): ReactElement {
  const t = useTranslations('transfers')
  const format = useFormatter()
  return (
    <li>
      <Link
        href={AppPaths.org.transfer(row.id)}
        className="hover:bg-accent flex flex-col gap-1 px-4 py-3 pointer-coarse:min-h-12"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.number}</span>
          <TransferStatusBadge status={row.status} />
        </span>
        <span className="flex flex-wrap items-center gap-1 text-sm">
          <span>{row.fromWarehouse.name}</span>
          <ArrowRight aria-hidden className="text-muted-foreground size-4" />
          <span>{row.toWarehouse.name}</span>
        </span>
        <span className="text-muted-foreground text-xs">
          {t('lineCount', { count: row.lineCount })} ·{' '}
          {format.dateTime(new Date(row.updatedAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      </Link>
    </li>
  )
}
