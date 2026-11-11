'use client'

import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CountLimits } from '@platform/core/domain'

import { conflictOf } from '../../lib/counts/count-conflict'
import { useCountWarehouses, useCreateCount } from '../../lib/counts/use-counts'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useProfile } from '../../lib/use-profile'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// A new count (TDD_16 §4.6): the warehouse, and optionally one store whose products are the only ones counted. It starts
// as a draft; the sheet is made when the count is started.
export function CountCreateDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { storeId } = useStore()
  const create = useCreateCount(storeId)
  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !create.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent>
        {/* Mounted only while open: every opening starts a form of its own */}
        {open ? <CreateForm create={create} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function CreateForm({
  create,
  onCancel
}: {
  create: ReturnType<typeof useCreateCount>
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('counts.create')
  const tAll = useTranslations()
  const router = useRouter()
  const format = useFormatter()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const warehouses = useCountWarehouses(storeId, true)
  const profile = useProfile()
  const [warehouseId, setWarehouseId] = useState('')
  const [scopeStoreId, setScopeStoreId] = useState('')
  const [note, setNote] = useState('')
  const [missing, setMissing] = useState(false)
  // The stores a count may be limited to: those where the person may count
  const countable = (profile.data?.memberships ?? []).filter(item =>
    item.permissions.includes(ClientPermissions.INVENTORY_MANAGE_COUNTS)
  )
  const list = warehouses.data ?? []
  const chosen = list.some(warehouse => warehouse.id === warehouseId) ? warehouseId : ''
  const conflict = conflictOf(create.error)
  const reason = conflict === null ? null : `conflicts.${conflict}`

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (chosen === '') return setMissing(true)
    if (!guard.enter()) return
    const trimmed = note.trim()
    create.mutate(
      {
        warehouseId: chosen,
        ...(scopeStoreId === '' ? {} : { storeId: scopeStoreId }),
        ...(trimmed === '' ? {} : { note: trimmed })
      },
      {
        onSuccess: created => router.push(AppPaths.org.count(created.id)),
        onSettled: guard.leave
      }
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <Label htmlFor="count-warehouse">{t('warehouse')}</Label>
          <select
            id="count-warehouse"
            className={SELECT_CLASS}
            value={chosen}
            onChange={event => {
              setWarehouseId(event.target.value)
              setMissing(false)
              create.reset()
            }}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? 'count-warehouse-error' : undefined}
          >
            <option value="">{t('warehouseNone')}</option>
            {list.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.name}
              </option>
            ))}
          </select>
          {warehouses.isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              {tAll('common.loading')}
            </p>
          ) : null}
          {warehouses.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>{t('warehousesFailed')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void warehouses.refetch()}
              >
                {tAll('common.tryAgain')}
              </Button>
            </div>
          ) : null}
          {warehouses.isSuccess && list.length === 0 ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t('noWarehouses')}
            </p>
          ) : null}
          {missing ? (
            <p id="count-warehouse-error" role="alert" className="text-destructive text-sm">
              {t('warehouseRequired')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="count-scope">{t('scope')}</Label>
          <select
            id="count-scope"
            className={SELECT_CLASS}
            value={scopeStoreId}
            onChange={event => {
              setScopeStoreId(event.target.value)
              create.reset()
            }}
          >
            <option value="">{t('scopeAll')}</option>
            {countable.map(item => (
              <option key={item.storeId} value={item.storeId}>
                {item.storeName}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-sm">
            {t('scopeHelp', { max: format.number(CountLimits.MAX_LINES) })}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="count-note">{t('note')}</Label>
          <Input
            id="count-note"
            value={note}
            maxLength={CountLimits.NOTE_MAX_LENGTH}
            onChange={event => setNote(event.target.value)}
          />
        </div>
        {reason !== null && tAll.has(`counts.${reason}` as 'counts.title') ? (
          <p role="alert" className="text-destructive text-sm">
            {tAll(`counts.${reason}` as 'counts.title')}
          </p>
        ) : (
          <MutationError error={create.error} />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
            {tAll('common.cancel')}
          </Button>
          <Button type="submit" busy={create.isPending}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </>
  )
}
