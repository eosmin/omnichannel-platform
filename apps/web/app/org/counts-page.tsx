'use client'

import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type CountView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CountStatus } from '@platform/core/domain'

import { CountCreateDialog } from '../../components/counts/count-create-dialog'
import { CountStatusBadge } from '../../components/counts/count-status-badge'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { useCounts } from '../../lib/counts/use-counts'

const COUNT_PERMISSIONS = [
  ClientPermissions.INVENTORY_MANAGE_COUNTS,
  ClientPermissions.INVENTORY_APPLY_COUNTS
] as const

// Organization → Counts (TDD_16 §7): the physical counts of the organization, newest first. Reading and cancelling take
// inventory:manage_counts or inventory:apply_counts; making a count takes the first (the api checks every call).
export function CountsPage(): ReactElement {
  const { can } = useStore()
  return COUNT_PERMISSIONS.some(permission => can(permission)) ? (
    <Counts />
  ) : (
    <PermissionDenied anyOf={COUNT_PERMISSIONS} />
  )
}

function Counts(): ReactElement {
  const t = useTranslations('counts')
  const { storeId, can } = useStore()
  const [status, setStatus] = useState<CountStatus | null>(null)
  const [creating, setCreating] = useState(false)
  const counts = useCounts(storeId, status)
  const rows = counts.data?.pages.flatMap(page => page.data) ?? []
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {can(ClientPermissions.INVENTORY_MANAGE_COUNTS) ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('new')}
          </Button>
        ) : null}
      </header>
      <div className="flex max-w-xs flex-col gap-1">
        <Label htmlFor="counts-status">{t('filter')}</Label>
        <select
          id="counts-status"
          className={SELECT_CLASS}
          value={status ?? ''}
          onChange={event =>
            setStatus(event.target.value === '' ? null : (event.target.value as CountStatus))
          }
        >
          <option value="">{t('filterAll')}</option>
          {Object.values(CountStatus).map(value => (
            <option key={value} value={value}>
              {t(`status.${value}`)}
            </option>
          ))}
        </select>
      </div>
      {counts.isError ? (
        <LoadFailed error={counts.error} onRetry={() => void counts.refetch()} />
      ) : counts.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          {status === null ? t('empty') : t('emptyFiltered')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {rows.map(count => (
            <CountRow key={count.id} count={count} />
          ))}
        </ul>
      )}
      {counts.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void counts.fetchNextPage()}
          busy={counts.isFetchingNextPage}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      <CountCreateDialog open={creating} onOpenChange={setCreating} />
    </section>
  )
}

function CountRow({ count }: { count: CountView }): ReactElement {
  const t = useTranslations('counts')
  const format = useFormatter()
  return (
    <li>
      <Link
        href={AppPaths.org.count(count.id)}
        className="hover:bg-accent flex flex-col gap-1 px-4 py-3 pointer-coarse:min-h-12"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{count.number}</span>
          <CountStatusBadge status={count.status} />
        </span>
        <span className="text-sm">
          {count.warehouse.code} · {count.warehouse.name}
        </span>
        <span className="text-muted-foreground text-xs">
          {[
            count.storeName === null ? t('scopeAll') : t('scopeStore', { store: count.storeName }),
            format.dateTime(new Date(count.createdAt), { dateStyle: 'medium' })
          ].join(' · ')}
        </span>
      </Link>
    </li>
  )
}
