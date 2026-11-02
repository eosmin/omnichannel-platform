'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import { AccountLimits } from '@platform/core/domain'

import { MutationError } from '../../components/customers/mutation-error'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useOwnProfile, useSaveOwnProfile } from '../../lib/settings/use-settings-data'

// Account → Profile: the name the team sees. The e-mail is how the person signs in, so it is shown
// and cannot be changed here. The picture joins in the next change (Step 3.6, avatar).
export function ProfileCard(): ReactElement {
  const profile = useOwnProfile()
  if (profile.isError) {
    return <LoadFailed error={profile.error} onRetry={() => void profile.refetch()} />
  }
  if (profile.data === undefined) return <PageLoading />
  return <ProfileForm email={profile.data.email} savedName={profile.data.name} />
}

function ProfileForm({ email, savedName }: { email: string; savedName: string }): ReactElement {
  const t = useTranslations('account')
  const tAll = useTranslations()
  const id = useId()
  const save = useSaveOwnProfile()
  const [saved, setSaved] = useState(savedName)
  const [name, setName] = useState(savedName)
  const trimmed = name.trim()
  const isValid = trimmed.length > 0 && trimmed.length <= AccountLimits.NAME_MAX_LENGTH
  const canSave = isValid && trimmed !== saved && !save.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSave) return
    save.mutate(
      { name: trimmed },
      {
        onSuccess: next => {
          setSaved(next.name)
          setName(next.name)
          toast.success(t('profile.saved'))
        }
      }
    )
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('profileTitle')}</h1>
        <p className="text-muted-foreground text-sm">{t('profile.description')}</p>
      </header>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`}>{t('name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={AccountLimits.NAME_MAX_LENGTH * 2}
            autoComplete="name"
            aria-invalid={!isValid}
            onChange={event => setName(event.target.value)}
          />
          {isValid ? null : (
            <p role="alert" className="text-destructive text-sm">
              {t('profile.nameInvalid')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-email`}>{t('email')}</Label>
          <Input id={`${id}-email`} value={email} readOnly />
          <p className="text-muted-foreground text-xs">{t('profile.emailHint')}</p>
        </div>
        <MutationError error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={!canSave}>
            {tAll('common.save')}
          </Button>
        </div>
      </form>
    </section>
  )
}
