'use client'

import { Loader2, TriangleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { type AccountProfile, ApiError, AppPaths } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { useProfile } from '../../lib/use-profile'
import { StatusScreen } from '../shared/status-screen'
import { Button } from '../ui/button'

export function LoadingScreen(): ReactElement {
  const t = useTranslations()
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <Loader2 aria-hidden className="text-muted-foreground size-6 animate-spin" />
      <span className="sr-only" role="status">
        {t('common.loading')}
      </span>
    </main>
  )
}

// What every signed-in area shares: wait for the profile, send a person with no session to the
// login, offer a retry when the api failed, and only then draw the area
export function SessionGate({
  children
}: {
  children: (profile: AccountProfile) => ReactNode
}): ReactElement {
  const t = useTranslations()
  const router = useRouter()
  const profile = useProfile()
  const unauthorized =
    profile.error instanceof ApiError && profile.error.status === HttpStatusCodes.UNAUTHORIZED

  useEffect(() => {
    if (unauthorized) router.replace(AppPaths.login)
  }, [unauthorized, router])

  if (profile.data !== undefined) return <>{children(profile.data)}</>
  if (profile.isError && !unauthorized) {
    return (
      <StatusScreen icon={TriangleAlert} title={t('errorPage.title')} body={t('errorPage.body')}>
        <Button onClick={() => void profile.refetch()}>{t('common.tryAgain')}</Button>
      </StatusScreen>
    )
  }
  return <LoadingScreen />
}
