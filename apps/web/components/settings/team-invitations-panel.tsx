'use client'

import { Mail, RotateCw, Send, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'

import { useRoleLabel } from '../../lib/role-label'
import { retryAfterSecondsOf } from '../../lib/settings/team-errors'
import type { InvitationView, RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import { useResendInvitation, useRevokeInvitation } from '../../lib/settings/use-team'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { InviteDialog } from './team-invite-dialog'

// Settings → Team → Invitations: who was invited and has not answered (TDD_09 §13). Inviting and
// resending need TEAM_INVITE, which is also what revoking needs. The page of accepting is Step 3.1.
export function InvitationsPanel({
  invitations,
  roles
}: {
  invitations: InvitationView[]
  roles: RoleView[]
}): ReactElement {
  const t = useTranslations('settings.team.invitations')
  const { can } = useStore()
  const [inviting, setInviting] = useState(false)
  const canInvite = can(Permissions.TEAM_INVITE)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        {canInvite ? (
          <Button type="button" size="sm" onClick={() => setInviting(true)}>
            <Send aria-hidden className="size-4" />
            {t('invite')}
          </Button>
        ) : null}
      </div>
      {invitations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Mail aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {invitations.map(invitation => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              canInvite={canInvite}
              roles={roles}
            />
          ))}
        </ul>
      )}
      {inviting ? <InviteDialog roles={roles} onClose={() => setInviting(false)} /> : null}
    </div>
  )
}

function InvitationRow({
  invitation,
  canInvite,
  roles
}: {
  invitation: InvitationView
  canInvite: boolean
  roles: RoleView[]
}): ReactElement {
  const t = useTranslations('settings.team.invitations')
  const errorText = useErrorText()
  const roleLabel = useRoleLabel()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const resend = useResendInvitation(storeId)
  const revoke = useRevokeInvitation(storeId)
  // The api re-checks that the person holds the permissions of the role the invitation carries
  const role = roles.find(candidate => candidate.id === invitation.role.id)
  const canResend = role !== undefined && canGrant(role, can)
  const busy = resend.isPending || revoke.isPending

  const doResend = (): void => {
    resend.mutate(invitation.id, {
      onSuccess: () => toast.success(t('resend.done', { email: invitation.email })),
      onError: error => {
        // The cooldown of inviting says how long to wait; any other refusal is read from its code
        const seconds = retryAfterSecondsOf(error)
        toast.error(seconds === null ? errorText(error) : t('resend.cooldown', { seconds }))
      }
    })
  }

  const askToRevoke = (): void => {
    run('REVOKE_INVITATION', {
      title: t('revoke.title', { email: invitation.email }),
      description: t('revoke.description'),
      confirmLabel: t('revoke.confirm'),
      onConfirm: async () => {
        try {
          await revoke.mutateAsync(invitation.id)
          toast.success(t('revoke.done', { email: invitation.email }))
        } catch (error) {
          toast.error(errorText(error))
        }
      }
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="truncate font-medium">{invitation.email}</h2>
        <span className="text-muted-foreground text-sm">
          {roleLabel(invitation.role.name)} · {t('invitedBy', { name: invitation.invitedBy })}
        </span>
        <span
          className={
            invitation.expired ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'
          }
        >
          {invitation.expired
            ? t('expired', {
                date: format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'medium' })
              })
            : t('expires', {
                date: format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'medium' })
              })}
        </span>
      </div>
      {canInvite ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !canResend}
            onClick={doResend}
          >
            <RotateCw aria-hidden className="size-4" />
            {t('resend.action')}
            <span className="sr-only"> {invitation.email}</span>
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={askToRevoke}>
            <X aria-hidden className="size-4" />
            {t('revoke.action')}
            <span className="sr-only"> {invitation.email}</span>
          </Button>
        </div>
      ) : null}
    </li>
  )
}
