'use client'

import { useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { ApiError, AppPaths } from '@platform/api-client'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'

import { Button } from '../../components/ui/button'
import { browserSession } from '../../lib/api'
import { errorCodeOf } from '../../lib/error-message'

const TOKEN_PARAM = 'token'

// The token is in the fragment of the address (#token=...), which the browser never sends to a
// server. It is read once, taken out of the address bar and the history, and traded for a session:
// a link works once, so a second attempt (React runs effects twice in development) would fail.
export function VerifyMagicLink(): ReactElement {
  const t = useTranslations()
  const router = useRouter()
  const queryClient = useQueryClient()
  const started = useRef(false)
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null)

  useEffect(() => {
    if (started.current) return
    started.current = true
    const token = new URLSearchParams(window.location.hash.slice(1)).get(TOKEN_PARAM)
    const leaveNoTrace = (): void => window.history.replaceState(null, '', window.location.pathname)
    if (token === null) {
      leaveNoTrace()
      setErrorCode(ErrorCodes.AUTH_TOKEN_INVALID)
      return
    }
    browserSession.consume(token).then(
      () => {
        leaveNoTrace()
        // Whatever the page cached belongs to whoever was signed in before this link
        queryClient.clear()
        router.replace('/')
      },
      (error: unknown) => {
        // A link that never reached the server is still unused: keep it in the address for a reload
        if (!(error instanceof ApiError && error.status === 0)) leaveNoTrace()
        setErrorCode(errorCodeOf(error))
      }
    )
  }, [router, queryClient])

  if (errorCode === null) {
    return (
      <p role="status" className="text-muted-foreground text-center">
        {t('loginVerify.verifying')}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4" role="alert">
      <h1 className="text-2xl font-semibold">{t('loginVerify.failedTitle')}</h1>
      <p className="text-muted-foreground">{t(`errors.${errorCode}`)}</p>
      <Button asChild>
        <Link href={AppPaths.login}>{t('loginVerify.requestNew')}</Link>
      </Button>
    </div>
  )
}
