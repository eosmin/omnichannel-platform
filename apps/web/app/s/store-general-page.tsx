'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { StoreView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { MutationError } from '../../components/customers/mutation-error'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { StoreFields } from '../../components/settings/store-fields'
import { Button } from '../../components/ui/button'
import {
  hasChanges,
  storeFormProblems,
  type StoreFormValues,
  storePatchOf
} from '../../lib/settings/store-form'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useOrganizationStore, useUpdateStore } from '../../lib/settings/use-settings-data'
import { toast } from '../../lib/toast'

const valuesOf = (store: StoreView): StoreFormValues => ({
  name: store.name,
  timezone: store.timezone,
  currency: store.currency,
  defaultLocale: store.defaultLocale
})

// Settings → Store → General (TDD_09 §13): name, time zone, currency and language of this store.
// The page reads and writes the store through organizations.storeById, so it needs the permission
// of that route, not only the right to look at settings.
export function StoreGeneralPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.ORG_MANAGE_STORES) ? (
    <GeneralLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.ORG_MANAGE_STORES} />
  )
}

function GeneralLoader(): ReactElement {
  const { storeId } = useStore()
  const store = useOrganizationStore(storeId, storeId)
  if (store.isError) return <LoadFailed error={store.error} onRetry={() => void store.refetch()} />
  if (store.data === undefined) return <PageLoading />
  return <GeneralForm store={store.data} />
}

function GeneralForm({ store }: { store: StoreView }): ReactElement {
  const t = useTranslations('settings.store')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const update = useUpdateStore(storeId, store.id)
  const [initial, setInitial] = useState(() => valuesOf(store))
  const [values, setValues] = useState(initial)
  const problems = storeFormProblems(values)
  const patch = storePatchOf(initial, values)
  useUnsavedChanges(hasChanges(patch))
  const canSave = hasChanges(patch) && Object.keys(problems).length === 0 && !update.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSave) return
    update.mutate(patch, {
      onSuccess: saved => {
        const next = valuesOf(saved)
        setInitial(next)
        setValues(next)
        toast.success(t('saved'))
      }
    })
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <StoreFields
          values={values}
          problems={problems}
          disabled={update.isPending}
          onChange={setValues}
        />
        <MutationError error={update.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={!canSave}>
            {tAll('common.save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={update.isPending || !hasChanges(patch)}
            onClick={() => setValues(initial)}
          >
            {tAll('common.discard')}
          </Button>
        </div>
      </form>
    </section>
  )
}
