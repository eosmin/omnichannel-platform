'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect } from 'react'
import { toast } from 'sonner'

import type { AccountProfile } from '@platform/api-client'

import { LoadingScreen } from '../../components/shell/session-gate'
import { chooseStartPath } from '../../lib/start-path'

// A store the person was suspended in (opened by its link, or the one used last): they are told, and
// sent to a store they can still enter, or to the screen that explains the suspension when they have
// none. "/" never targets a store they are suspended in, so this cannot loop.
export function SuspendedStore({
  storeId,
  storeName,
  profile
}: {
  storeId: string
  storeName: string
  profile: AccountProfile
}): ReactElement {
  const t = useTranslations('noAccess')
  const router = useRouter()
  const target = chooseStartPath(profile.memberships, null)
  useEffect(() => {
    // With no store left the screen it goes to says it all; the toast is for the person who moves on
    if (profile.memberships.length > 0) {
      toast.error(t('suspendedNotice', { store: storeName }), { id: `suspended-${storeId}` })
    }
    router.replace(target)
  }, [router, t, storeId, storeName, target, profile.memberships.length])
  return <LoadingScreen />
}
