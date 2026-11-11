'use client'

import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { WarehouseDetailView, WarehouseStoreLink } from '@platform/api-client'

import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useReplaceWarehouseStores } from '../../lib/warehouses/use-warehouses'
import {
  addableStores,
  addLink,
  linkInputsOf,
  linksChanged,
  linksOf,
  moveLink,
  removeLink,
  stockBlockKeyOf
} from '../../lib/warehouses/warehouse-form'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

export interface LinkableStore {
  id: string
  name: string
}

// The stores a warehouse serves and the order each one reserves from it (TDD_16 §6): the first one is reserved
// first. The list is saved whole, so every store that is already linked stays on the screen until it is removed.
export function WarehouseStoresEditor({
  storeId,
  warehouse,
  stores,
  canEdit,
  onSaved
}: {
  storeId: string
  warehouse: WarehouseDetailView
  stores: readonly LinkableStore[]
  canEdit: boolean
  onSaved: (warehouse: WarehouseDetailView) => void
}): ReactElement {
  const t = useTranslations('warehouses.stores')
  const tBlock = useTranslations('warehouses.stockBlock')
  const errorText = useErrorText()
  const guard = useSubmitGuard()
  const save = useReplaceWarehouseStores(storeId)
  const [saved, setSaved] = useState<WarehouseStoreLink[]>(() => linksOf(warehouse))
  const [links, setLinks] = useState<WarehouseStoreLink[]>(() => linksOf(warehouse))
  const [pick, setPick] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const pickId = useId()
  const changed = linksChanged(saved, links)
  // What the api now says the warehouse serves (a save of the details, another person's change): shown while the
  // person has nothing unsaved, and the baseline of "unsaved" either way
  const served = linksOf(warehouse)
  if (linksChanged(saved, served)) {
    setSaved(served)
    if (!changed) setLinks(served)
  }
  const candidates = addableStores(stores, links)
  const pickable = warehouse.active && canEdit
  const disabled = !canEdit || save.isPending

  const edit = (next: WarehouseStoreLink[]): void => {
    setLinks(next)
    setRefusal(null)
  }

  const add = (): void => {
    const store = stores.find(item => item.id === pick)
    if (store === undefined) return
    edit(addLink(links, { storeId: store.id, storeName: store.name }))
    setPick('')
  }

  const submit = (): void => {
    if (!changed || !guard.enter()) return
    save.mutate(
      { id: warehouse.id, stores: linkInputsOf(links) },
      {
        onSuccess: view => {
          const next = linksOf(view)
          setSaved(next)
          setLinks(next)
          setRefusal(null)
          onSaved(view)
          toast.success(t('saved'))
        },
        onError: error => {
          // The api says why a store cannot be unlinked: stock reserved there, or a transfer on its way
          const block = stockBlockKeyOf(error)
          setRefusal(block === null ? errorText(error) : tBlock(block))
        },
        onSettled: guard.leave
      }
    )
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4" disabled={disabled}>
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <p className="text-muted-foreground text-sm">{t('hint')}</p>
      {links.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {links.map((link, index) => (
            <li
              key={link.storeId}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <span
                className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                aria-label={t('position', { position: index + 1 })}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{link.storeName}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('moveUp', { store: link.storeName })}
                disabled={disabled || index === 0}
                onClick={() => edit(moveLink(links, index, -1))}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('moveDown', { store: link.storeName })}
                disabled={disabled || index === links.length - 1}
                onClick={() => edit(moveLink(links, index, 1))}
              >
                <ArrowDown aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('remove', { store: link.storeName })}
                disabled={disabled}
                onClick={() => edit(removeLink(links, link.storeId))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}

      {canEdit ? (
        warehouse.active ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={pickId}>{t('addLabel')}</Label>
            <div className="flex gap-2">
              <select
                id={pickId}
                className={SELECT_CLASS}
                value={pick}
                disabled={!pickable || candidates.length === 0}
                onChange={event => setPick(event.target.value)}
              >
                <option value="">{candidates.length === 0 ? t('noneToAdd') : t('pick')}</option>
                {candidates.map(store => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
              <Button type="button" variant="outline" disabled={pick === ''} onClick={add}>
                <Plus aria-hidden />
                {t('add')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('inactiveHint')}</p>
        )
      ) : null}

      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      {canEdit ? (
        <div>
          <Button type="button" busy={save.isPending} disabled={!changed} onClick={submit}>
            {t('save')}
          </Button>
        </div>
      ) : null}
    </fieldset>
  )
}
