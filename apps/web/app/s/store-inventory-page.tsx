'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  type InventoryDraft,
  inventoryChanges,
  inventoryDraftOf,
  inventoryProblems
} from '../../lib/settings/inventory-form'
import type { InventorySettingsView } from '../../lib/settings/inventory-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import {
  useInventorySettings,
  useSaveInventorySettings
} from '../../lib/settings/use-inventory-settings'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Settings → Store → Inventory (TDD_16 §4.4, §4.10 and §7): whether the store sells units it does not have, whether
// one order may be served from several warehouses, and the low-stock threshold a new product starts with.
// Opening needs SETTINGS_VIEW and saving SETTINGS_EDIT, as the api asks.
export function StoreInventoryPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) ? (
    <InventoryLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function InventoryLoader(): ReactElement {
  const t = useTranslations('settings.inventory')
  const { storeId } = useStore()
  const settings = useInventorySettings(storeId)
  if (settings.isError) {
    return <LoadFailed error={settings.error} onRetry={() => void settings.refetch()} />
  }
  if (settings.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <InventoryForm key={storeId} saved={settings.data} />
    </section>
  )
}

// `saved` is what the form started from and, after a save of its own, what that save returned. A read that
// brings another person's change later does not move it: only what this person edited is sent.
function InventoryForm({ saved: loaded }: { saved: InventorySettingsView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.inventory')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const save = useSaveInventorySettings(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<InventoryDraft>(() => inventoryDraftOf(saved))
  const [showProblems, setShowProblems] = useState(false)
  const problems = inventoryProblems(draft)
  const changes = inventoryChanges(saved, draft)
  const changed = Object.keys(changes).length > 0
  useUnsavedChanges(canEdit && changed)
  const disabled = !canEdit || save.isPending
  const set = (patch: Partial<InventoryDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    if (!changed) return
    save.mutate(changes, {
      onSuccess: view => {
        setSaved(view)
        setDraft(inventoryDraftOf(view))
        setShowProblems(false)
        toast.success(t('saved'))
      },
      onError: error => toast.error(errorText(error))
    })
  }

  // Nothing to send disables Save, but a threshold that cannot be read is something the person must be told
  const saveDisabled = disabled || (!changed && problems.length === 0)
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate aria-label={t('formLabel')}>
      {canEdit ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('negative.legend')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.allowNegativeStock}
            onChange={event => set({ allowNegativeStock: event.target.checked })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('negative.switch')}
            <span className="text-muted-foreground block text-xs">{t('negative.hint')}</span>
          </span>
        </label>
        {draft.allowNegativeStock ? (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{t('negative.warning')}</span>
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('split.legend')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.allowSplitFulfillment}
            onChange={event => set({ allowSplitFulfillment: event.target.checked })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('split.switch')}
            <span className="text-muted-foreground block text-xs">{t('split.hint')}</span>
          </span>
        </label>
      </fieldset>

      <div className="grid max-w-md gap-1.5">
        <Label htmlFor={`${idPrefix}-threshold`}>{t('threshold.label')}</Label>
        <Input
          id={`${idPrefix}-threshold`}
          inputMode="numeric"
          value={draft.defaultLowStockThreshold}
          placeholder={t('threshold.placeholder')}
          onChange={event => set({ defaultLowStockThreshold: event.target.value })}
          disabled={disabled}
          className="max-w-40"
          aria-invalid={showProblems && problems.length > 0}
          aria-describedby={
            showProblems && problems.length > 0 ? `${idPrefix}-problems` : undefined
          }
        />
        <p className="text-muted-foreground text-xs">{t('threshold.hint')}</p>
      </div>

      {showProblems && problems.length > 0 ? (
        <ul
          id={`${idPrefix}-problems`}
          role="alert"
          className="text-destructive list-disc pl-5 text-sm"
        >
          {problems.map(problem => (
            <li key={problem}>{t(`problems.${problem}`)}</li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div>
          <Button type="submit" disabled={saveDisabled} busy={save.isPending}>
            {t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
