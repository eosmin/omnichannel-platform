'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { AppPaths, type WarehouseDetailView } from '@platform/api-client'

import { useSubmitGuard } from '../../lib/submit-guard'
import { useCreateTransfer } from '../../lib/transfers/use-transfers'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

// Starting a draft: the two warehouses. The items are added on the page of the draft, which opens when it is made.
export function NewTransferDialog({
  storeId,
  warehouses,
  open,
  onOpenChange
}: {
  storeId: string
  warehouses: readonly WarehouseDetailView[]
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('transfers.new')
  const errorText = useErrorText()
  const router = useRouter()
  const guard = useSubmitGuard()
  const create = useCreateTransfer(storeId)
  const ids = useId()
  const active = warehouses.filter(warehouse => warehouse.active)
  const [chosenFrom, setFrom] = useState('')
  const [chosenTo, setTo] = useState('')
  // What the boxes show: the choice while it is still an active warehouse, else the first one that is left
  const from = active.some(item => item.id === chosenFrom) ? chosenFrom : (active[0]?.id ?? '')
  const to = active.some(item => item.id === chosenTo) ? chosenTo : (active[1]?.id ?? '')
  const [refusal, setRefusal] = useState<string | null>(null)
  const same = from === to

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (from === '' || to === '' || same || !guard.enter()) return
    create.mutate(
      { fromWarehouseId: from, toWarehouseId: to },
      {
        onSuccess: view => router.push(AppPaths.org.transfer(view.id)),
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  const select = (id: string, label: string, value: string, set: (next: string) => void) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        onChange={event => {
          set(event.target.value)
          setRefusal(null)
        }}
      >
        {active.map(warehouse => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.code} · {warehouse.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !create.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {active.length < 2 ? (
          <p className="text-muted-foreground text-sm">{t('needTwo')}</p>
        ) : (
          <form
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-3"
            aria-label={t('formLabel')}
          >
            {select(`${ids}-from`, t('from'), from, setFrom)}
            {select(`${ids}-to`, t('to'), to, setTo)}
            {same ? (
              <p role="alert" className="text-destructive text-sm">
                {t('same')}
              </p>
            ) : null}
            {refusal === null ? null : (
              <p role="alert" className="text-destructive text-sm">
                {refusal}
              </p>
            )}
            <div>
              <Button type="submit" busy={create.isPending} disabled={same}>
                {t('submit')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
