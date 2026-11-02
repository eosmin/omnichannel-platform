'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import { errorCodeOf } from '../../lib/error-message'
import { retryAfterSecondsOf } from '../../lib/settings/team-errors'
import type { RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import { useInviteMember } from '../../lib/settings/use-team'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Invite someone by email with a role (TDD_09 §13). Only roles the person can hand out are offered:
// the api refuses an invitation to a role that holds permissions the inviter lacks.
export function InviteDialog({
  roles,
  onClose
}: {
  roles: RoleView[]
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.team.invitations.dialog')
  const tInvitations = useTranslations('settings.team.invitations')
  const tErrors = useTranslations('errors')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const invite = useInviteMember(storeId)
  const idPrefix = useId()
  const offered = roles.filter(role => canGrant(role, can))
  const [email, setEmail] = useState('')
  const [roleId, setRoleId] = useState(offered[0]?.id ?? '')
  const canSubmit = email.trim() !== '' && roleId !== '' && !invite.isPending

  // The cooldown of inviting says how long to wait, as a resend does; any other refusal is read from its code
  const inviteFailure = (error: Error): string => {
    const seconds = retryAfterSecondsOf(error)
    return seconds === null
      ? tErrors(errorCodeOf(error))
      : tInvitations('resend.cooldown', { seconds })
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    invite.mutate(
      { email: email.trim(), roleId },
      {
        onSuccess: sent => {
          toast.success(t('sent', { email: sent.email }))
          onClose()
        }
      }
    )
  }

  return (
    <Dialog open onOpenChange={open => (open || invite.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-email`}>{t('email')}</Label>
            <Input
              id={`${idPrefix}-email`}
              type="email"
              autoComplete="off"
              value={email}
              maxLength={254}
              onChange={event => setEmail(event.target.value)}
              disabled={invite.isPending}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-role`}>{t('role')}</Label>
            <select
              id={`${idPrefix}-role`}
              className={SELECT_CLASS}
              value={roleId}
              onChange={event => setRoleId(event.target.value)}
              disabled={invite.isPending}
            >
              {offered.map(role => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>
          {offered.length === 0 ? (
            <p role="alert" className="text-destructive text-sm">
              {t('noRole')}
            </p>
          ) : null}
          {invite.error === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {inviteFailure(invite.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={invite.isPending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {invite.isPending ? t('sending') : t('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
