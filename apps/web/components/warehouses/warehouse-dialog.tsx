'use client'

import { useIsMutating } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import type { WarehouseDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { InventoryLimits, WarehouseLimits } from '@platform/core/domain'

import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useCreateWarehouse, useUpdateWarehouse } from '../../lib/warehouses/use-warehouses'
import {
  createInputOf,
  emptyWarehouseDraft,
  isCodeInUse,
  stockBlockKeyOf,
  updateInputOf,
  warehouseDraftOf,
  type WarehouseDraft,
  type WarehouseField,
  WarehouseFields,
  warehouseProblem
} from '../../lib/warehouses/warehouse-form'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { type LinkableStore, WarehouseStoresEditor } from './warehouse-stores-editor'

// Making and editing a warehouse (TDD_16 §6, TDD_09 §16). `warehouse` is null to make one. Everything here needs
// org:manage_warehouses; without it the dialog only shows, and the api refuses on its own.
export function WarehouseDialog({
  warehouse,
  open,
  onOpenChange,
  stores,
  warehouses
}: {
  warehouse: WarehouseDetailView | null
  open: boolean
  onOpenChange: (open: boolean) => void
  stores: readonly LinkableStore[]
  warehouses: readonly WarehouseDetailView[]
}): ReactElement {
  const t = useTranslations('warehouses')
  // A save that is on its way keeps the dialog open: the answer (a toast, a refusal) is shown by the form that sent it
  const saving = useIsMutating() > 0
  return (
    <Dialog open={open} onOpenChange={next => (next || !saving ? onOpenChange(next) : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{warehouse === null ? t('create.title') : t('edit.title')}</DialogTitle>
          <DialogDescription>
            {warehouse === null ? t('create.description') : t('edit.description')}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from what the list holds now */}
        {open ? (
          warehouse === null ? (
            <WarehouseForm warehouse={null} onSaved={() => onOpenChange(false)} />
          ) : (
            <Editing
              key={warehouse.id}
              warehouse={warehouse}
              warehouses={warehouses}
              stores={stores}
            />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Editing({
  warehouse: loaded,
  warehouses,
  stores
}: {
  warehouse: WarehouseDetailView
  warehouses: readonly WarehouseDetailView[]
  stores: readonly LinkableStore[]
}): ReactElement {
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.ORG_MANAGE_WAREHOUSES)
  // What this opening started from and, after a save of its own, what that save returned
  const [saved, setSaved] = useState(loaded)
  return (
    <div className="flex flex-col gap-4">
      <WarehouseForm warehouse={saved} onSaved={setSaved} />
      {canEdit ? <ActiveSwitch warehouse={saved} onSaved={setSaved} /> : null}
      <WarehouseStoresEditor
        storeId={storeId}
        warehouse={saved}
        warehouses={warehouses}
        stores={stores}
        canEdit={canEdit}
        onSaved={setSaved}
      />
    </div>
  )
}

function WarehouseForm({
  warehouse,
  onSaved
}: {
  warehouse: WarehouseDetailView | null
  onSaved: (warehouse: WarehouseDetailView) => void
}): ReactElement {
  const t = useTranslations('warehouses')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.ORG_MANAGE_WAREHOUSES)
  const guard = useSubmitGuard()
  const create = useCreateWarehouse(storeId)
  const update = useUpdateWarehouse(storeId)
  const [draft, setDraft] = useState<WarehouseDraft>(() =>
    warehouse === null ? emptyWarehouseDraft() : warehouseDraftOf(warehouse)
  )
  const [wrong, setWrong] = useState<WarehouseField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [codeTaken, setCodeTaken] = useState(false)
  const idPrefix = useId()
  const pending = create.isPending || update.isPending
  const changes = warehouse === null ? null : updateInputOf(warehouse, draft)
  const changed = changes === null || Object.keys(changes).length > 0

  const set = (patch: Partial<WarehouseDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
    setCodeTaken(false)
  }

  const refused = (error: Error): void => {
    if (isCodeInUse(error)) {
      setCodeTaken(true)
      return
    }
    setRefusal(errorText(error))
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canEdit || !changed) return
    const problem = warehouseProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    if (warehouse === null) {
      create.mutate(createInputOf(draft), {
        onSuccess: view => {
          toast.success(t('create.done', { name: view.name }))
          onSaved(view)
        },
        onError: refused,
        onSettled: guard.leave
      })
      return
    }
    update.mutate(
      { id: warehouse.id, input: changes ?? {} },
      {
        onSuccess: view => {
          toast.success(t('edit.saved'))
          onSaved(view)
          setDraft(warehouseDraftOf(view))
        },
        onError: refused,
        onSettled: guard.leave
      }
    )
  }

  const field = (
    key: keyof WarehouseDraft,
    label: string,
    options: {
      problem?: WarehouseField
      maxLength?: number
      hint?: string
      autoCapitalize?: string
    }
  ): ReactElement => {
    const id = `${idPrefix}-${key}`
    const problem = options.problem !== undefined && wrong === options.problem ? wrong : null
    const taken = key === WarehouseFields.CODE && codeTaken
    const message = taken
      ? t('problems.codeInUse')
      : problem === null
        ? null
        : t(`problems.${problem}`)
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          value={draft[key]}
          maxLength={options.maxLength}
          disabled={!canEdit || pending}
          autoCapitalize={options.autoCapitalize}
          aria-invalid={message !== null}
          aria-describedby={message === null ? undefined : `${id}-error`}
          onChange={event => set({ [key]: event.target.value })}
        />
        {options.hint === undefined ? null : (
          <p className="text-muted-foreground text-xs">{options.hint}</p>
        )}
        {message === null ? null : (
          <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
            {message}
          </p>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      {canEdit ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}
      {field('name', t('form.name'), {
        problem: WarehouseFields.NAME,
        maxLength: InventoryLimits.WAREHOUSE_NAME_MAX_LENGTH
      })}
      {field('code', t('form.code'), {
        problem: WarehouseFields.CODE,
        maxLength: WarehouseLimits.CODE_MAX_LENGTH,
        hint: t('form.codeHint')
      })}
      <fieldset
        className="flex flex-col gap-3 rounded-lg border p-4"
        disabled={!canEdit || pending}
      >
        <legend className="px-1 text-sm font-medium">{t('form.addressLegend')}</legend>
        <p className="text-muted-foreground text-xs">{t('form.addressHint')}</p>
        {field('line1', t('form.line1'), {
          problem: WarehouseFields.LINE1,
          maxLength: WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH
        })}
        {field('line2', t('form.line2'), { maxLength: WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH })}
        {field('city', t('form.city'), {
          problem: WarehouseFields.CITY,
          maxLength: WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH
        })}
        {field('state', t('form.state'), { maxLength: WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH })}
        {field('postalCode', t('form.postalCode'), {
          maxLength: WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH
        })}
        {field('country', t('form.country'), {
          problem: WarehouseFields.COUNTRY,
          maxLength: WarehouseLimits.COUNTRY_LENGTH,
          hint: t('form.countryHint'),
          autoCapitalize: 'characters'
        })}
      </fieldset>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      {canEdit ? (
        <div>
          <Button type="submit" busy={pending} disabled={!changed}>
            {warehouse === null ? t('create.submit') : t('edit.save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

// Switching a warehouse off keeps its history but takes it out of every reservation; the api refuses while it holds
// stock or a transfer is on its way, and says which
function ActiveSwitch({
  warehouse,
  onSaved
}: {
  warehouse: WarehouseDetailView
  onSaved: (warehouse: WarehouseDetailView) => void
}): ReactElement {
  const t = useTranslations('warehouses.state')
  const tBlock = useTranslations('warehouses.stockBlock')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const update = useUpdateWarehouse(storeId)
  const [refusal, setRefusal] = useState<string | null>(null)

  const toggle = (): void => {
    if (!guard.enter()) return
    update.mutate(
      { id: warehouse.id, input: { active: !warehouse.active } },
      {
        onSuccess: view => {
          setRefusal(null)
          onSaved(view)
          toast.success(t(view.active ? 'switchedOn' : 'switchedOff'))
        },
        onError: error => {
          const block = stockBlockKeyOf(error)
          setRefusal(block === null ? errorText(error) : tBlock(block))
        },
        onSettled: guard.leave
      }
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">{warehouse.active ? t('on') : t('off')}</p>
      <p className="text-muted-foreground text-sm">
        {warehouse.active ? t('onHint') : t('offHint')}
      </p>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div>
        <Button
          type="button"
          variant={warehouse.active ? 'outline' : 'default'}
          busy={update.isPending}
          onClick={toggle}
        >
          {warehouse.active ? t('switchOff') : t('switchOn')}
        </Button>
      </div>
    </div>
  )
}
