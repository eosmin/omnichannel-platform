'use client'

import { Pencil, Plus, Settings, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { AppPaths, type StoreView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { type DestructiveAction, OrganizationLimits } from '@platform/core/domain'

import { MutationError } from '../../components/customers/mutation-error'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { StoreFields } from '../../components/settings/store-fields'
import { useDestructiveAction } from '../../components/shared/destructive-action'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { forgetLastStoreId } from '../../lib/last-store'
import { storeFormProblems, type StoreFormValues } from '../../lib/settings/store-form'
import {
  useCreateStore,
  useDeleteStore,
  useOrganizationStores,
  useUpdateStore
} from '../../lib/settings/use-settings-data'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useProfile } from '../../lib/use-profile'

// Typed by the key of DestructiveActionTiers, which is where its tier (critical: a typed phrase) lives
const DELETE_STORE_ACTION: DestructiveAction = 'DELETE_STORE'

// Organization → Stores (TDD_09 §13): create, rename and delete the stores of the organization.
// Everything here needs ORG_MANAGE_STORES; the api checks it on every call.
export function StoresList(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.ORG_MANAGE_STORES) ? (
    <Stores />
  ) : (
    <PermissionDenied permission={ClientPermissions.ORG_MANAGE_STORES} />
  )
}

function Stores(): ReactElement {
  const t = useTranslations('org')
  const { storeId } = useStore()
  const stores = useOrganizationStores(storeId)
  const [creating, setCreating] = useState(false)
  if (stores.isError) {
    return <LoadFailed error={stores.error} onRetry={() => void stores.refetch()} />
  }
  if (stores.data === undefined) return <PageLoading />
  const current = stores.data.find(store => store.id === storeId)
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t('storesTitle')}</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          {t('newStore')}
        </Button>
      </header>
      {stores.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {stores.data.map(store => (
            <StoreRow key={store.id} store={store} isOnlyStore={stores.data.length === 1} />
          ))}
        </ul>
      )}
      <NewStoreDialog open={creating} onOpenChange={setCreating} template={current} />
    </section>
  )
}

function StoreRow({
  store,
  isOnlyStore
}: {
  store: StoreView
  isOnlyStore: boolean
}): ReactElement {
  const t = useTranslations('org')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const run = useDestructiveAction()
  const remove = useDeleteStore(storeId)
  const [renaming, setRenaming] = useState(false)
  const profile = useProfile()
  // The settings of a store are for its members: the link is spared to who is not one of this store
  const isMember = profile.data?.memberships.some(item => item.storeId === store.id) === true

  const askToDelete = (): void => {
    run(DELETE_STORE_ACTION, {
      title: t('delete.title', { name: store.name }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
      phrase: store.name,
      onConfirm: async () => {
        try {
          // The dialog already made the person type the name; the api asks for it too (ORG-03)
          await remove.mutateAsync({ id: store.id, confirmation: store.name })
          forgetLastStoreId(store.id)
          toast.success(t('delete.done', { name: store.name }))
        } catch (error) {
          // The api says why (the last store, a store that holds data): that is what the person reads
          toast.error(errorText(error))
        }
      }
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">{store.name}</span>
        <span className="text-muted-foreground text-sm">
          {store.slug} · {store.timezone} · {store.currency} · {store.defaultLocale}
        </span>
      </div>
      <div className="flex gap-1">
        {isMember ? (
          <Button asChild variant="outline" size="sm">
            <Link
              href={AppPaths.store.settings(store.id)}
              aria-label={`${t('settings')} ${store.name}`}
            >
              <Settings aria-hidden />
              {t('settings')}
            </Link>
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          aria-label={`${t('rename.action')} ${store.name}`}
          onClick={() => setRenaming(true)}
        >
          <Pencil aria-hidden />
          {t('rename.action')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isOnlyStore}
          aria-label={`${t('delete.action')} ${store.name}`}
          title={isOnlyStore ? t('delete.lastStore') : undefined}
          onClick={askToDelete}
        >
          <Trash2 aria-hidden />
          {t('delete.action')}
        </Button>
      </div>
      {renaming ? <RenameDialog store={store} onClose={() => setRenaming(false)} /> : null}
    </li>
  )
}

function RenameDialog({ store, onClose }: { store: StoreView; onClose: () => void }): ReactElement {
  const t = useTranslations('org.rename')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const update = useUpdateStore(storeId, store.id)
  const [name, setName] = useState(store.name)
  const trimmed = name.trim()
  const isValid = trimmed.length > 0 && trimmed.length <= OrganizationLimits.NAME_MAX_LENGTH
  const canSave = isValid && trimmed !== store.name && !update.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSave) return
    update.mutate({ name: trimmed }, { onSuccess: onClose })
  }
  return (
    <Dialog open onOpenChange={next => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`rename-${store.id}`}>{t('name')}</Label>
            <Input
              id={`rename-${store.id}`}
              value={name}
              maxLength={OrganizationLimits.NAME_MAX_LENGTH}
              aria-invalid={!isValid}
              onChange={event => setName(event.target.value)}
            />
          </div>
          <MutationError error={update.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {tAll('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const FALLBACK_VALUES: StoreFormValues = {
  name: '',
  timezone: 'America/El_Salvador',
  currency: 'USD',
  defaultLocale: 'es'
}

// The new store starts with the time zone, currency and language of the store the person is in: a
// chain mostly sells in one place. They can change any of them before creating it.
function NewStoreDialog({
  open,
  onOpenChange,
  template
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  template: StoreView | undefined
}): ReactElement {
  const t = useTranslations('org.create')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const create = useCreateStore(storeId)
  const initial: StoreFormValues =
    template === undefined
      ? FALLBACK_VALUES
      : {
          name: '',
          timezone: template.timezone,
          currency: template.currency,
          defaultLocale: template.defaultLocale
        }
  const [values, setValues] = useState(initial)
  const problems = storeFormProblems(values)
  const canCreate = Object.keys(problems).length === 0 && !create.isPending
  const guard = useSubmitGuard()

  const close = (next: boolean): void => {
    if (!next) {
      setValues(initial)
      create.reset()
    }
    onOpenChange(next)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canCreate || !guard.enter()) return
    create.mutate(
      {
        name: values.name.trim(),
        timezone: values.timezone,
        currency: values.currency,
        defaultLocale: values.defaultLocale
      },
      {
        onSuccess: created => {
          toast.success(t('done', { name: created.name }))
          close(false)
        },
        onSettled: guard.leave
      }
    )
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} className="grid grid-cols-1 gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <StoreFields
            values={values}
            problems={values.name === '' ? {} : problems}
            disabled={create.isPending}
            onChange={setValues}
          />
          <MutationError error={create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
