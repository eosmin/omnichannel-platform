'use client'

import { useQueryClient } from '@tanstack/react-query'
import { ShieldOff, TriangleAlert, UserX } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect } from 'react'

import { ApiError, AppPaths, QueryKeys } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { useProfile } from '../../lib/use-profile'
import { SignOutButton } from '../auth/sign-out-button'
import { StatusScreen } from '../shared/status-screen'
import { Button } from '../ui/button'

import { LoadingScreen } from './session-gate'

// Where a person with no store to enter lands. When the reason is that their access was suspended,
// the screen says so and names the stores, and says whom to ask; it is never a generic refusal and
// it never sends them anywhere by itself, so it cannot loop.
export function NoAccessScreen(): ReactElement {
  const t = useTranslations('noAccess')
  const tError = useTranslations('errorPage')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const router = useRouter()
  const queryClient = useQueryClient()
  const profile = useProfile()
  const unauthorized =
    profile.error instanceof ApiError && profile.error.status === HttpStatusCodes.UNAUTHORIZED
  useEffect(() => {
    if (unauthorized) router.replace(AppPaths.login)
  }, [unauthorized, router])
  if (profile.isPending || unauthorized) return <LoadingScreen />
  // The reason cannot be told without the profile: say so and offer a retry, not a wrong refusal
  if (profile.isError) {
    return (
      <StatusScreen icon={TriangleAlert} title={tError('title')} body={tError('body')}>
        <Button onClick={() => void profile.refetch()}>{tCommon('tryAgain')}</Button>
      </StatusScreen>
    )
  }

  // The profile in memory is the one that sent the person here: it is dropped so that "/" reads it
  // again and sees an access that was given back
  const checkAgain = (): void => {
    queryClient.removeQueries({ queryKey: QueryKeys.session })
    router.push(AppPaths.home)
  }

  const suspendedStores = profile.data?.suspendedStores ?? []
  const actions = (
    <>
      <Button onClick={checkAgain}>{t('checkAgain')}</Button>
      <SignOutButton />
    </>
  )
  if (suspendedStores.length > 0) {
    const stores = format.list(suspendedStores.map(store => store.storeName))
    return (
      <StatusScreen icon={UserX} title={t('suspendedTitle')} body={t('suspendedBody', { stores })}>
        {actions}
      </StatusScreen>
    )
  }
  // An account with a store that opened a page or a store it has no access to is told that, and is
  // offered the way back; only an account with no store at all gets the "no store" text
  if ((profile.data?.memberships.length ?? 0) > 0) {
    return (
      <StatusScreen icon={ShieldOff} title={t('hereTitle')} body={t('hereBody')}>
        {/* The profile in memory is dropped first, as in "check again": "/" reads it anew */}
        <Button onClick={checkAgain}>{t('goToMyStore')}</Button>
        <SignOutButton />
      </StatusScreen>
    )
  }
  return (
    <StatusScreen icon={ShieldOff} title={t('title')} body={t('body')}>
      {actions}
    </StatusScreen>
  )
}
