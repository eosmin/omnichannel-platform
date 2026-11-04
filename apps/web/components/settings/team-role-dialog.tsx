'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'

import { useRoleLabel } from '../../lib/role-label'
import { permissionGroups, toggled } from '../../lib/settings/permission-groups'
import type { RoleView } from '../../lib/settings/team-requests'
import { canGrant } from '../../lib/settings/team-roles'
import { useCreateRole, useUpdateRole } from '../../lib/settings/use-team'
import { MutationError } from '../customers/mutation-error'
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
import { Input } from '../ui/input'
import { Label } from '../ui/label'

const GROUPS = permissionGroups()

// Create a custom role, edit one, or read a system role (TDD_09 §13). The matrix lists every
// permission by area. A permission the person does not hold is shown and cannot be ticked: the api
// refuses a role that holds what its author lacks, so a role is never more powerful than the one who
// wrote it. A role that already holds one they lack is read-only for them, for the same reason.
export function RoleDialog({
  role,
  onClose
}: {
  role: RoleView | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.team.roles.dialog')
  const tAll = useTranslations()
  const roleLabel = useRoleLabel()
  const { storeId, can } = useStore()
  const create = useCreateRole(storeId)
  const update = useUpdateRole(storeId)
  const idPrefix = useId()
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [selected, setSelected] = useState<string[]>(role?.permissions ?? [])

  const mutation = role === null ? create : update
  const pending = mutation.isPending
  const fullyHeld = role === null || canGrant(role, can)
  const readOnly =
    !can(Permissions.TEAM_MANAGE_ROLES) || (role !== null && (role.isSystem || !fullyHeld))
  const canSubmit = !readOnly && name.trim() !== '' && !pending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    // No description is null on the role, never an empty text
    const text = description.trim()
    const input = {
      name: name.trim(),
      ...(text === '' && role === null ? {} : { description: text === '' ? null : text }),
      permissions: selected
    }
    const done = (): void => {
      toast.success(t('saved', { name: input.name }))
      onClose()
    }
    if (role === null) create.mutate(input, { onSuccess: done })
    else update.mutate({ roleId: role.id, input }, { onSuccess: done })
  }

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {role === null
              ? t('createTitle')
              : readOnly
                ? t('viewTitle', { name: roleLabel(role.name) })
                : t('editTitle', { name: roleLabel(role.name) })}
          </DialogTitle>
          <DialogDescription>
            {role?.isSystem === true
              ? t('systemNote')
              : !fullyHeld
                ? t('notHeldNote')
                : readOnly
                  ? t('readOnlyNote')
                  : t('description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={name}
              maxLength={60}
              onChange={event => setName(event.target.value)}
              disabled={readOnly || pending}
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-description`}>
              {t('descriptionLabel')}
              <span className="text-muted-foreground font-normal"> {t('optional')}</span>
            </Label>
            <Input
              id={`${idPrefix}-description`}
              value={description}
              maxLength={255}
              onChange={event => setDescription(event.target.value)}
              disabled={readOnly || pending}
            />
          </div>
          <fieldset className="grid gap-3" disabled={readOnly || pending}>
            <legend className="text-sm font-medium">{t('permissions')}</legend>
            {GROUPS.map(({ group, permissions }) => (
              <div key={group} className="grid gap-1.5 rounded-md border p-3">
                <h3 className="text-sm font-medium">
                  {tAll(`settings.team.permissionGroups.${group}` as Parameters<typeof tAll>[0])}
                </h3>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {permissions.map(({ permission, action }) => {
                    const id = `${idPrefix}-${group}-${action}`
                    const checked = selected.includes(permission)
                    // A permission already on the role stays untickable-off too when the person lacks it
                    const grantable = can(permission)
                    return (
                      <li key={permission} className="flex items-center gap-2 text-sm">
                        <input
                          id={id}
                          type="checkbox"
                          checked={checked}
                          disabled={!grantable}
                          onChange={() => setSelected(toggled(selected, permission))}
                        />
                        <Label htmlFor={id} className="font-normal">
                          {tAll(
                            `settings.team.permissions.${group}.${action}` as Parameters<
                              typeof tAll
                            >[0]
                          )}
                        </Label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </fieldset>
          <MutationError error={mutation.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {readOnly ? tAll('common.close') : tAll('common.cancel')}
            </Button>
            {readOnly ? null : (
              <Button type="submit" disabled={!canSubmit}>
                {pending ? t('saving') : t('save')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
