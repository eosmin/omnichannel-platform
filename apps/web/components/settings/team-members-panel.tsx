'use client'

import { Trash2, Users } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'

import { errorCodeOf } from '../../lib/error-message'
import type { MemberView, RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import { useChangeMemberRole, useRemoveMember } from '../../lib/settings/use-team'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'

// Settings → Team → Members: who belongs to the store, with the role each holds. Changing a role needs
// TEAM_MANAGE_ROLES and removing needs TEAM_REMOVE; the api also refuses a change that hands out, or
// takes away, a role holding permissions the person lacks, and the select only spares them that.
export function MembersPanel({
  members,
  roles
}: {
  members: MemberView[]
  roles: RoleView[]
}): ReactElement {
  const t = useTranslations('settings.team.members')
  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
        <Users aria-hidden className="text-muted-foreground size-8" />
        <h2 className="text-base font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
      </div>
    )
  }
  return (
    <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
      {members.map(member => (
        <MemberRow key={member.id} member={member} roles={roles} />
      ))}
    </ul>
  )
}

function MemberRow({ member, roles }: { member: MemberView; roles: RoleView[] }): ReactElement {
  const t = useTranslations('settings.team.members')
  const tErrors = useTranslations('errors')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const change = useChangeMemberRole(storeId)
  const remove = useRemoveMember(storeId)

  const current = roles.find(role => role.id === member.role.id)
  // The api needs the person to hold the role the member has now and the one they get
  const canChangeRole =
    can(Permissions.TEAM_MANAGE_ROLES) && current !== undefined && canGrant(current, can)
  const busy = change.isPending || remove.isPending

  const askToRemove = (): void => {
    run('REMOVE_TEAM_MEMBER', {
      title: t('remove.title', { name: member.name }),
      description: t('remove.description'),
      confirmLabel: t('remove.confirm'),
      onConfirm: async () => {
        try {
          await remove.mutateAsync(member.id)
          toast.success(t('remove.done', { name: member.name }))
        } catch (error) {
          toast.error(tErrors(errorCodeOf(error)))
        }
      }
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="truncate font-medium">{member.name}</h2>
        <span className="text-muted-foreground truncate text-sm">{member.email}</span>
        <span className="text-muted-foreground text-xs">
          {t('joined', {
            date: format.dateTime(new Date(member.joinedAt), { dateStyle: 'medium' })
          })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {canChangeRole ? (
          <select
            aria-label={t('roleOf', { name: member.name })}
            className={`${SELECT_CLASS} w-40`}
            value={member.role.id}
            disabled={busy}
            onChange={event =>
              change.mutate(
                { memberId: member.id, roleId: event.target.value },
                {
                  onSuccess: updated =>
                    toast.success(
                      t('roleChanged', { name: updated.name, role: updated.role.name })
                    ),
                  onError: error => toast.error(tErrors(errorCodeOf(error)))
                }
              )
            }
          >
            {roles.map(role => (
              <option key={role.id} value={role.id} disabled={!canGrant(role, can)}>
                {role.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="bg-muted rounded-md px-2 py-1 text-sm">{member.role.name}</span>
        )}
        // The api refuses to remove someone whose role holds what the person lacks
        {can(Permissions.TEAM_REMOVE) && current !== undefined && canGrant(current, can) ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={askToRemove}>
            <Trash2 aria-hidden className="size-4" />
            {t('remove.action')}
            <span className="sr-only"> {member.name}</span>
          </Button>
        ) : null}
      </div>
    </li>
  )
}
