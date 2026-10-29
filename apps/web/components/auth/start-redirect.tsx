'use client'

import { TriangleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect } from 'react'

import { ApiError, AppPaths } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { readLastStoreId } from '../../lib/last-store'
import { chooseStartPath } from '../../lib/start-path'
import { useProfile } from '../../lib/use-profile'
import { StatusScreen } from '../shared/status-screen'
import { LoadingScreen } from '../shell/session-gate'
import { Button } from '../ui/button'

// "/" has no content: it reads the profile (which also trades the cookie for an access token) and
// goes to the store the person used last
export function StartRedirect(): ReactElement {
  const t = useTranslations()
  const router = useRouter()
  const profile = useProfile()

  const target =
    profile.data === undefined ? null : chooseStartPath(profile.data.memberships, readLastStoreId())
  const unauthorized =
    profile.error instanceof ApiError && profile.error.status === HttpStatusCodes.UNAUTHORIZED

  useEffect(() => {
    if (target !== null) router.replace(target)
    else if (unauthorized) router.replace(AppPaths.login)
  }, [target, unauthorized, router])

  if (profile.isError && !unauthorized) {
    return (
      <StatusScreen icon={TriangleAlert} title={t('errorPage.title')} body={t('errorPage.body')}>
        <Button onClick={() => void profile.refetch()}>{t('common.tryAgain')}</Button>
      </StatusScreen>
    )
  }
  return <LoadingScreen />
}
