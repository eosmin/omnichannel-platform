'use client'

import { useEffect } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { setSafetyPolicy } from '../../lib/safety-policy'
import { useSafety } from '../../lib/settings/use-safety'
import { useStore } from '../providers/store-context'

// Gives the confirmations of the store on screen what the store chose in Settings → Safety and confirmations (TDD_09 §11.2).
// It renders nothing and is loaded after the page (`next/dynamic` in the store shell): a confirmation asked before it has
// answered, or when the settings cannot be read, asks as the tier table says. Leaving the store drops the policy, so one
// store's choice never reaches another's screens.
export default function SafetyPolicySync(): null {
  const { storeId, role, can } = useStore()
  const settings = useSafety(storeId, can(ClientPermissions.CONVERSATIONS_VIEW))
  const data = settings.data
  useEffect(() => {
    if (data === undefined) return undefined
    setSafetyPolicy({
      role,
      confirm: {
        confirmDeleteCustomer: data.confirmDeleteCustomer,
        confirmDisconnectChannel: data.confirmDisconnectChannel,
        confirmRemoveMember: data.confirmRemoveMember
      },
      applyToRoles: data.applyToRoles,
      moderateRiskMode: data.moderateRiskMode
    })
    return () => setSafetyPolicy(null)
  }, [data, role])
  return null
}
