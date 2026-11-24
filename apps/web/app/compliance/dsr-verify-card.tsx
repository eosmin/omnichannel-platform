'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  DSR_VERIFY_FRAGMENT_KEY,
  DSR_VERIFY_TOKEN_PATTERN,
  verifyDsrRequest
} from '@platform/api-client'
import { ClientErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'

type Step = 'ask' | 'working' | 'done' | 'invalid' | 'failed' | 'tooMany'

// The token is in the fragment of the address (#token=...), which the browser never sends to a server and never puts in a Referer. It is read
// when the person presses the button and taken out of the address bar and the history once it was used. NOTHING happens on opening the page:
// a mail scanner or an antivirus that opens the link must not spend the one use of the token, so the confirmation is a POST that only this
// button sends. What the page says does not depend on why a token does not hold (unknown, used, expired, a request that was closed): the api
// answers all of them alike, and so does the page.
export function DsrVerifyCard(): ReactElement {
  const t = useTranslations('dsrVerify')
  const [step, setStep] = useState<Step>('ask')
  const [token, setToken] = useState<string | null>(null)
  // The fragment is read after the first render (the server has none): until then the page shows no button, so a link with no token never
  // flashes one that does nothing
  const [read, setRead] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const alert = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get(DSR_VERIFY_FRAGMENT_KEY)
    const usable = found !== null && DSR_VERIFY_TOKEN_PATTERN.test(found) ? found : null
    setToken(usable)
    if (usable === null) setStep('invalid')
    setRead(true)
  }, [])

  // The result is announced to a screen reader, and the focus goes to it: the button that was pressed is gone. After a failure the button stays,
  // and the focus goes to the message so it is read out and the keyboard is not left on a control that changed its label
  useEffect(() => {
    if (step === 'done') heading.current?.focus()
    else if (step === 'failed' || step === 'tooMany') alert.current?.focus()
  }, [step])

  const confirm = (): void => {
    // `aria-disabled` and not `disabled` while it works (a disabled button throws the keyboard focus away), so a second press is ignored here
    if (token === null || step === 'working') return
    setStep('working')
    verifyDsrRequest(apiClient, token).then(
      () => {
        window.history.replaceState(null, '', window.location.pathname)
        setStep('done')
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === HttpStatusCodes.TOO_MANY_REQUESTS) {
          setStep('tooMany')
        } else if (
          error instanceof ApiError &&
          (error.code === ClientErrorCodes.DSR_VERIFICATION_INVALID ||
            error.code === ClientErrorCodes.VALIDATION_FAILED)
        ) {
          // The token was spent or is not good (the api's one refusal, or a token it cannot read): the address no longer says anything useful,
          // and a second press would be refused again. Any other 400 (a gateway, say) is a failure the person may try again
          window.history.replaceState(null, '', window.location.pathname)
          setToken(null)
          setStep('invalid')
        } else {
          setStep('failed')
        }
      }
    )
  }

  if (step === 'done') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {t('doneTitle')}
        </h1>
        <p className="text-muted-foreground">{t('done')}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('heading')}</h1>
      <p className="text-muted-foreground">{t('body')}</p>
      {step === 'invalid' || step === 'failed' || step === 'tooMany' ? (
        <p
          ref={alert}
          tabIndex={step === 'invalid' ? undefined : -1}
          role="alert"
          className="text-destructive outline-none"
        >
          {t(step)}
        </p>
      ) : null}
      {!read || step === 'invalid' ? null : (
        <Button
          type="button"
          onClick={confirm}
          aria-disabled={step === 'working'}
          className={step === 'working' ? 'opacity-70' : ''}
        >
          {step === 'working'
            ? t('working')
            : step === 'failed' || step === 'tooMany'
              ? t('retry')
              : t('confirm')}
        </Button>
      )}
    </div>
  )
}
