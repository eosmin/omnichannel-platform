'use client'

import { Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ApiError } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

import { useRoleLabel } from '../../lib/role-label'
import type { RoleView } from '../../lib/settings/team-requests'
import { useDeleteRole } from '../../lib/settings/use-team'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

// The dialog holds the whole table of permissions (the matrix of a role), which the inbox must not
// carry: it is its own chunk, loaded when a role is opened
const RoleDialog = dynamic(() => import('./team-role-dialog').then(module => module.RoleDialog), {
  ssr: false
})

// What the dialog is open on: nothing, a new role, or an existing one (read-only when it is a system role)
type Editing = { kind: 'new' } | { kind: 'role'; role: RoleView } | null

// Settings → Team → Roles: the roles of the system, which nobody edits, and the custom roles of the
// store with the matrix of permissions (TDD_09 §13). The system roles are the same for every store.
export function RolesPanel({ roles }: { roles: RoleView[] }): ReactElement {
  const t = useTranslations('settings.team.roles')
  const { can } = useStore()
  const [editing, setEditing] = useState<Editing>(null)
  const canManage = can(ClientPermissions.TEAM_MANAGE_ROLES)
  const custom = roles.filter(role => !role.isSystem)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        {canManage ? (
          <Button type="button" size="sm" onClick={() => setEditing({ kind: 'new' })}>
            <Plus aria-hidden className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>
      <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
        {roles.map(role => (
          <RoleRow
            key={role.id}
            role={role}
            canManage={canManage}
            onOpen={() => setEditing({ kind: 'role', role })}
          />
        ))}
      </ul>
      {custom.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
          {t('emptyCustom')}
        </p>
      ) : null}
      {editing === null ? null : (
        <RoleDialog
          // A fresh form for each role: nothing typed for one carries to the next
          key={editing.kind === 'role' ? editing.role.id : 'new'}
          role={editing.kind === 'role' ? editing.role : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function RoleRow({
  role,
  canManage,
  onOpen
}: {
  role: RoleView
  canManage: boolean
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('settings.team.roles')
  const errorText = useErrorText()
  const roleLabel = useRoleLabel()
  const { storeId } = useStore()
  const run = useDestructiveAction()
  const remove = useDeleteRole(storeId)
  const editable = canManage && !role.isSystem

  const askToDelete = (): void => {
    run('DELETE_CUSTOM_ROLE', {
      title: t('delete.title', { name: role.name }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
      onConfirm: async () => {
        try {
          await remove.mutateAsync(role.id)
          toast.success(t('delete.done', { name: role.name }))
        } catch (error) {
          // A role that members or invitations still hold is refused with RESOURCE_CONFLICT, which the
          // generic text calls a race: here it means something else
          toast.error(
            error instanceof ApiError && error.code === ClientErrorCodes.RESOURCE_CONFLICT
              ? t('delete.inUse', { name: role.name })
              : errorText(error)
          )
        }
      }
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="flex items-center gap-2 font-medium">
          {roleLabel(role.name)}
          {role.isSystem ? (
            <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-normal">
              <Lock aria-hidden className="size-3" />
              {t('system')}
            </span>
          ) : null}
        </h2>
        {role.description !== null && role.description !== '' ? (
          <span className="text-muted-foreground text-sm">{role.description}</span>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {t('permissionCount', { count: role.permissions.length })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onOpen}>
          {editable ? <Pencil aria-hidden className="size-4" /> : null}
          {editable ? t('edit') : t('view')}
          <span className="sr-only"> {roleLabel(role.name)}</span>
        </Button>
        {editable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={askToDelete}
          >
            <Trash2 aria-hidden className="size-4" />
            {t('delete.action')}
            <span className="sr-only"> {roleLabel(role.name)}</span>
          </Button>
        ) : null}
      </div>
    </li>
  )
}
