'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useRoleLabel } from '../../lib/role-label'
import { isInvitableEmail } from '../../lib/settings/invite-email'
import { retryAfterSecondsOf } from '../../lib/settings/team-errors'
import type { RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import { useInviteMember } from '../../lib/settings/use-team'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
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
  const errorText = useErrorText()
  const tInvitations = useTranslations('settings.team.invitations')
  const tAll = useTranslations()
  const roleLabel = useRoleLabel()
  const { storeId, can } = useStore()
  const invite = useInviteMember(storeId)
  const idPrefix = useId()
  const offered = roles.filter(role => canGrant(role, can))
  const [email, setEmail] = useState('')
  // No role is chosen for the person: the first one in the list is the most powerful, and an
  // invitation sent without looking would hand it out
  const [roleId, setRoleId] = useState('')
  const [showEmailProblem, setShowEmailProblem] = useState(false)
  const canSubmit = email.trim() !== '' && roleId !== '' && !invite.isPending
  const emailProblemId = `${idPrefix}-email-problem`
  const emailField = useRef<HTMLInputElement>(null)

  // The cooldown of inviting says how long to wait, as a resend does; any other refusal is read from its code
  const inviteFailure = (error: Error): string => {
    const seconds = retryAfterSecondsOf(error)
    return seconds === null ? errorText(error) : tInvitations('resend.cooldown', { seconds })
  }

  const guard = useSubmitGuard()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    // The browser's own check would answer in its language and let through what the api refuses
    if (!isInvitableEmail(email)) {
      setShowEmailProblem(true)
      emailField.current?.focus()
      return
    }
    // After the checks that send nothing: the guard is set only for a request that will end
    if (!guard.enter()) return
    invite.mutate(
      { email: email.trim(), roleId },
      {
        onSuccess: sent => {
          toast.success(t('sent', { email: sent.email }))
          onClose()
        },
        onSettled: guard.leave
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
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-email`}>{t('email')}</Label>
            <Input
              id={`${idPrefix}-email`}
              ref={emailField}
              type="email"
              autoComplete="off"
              value={email}
              maxLength={254}
              onChange={event => {
                setEmail(event.target.value)
                // The problem stays until the address is one the api takes
                if (isInvitableEmail(event.target.value)) setShowEmailProblem(false)
              }}
              disabled={invite.isPending}
              aria-invalid={showEmailProblem}
              aria-describedby={showEmailProblem ? emailProblemId : undefined}
              required
            />
            {showEmailProblem ? (
              <p id={emailProblemId} role="alert" className="text-destructive text-sm">
                {t('emailInvalid')}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-role`}>{t('role')}</Label>
            <select
              id={`${idPrefix}-role`}
              className={SELECT_CLASS}
              value={roleId}
              onChange={event => setRoleId(event.target.value)}
              disabled={invite.isPending}
            >
              <option value="" disabled>
                {t('rolePlaceholder')}
              </option>
              {offered.map(role => (
                <option key={role.id} value={role.id}>
                  {roleLabel(role.name)}
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
