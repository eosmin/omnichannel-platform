'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import type { OrganizationView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { OrganizationLimits } from '@platform/core/domain'

import { MutationError } from '../../components/customers/mutation-error'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useOrganization, useRenameOrganization } from '../../lib/settings/use-settings-data'

// Organization → Profile: the name of the organization. Anyone who may look at settings reads it;
// changing it needs the right to edit them.
export function OrganizationProfilePage(): ReactElement {
  const { can } = useStore()
  return can(Permissions.SETTINGS_VIEW) ? <ProfileLoader /> : <PermissionDenied />
}

function ProfileLoader(): ReactElement {
  const { storeId } = useStore()
  const organization = useOrganization(storeId)
  if (organization.isError) {
    return <LoadFailed error={organization.error} onRetry={() => void organization.refetch()} />
  }
  if (organization.data === undefined) return <PageLoading />
  return <ProfileForm organization={organization.data} />
}

function ProfileForm({ organization }: { organization: OrganizationView }): ReactElement {
  const t = useTranslations('settings.organization')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const id = useId()
  const rename = useRenameOrganization(storeId)
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const [saved, setSaved] = useState(organization.name)
  const [name, setName] = useState(organization.name)
  const trimmed = name.trim()
  const isValid = trimmed.length > 0 && trimmed.length <= OrganizationLimits.NAME_MAX_LENGTH
  const canSave = canEdit && isValid && trimmed !== saved && !rename.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSave) return
    rename.mutate(trimmed, {
      onSuccess: next => {
        setSaved(next.name)
        setName(next.name)
        toast.success(t('saved'))
      }
    })
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">
          {canEdit ? t('description') : t('readOnly')}
        </p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t('name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={OrganizationLimits.NAME_MAX_LENGTH}
            readOnly={!canEdit}
            aria-invalid={!isValid}
            onChange={event => setName(event.target.value)}
          />
          {isValid ? null : (
            <p role="alert" className="text-destructive text-sm">
              {t('nameInvalid')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-slug`}>{t('slug')}</Label>
          <Input id={`${id}-slug`} value={organization.slug} readOnly />
        </div>
        <MutationError error={rename.error} />
        {canEdit ? (
          <div className="flex gap-2">
            <Button type="submit" disabled={!canSave}>
              {tAll('common.save')}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  )
}
