'use client'

import { Trash2, UserCheck, UserX, Users } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import { useRoleLabel } from '../../lib/role-label'
import {
  filterMembers,
  isSuspendedMember,
  type MemberFilter,
  MemberFilters
} from '../../lib/settings/member-filter'
import type { MemberView, RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import {
  useChangeMemberRole,
  useReactivateMember,
  useRemoveMember,
  useSuspendMember
} from '../../lib/settings/use-team'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useProfile } from '../../lib/use-profile'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'

// Settings → Team → Members: who belongs to the store, with the role each holds and whether they can
// enter. Changing a role needs TEAM_MANAGE_ROLES; removing, suspending and reactivating need
// TEAM_REMOVE. The api also refuses a change that hands out, or takes away, a role holding permissions
// the person lacks, and suspending oneself or the last administrator; the buttons only spare the
// person those refusals, they are not what enforces them.
export function MembersPanel({
  members,
  roles
}: {
  members: MemberView[]
  roles: RoleView[]
}): ReactElement {
  const t = useTranslations('settings.team.members')
  const [filter, setFilter] = useState<MemberFilter>(MemberFilters.ALL)
  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
        <Users aria-hidden className="text-muted-foreground size-8" />
        <h2 className="text-base font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
      </div>
    )
  }
  const shown = filterMembers(members, filter)
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('filter.label')}</span>
        <select
          className={`${SELECT_CLASS} w-44`}
          value={filter}
          onChange={event => setFilter(event.target.value as MemberFilter)}
        >
          {Object.values(MemberFilters).map(value => (
            <option key={value} value={value}>
              {t(`filter.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {shown.length === 0 ? (
        <div
          role="status"
          className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center"
        >
          <Users aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t(`filter.empty.${filter}.title`)}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">
            {t(`filter.empty.${filter}.body`)}
          </p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {shown.map(member => (
            <MemberRow key={member.id} member={member} roles={roles} />
          ))}
        </ul>
      )}
    </div>
  )
}

function MemberRow({ member, roles }: { member: MemberView; roles: RoleView[] }): ReactElement {
  const t = useTranslations('settings.team.members')
  const errorText = useErrorText()
  const roleLabel = useRoleLabel()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const change = useChangeMemberRole(storeId)
  const remove = useRemoveMember(storeId)
  const suspend = useSuspendMember(storeId)
  const reactivate = useReactivateMember(storeId)
  const profile = useProfile()

  const current = roles.find(role => role.id === member.role.id)
  const suspended = isSuspendedMember(member)
  // The api needs the person to hold the role the member has now and the one they get
  const canChangeRole =
    can(ClientPermissions.TEAM_MANAGE_ROLES) &&
    current !== undefined &&
    canGrant(current, can) &&
    !isSuspendedMember(member)
  const busy = change.isPending || remove.isPending || suspend.isPending || reactivate.isPending
  // The api needs the person to hold what the member's role holds, and refuses oneself
  const mayDecideAccess =
    can(ClientPermissions.TEAM_REMOVE) && current !== undefined && canGrant(current, can)
  // Until the profile is read nobody can be told apart from oneself, and the api refuses oneself
  const isMe = profile.data === undefined || profile.data.id === member.userId
  // A conflict is a list that was out of date (someone else got there first), and it is read again
  const accessFailure = (error: unknown, action: 'suspend' | 'reactivate'): string =>
    errorCodeOf(error) === ClientErrorCodes.RESOURCE_CONFLICT
      ? t(`${action}.outOfDate`, { name: member.name })
      : errorText(error)

  const askToSuspend = (): void => {
    run('SUSPEND_TEAM_MEMBER', {
      title: t('suspend.title', { name: member.name }),
      description: t('suspend.description'),
      confirmLabel: t('suspend.confirm'),
      onConfirm: async () => {
        try {
          await suspend.mutateAsync(member.id)
          toast.success(t('suspend.done', { name: member.name }))
        } catch (error) {
          toast.error(accessFailure(error, 'suspend'))
        }
      }
    })
  }

  const askToReactivate = (): void => {
    run('REACTIVATE_TEAM_MEMBER', {
      title: t('reactivate.title', { name: member.name }),
      description: t('reactivate.description', { role: roleLabel(member.role.name) }),
      confirmLabel: t('reactivate.confirm'),
      onConfirm: async () => {
        try {
          await reactivate.mutateAsync(member.id)
          toast.success(t('reactivate.done', { name: member.name }))
        } catch (error) {
          toast.error(accessFailure(error, 'reactivate'))
        }
      }
    })
  }

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
          toast.error(errorText(error))
        }
      }
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-medium">{member.name}</h2>
          <StatusBadge suspended={suspended} />
        </div>
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
                      t('roleChanged', { name: updated.name, role: roleLabel(updated.role.name) })
                    ),
                  onError: error => toast.error(errorText(error))
                }
              )
            }
          >
            {roles.map(role => (
              <option key={role.id} value={role.id} disabled={!canGrant(role, can)}>
                {roleLabel(role.name)}
              </option>
            ))}
          </select>
        ) : (
          <span className="bg-muted rounded-md px-2 py-1 text-sm">
            {roleLabel(member.role.name)}
          </span>
        )}
        {mayDecideAccess && !suspended && !isMe ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={askToSuspend}>
            <UserX aria-hidden className="size-4" />
            {t('suspend.action')}
            <span className="sr-only"> {member.name}</span>
          </Button>
        ) : null}
        {mayDecideAccess && suspended ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={askToReactivate}
          >
            <UserCheck aria-hidden className="size-4" />
            {t('reactivate.action')}
            <span className="sr-only"> {member.name}</span>
          </Button>
        ) : null}
        {mayDecideAccess ? (
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

function StatusBadge({ suspended }: { suspended: boolean }): ReactElement {
  const t = useTranslations('settings.team.members.status')
  return suspended ? (
    <span className="bg-destructive/10 text-destructive inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium">
      <UserX aria-hidden className="size-3" />
      {t('suspended')}
    </span>
  ) : (
    <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium">
      {t('active')}
    </span>
  )
}
