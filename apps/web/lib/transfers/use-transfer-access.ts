'use client'

import { useMemo } from 'react'

import { useProfile } from '../use-profile'

import { transferAccessOf, type TransferAccess } from './transfer-access'

export type { TransferAccess }

// undefined while the profile is on its way, null when the person holds neither permission anywhere
export function useTransferAccess(): TransferAccess | null | undefined {
  const profile = useProfile()
  return useMemo(
    () => (profile.data === undefined ? undefined : transferAccessOf(profile.data.memberships)),
    [profile.data]
  )
}
