'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { CarrierConnectionView, StatusMappingView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CarrierReportableStatuses, CarrierStatusMappingSource } from '@platform/core/domain'

import {
  usePutStatusMapping,
  useRemoveStatusMapping,
  useStatusMappings,
  useUnmappedStatuses
} from '../../lib/settings/use-carriers'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { LoadFailed, PageLoading } from './states'

// The value of the select that ignores a code on purpose
const IGNORE = 'ignore'

// Settings → Carriers → Status mapping (TDD_17 §4.17): the codes a carrier sends against our shipment statuses, and the
// codes nobody mapped yet, which wait with their shipments until the owner decides. Reading needs shipping:view and
// changing a row settings:manage_carriers. Only a status a carrier can report is a target.
export function CarrierStatusMapping({
  connection
}: {
  connection: CarrierConnectionView
}): ReactElement {
  const t = useTranslations('settings.carriers.mapping')
  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <WaitingCodes connection={connection} />
      <MappingTable connection={connection} />
    </div>
  )
}

function StatusSelect({
  id,
  value,
  onChange,
  disabled,
  withIgnore = true,
  placeholder
}: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
  withIgnore?: boolean
  placeholder?: string
}): ReactElement {
  const t = useTranslations('settings.carriers.mapping')
  return (
    <select
      id={id}
      value={value}
      onChange={event => onChange(event.target.value)}
      disabled={disabled}
      className="border-input bg-background h-9 rounded-md border px-2 text-sm"
    >
      {placeholder === undefined ? null : <option value="">{placeholder}</option>}
      {CarrierReportableStatuses.map(status => (
        <option key={status} value={status}>
          {t(`statuses.${status}` as 'statuses.delivered')}
        </option>
      ))}
      {withIgnore ? <option value={IGNORE}>{t('ignore')}</option> : null}
    </select>
  )
}

function WaitingCodes({ connection }: { connection: CarrierConnectionView }): ReactElement {
  const t = useTranslations('settings.carriers.mapping.waiting')
  const { storeId } = useStore()
  const unmapped = useUnmappedStatuses(storeId, connection.id)
  if (unmapped.isError) {
    return <LoadFailed error={unmapped.error} onRetry={() => void unmapped.refetch()} />
  }
  if (unmapped.data === undefined) return <PageLoading />
  const rows = unmapped.data.pages.flatMap(page => page.data)
  return (
    <section aria-labelledby={`${connection.id}-waiting`} className="flex flex-col gap-2">
      <h3 id={`${connection.id}-waiting`} className="text-base font-semibold">
        {t('title')}
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(row => (
            <WaitingRow key={row.providerCode} connection={connection} row={row} />
          ))}
        </ul>
      )}
      {unmapped.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            busy={unmapped.isFetchingNextPage}
            onClick={() => void unmapped.fetchNextPage()}
          >
            {t('more')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function WaitingRow({
  connection,
  row
}: {
  connection: CarrierConnectionView
  row: {
    providerCode: string
    sampleRawStatus: string
    occurrences: number
    shipmentsWaiting: number
    lastSeenAt: string
  }
}): ReactElement {
  const t = useTranslations('settings.carriers.mapping.waiting')
  const format = useFormatter()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const put = usePutStatusMapping(storeId, connection.id)
  const id = useId()
  const [target, setTarget] = useState('')
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_CARRIERS)

  const apply = (): void => {
    if (target === '') return
    put.mutate(
      { providerCode: row.providerCode, status: target === IGNORE ? null : target },
      {
        onSuccess: () => toast.success(t('mapped', { code: row.providerCode })),
        onError: error => toast.error(errorText(error))
      }
    )
  }

  return (
    <li
      data-testid="unmapped-status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm break-all">{row.sampleRawStatus}</span>
        <span className="text-muted-foreground text-xs">
          {t('seen', {
            count: row.occurrences,
            date: format.dateTime(new Date(row.lastSeenAt), {
              dateStyle: 'medium',
              timeStyle: 'short'
            })
          })}
          {' · '}
          {t('shipments', { count: row.shipmentsWaiting })}
        </span>
      </div>
      {canManage ? (
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="sr-only">
            {t('mapTo', { code: row.sampleRawStatus })}
          </label>
          <StatusSelect
            id={id}
            value={target}
            onChange={setTarget}
            disabled={put.isPending}
            placeholder={t('mapPlaceholder')}
          />
          <Button
            type="button"
            size="sm"
            disabled={target === '' || put.isPending}
            busy={put.isPending}
            onClick={apply}
          >
            {t('apply')}
            <span className="sr-only"> {row.sampleRawStatus}</span>
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function MappingTable({ connection }: { connection: CarrierConnectionView }): ReactElement {
  const t = useTranslations('settings.carriers.mapping.table')
  const { storeId } = useStore()
  const mappings = useStatusMappings(storeId, connection.id)
  if (mappings.isError) {
    return <LoadFailed error={mappings.error} onRetry={() => void mappings.refetch()} />
  }
  if (mappings.data === undefined) return <PageLoading />
  const rows = mappings.data.pages.flatMap(page => page.data)
  return (
    <section aria-labelledby={`${connection.id}-table`} className="flex flex-col gap-2">
      <h3 id={`${connection.id}-table`} className="text-base font-semibold">
        {t('title')}
      </h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('none')}</p>
      ) : (
        <ul aria-label={t('title')} className="flex flex-col gap-2">
          {rows.map(row => (
            <MappingRow key={row.providerCode} connection={connection} row={row} />
          ))}
        </ul>
      )}
      {mappings.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            busy={mappings.isFetchingNextPage}
            onClick={() => void mappings.fetchNextPage()}
          >
            {t('more')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function MappingRow({
  connection,
  row
}: {
  connection: CarrierConnectionView
  row: StatusMappingView
}): ReactElement {
  const t = useTranslations('settings.carriers.mapping.table')
  const tMapping = useTranslations('settings.carriers.mapping')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const put = usePutStatusMapping(storeId, connection.id)
  const remove = useRemoveStatusMapping(storeId, connection.id)
  const id = useId()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_CARRIERS)
  const current = row.status ?? IGNORE
  const custom = row.source === String(CarrierStatusMappingSource.CUSTOM)
  const pending = put.isPending || remove.isPending
  const label = row.label ?? row.providerCode

  const change = (value: string): void =>
    put.mutate(
      { providerCode: row.providerCode, status: value === IGNORE ? null : value },
      { onError: error => toast.error(errorText(error)) }
    )

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm break-all">{label}</span>
        <span className="text-muted-foreground text-xs">{custom ? t('custom') : t('default')}</span>
      </div>
      {canManage ? (
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="sr-only">
            {t('statusOf', { code: label })}
          </label>
          <StatusSelect id={id} value={current} onChange={change} disabled={pending} />
          {custom ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              busy={remove.isPending}
              onClick={() =>
                remove.mutate(row.providerCode, { onError: error => toast.error(errorText(error)) })
              }
            >
              {t('restore')}
              <span className="sr-only"> {label}</span>
            </Button>
          ) : null}
        </div>
      ) : (
        <span className="text-sm">
          {row.status === null
            ? t('ignored')
            : tMapping(`statuses.${row.status}` as 'statuses.delivered')}
        </span>
      )}
    </li>
  )
}
