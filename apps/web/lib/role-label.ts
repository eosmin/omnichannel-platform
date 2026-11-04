'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { RoleNames } from '@platform/core/auth'

const SYSTEM_ROLE_NAMES: ReadonlySet<string> = new Set(Object.values(RoleNames))

// The name a role shows in the interface. The four system roles are stored in English and are the
// same in every store, so they are named from the message files ("Administrador", "Solo lectura");
// a role the store made keeps the name it was given. A custom role cannot take a system name (the
// api refuses it), so a name that matches one is the system role.
export function useRoleLabel(): (roleName: string) => string {
  const t = useTranslations('settings.team.roleNames')
  return useCallback(
    roleName => (SYSTEM_ROLE_NAMES.has(roleName) ? t(roleName as 'Admin') : roleName),
    [t]
  )
}
