'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useState } from 'react'

import { ApiError, unsubscribeFromNotificationEmails } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'
import { UNSUBSCRIBE_TOKEN_PARAM } from '@platform/core/notifications'

import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'

type Step = 'ask' | 'working' | 'done' | 'invalid' | 'failed' | 'tooMany'

// The token is in the fragment of the address (#token=...), which the browser never sends to a server and never puts in a Referer. It is read
// when the person presses the button and taken out of the address bar and the history once it was used. NOTHING happens on opening the page:
// a mail scanner or an antivirus that opens the link must not switch anything off, so the change is a POST that only this button sends.
export function UnsubscribeCard(): ReactElement {
  const t = useTranslations('unsubscribe')
  const [step, setStep] = useState<Step>('ask')
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get(UNSUBSCRIBE_TOKEN_PARAM)
    setToken(found)
    if (found === null) setStep('invalid')
  }, [])

  const confirm = (): void => {
    if (token === null) return
    setStep('working')
    unsubscribeFromNotificationEmails(apiClient, token).then(
      () => {
        window.history.replaceState(null, '', window.location.pathname)
        setStep('done')
      },
      (error: unknown) => {
        setStep(
          error instanceof ApiError && error.status === HttpStatusCodes.TOO_MANY_REQUESTS
            ? 'tooMany'
            : 'failed'
        )
      }
    )
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <h1 className="text-2xl font-semibold">{t('doneTitle')}</h1>
        <p className="text-muted-foreground">{t('done')}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('heading')}</h1>
      <p className="text-muted-foreground">{t('body')}</p>
      {step === 'invalid' || step === 'failed' || step === 'tooMany' ? (
        <p role="alert" className="text-destructive">
          {t(step)}
        </p>
      ) : null}
      {step === 'invalid' ? null : (
        <Button type="button" onClick={confirm} disabled={step === 'working'}>
          {step === 'working' ? t('working') : t('confirm')}
        </Button>
      )}
    </div>
  )
}
