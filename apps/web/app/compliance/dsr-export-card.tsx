'use client'

import { Check, Copy } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import {
  ApiError,
  DSR_EXPORT_FRAGMENT_KEY,
  DSR_VERIFY_TOKEN_PATTERN,
  downloadDsrExport,
  type DsrExportDownloadResult
} from '@platform/api-client'
import { ClientErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'

type Step = 'ask' | 'working' | 'done' | 'invalid' | 'failed' | 'tooMany'
type CopyState = 'idle' | 'copied' | 'failed'

const MS_PER_SECOND = 1000
// The longest delay a browser timer holds (2^31 - 1 ms): a larger one fires at once
const MAX_TIMER_MS = 2_147_483_647

// The token is in the fragment of the address (#token=...), which the browser never sends to a server and never puts in a Referer. NOTHING
// happens on opening the page: a mail scanner that opens the link must not spend its single use, so the exchange is a POST that only the
// button sends. The signed link to the file and the password of the ZIP live in memory only (state): never in the address, the storage or a
// log. The signed link stops being offered when its own lifetime ends, but the password stays on the page: the person needs it to open the
// file they already saved. What the page says for a token that does not hold does not depend on
// why (unknown, used, expired, a request that is not an export): the api answers all of them alike, and so does the page.
export function DsrExportCard(): ReactElement {
  const t = useTranslations('dsrExport')
  const [step, setStep] = useState<Step>('ask')
  const [token, setToken] = useState<string | null>(null)
  const [result, setResult] = useState<DsrExportDownloadResult | null>(null)
  const [copy, setCopy] = useState<CopyState>('idle')
  const [linkLive, setLinkLive] = useState(true)
  const started = useRef(false)
  // The fragment is read after the first render (the server has none): until then the page shows no button
  const [read, setRead] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const alert = useRef<HTMLParagraphElement>(null)
  const link = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get(DSR_EXPORT_FRAGMENT_KEY)
    const usable = found !== null && DSR_VERIFY_TOKEN_PATTERN.test(found) ? found : null
    setToken(usable)
    if (usable === null) setStep('invalid')
    setRead(true)
  }, [])

  // The result is announced and the focus goes to it: the button that was pressed is gone. After a failure the button stays and the message
  // takes the focus
  useEffect(() => {
    if (step === 'done') heading.current?.focus()
    else if (step === 'failed' || step === 'tooMany' || step === 'invalid') alert.current?.focus()
  }, [step])

  // The download starts by itself ONCE (a guard, so a repeated effect never starts a second one), and the link is withdrawn when the signed
  // address dies. The password stays: it opens the file the person already saved
  useEffect(() => {
    if (step !== 'done' || result === null) return
    if (!started.current) {
      started.current = true
      link.current?.click()
    }
    const timer = window.setTimeout(
      () => setLinkLive(false),
      Math.min(result.expiresInSeconds * MS_PER_SECOND, MAX_TIMER_MS)
    )
    return () => window.clearTimeout(timer)
  }, [step, result])

  const download = (): void => {
    // `aria-disabled` and not `disabled` while it works (a disabled button throws the keyboard focus away), so a second press is ignored here
    if (token === null || step === 'working') return
    setStep('working')
    downloadDsrExport(apiClient, token).then(
      answer => {
        // The token is spent: the address says nothing useful any more
        window.history.replaceState(null, '', window.location.pathname)
        setToken(null)
        setResult(answer)
        setStep('done')
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === HttpStatusCodes.TOO_MANY_REQUESTS) {
          setStep('tooMany')
        } else if (
          error instanceof ApiError &&
          (error.code === ClientErrorCodes.DSR_EXPORT_LINK_INVALID ||
            error.code === ClientErrorCodes.VALIDATION_FAILED)
        ) {
          // Not a link that holds (the api's one refusal, or a token it cannot read): a second press would be refused again. Any other 400
          // (a gateway, say) is a failure the person may try again; nothing was spent by it
          window.history.replaceState(null, '', window.location.pathname)
          setToken(null)
          setStep('invalid')
        } else {
          setStep('failed')
        }
      }
    )
  }

  const copyPassword = (): void => {
    const password = result?.password
    if (password === undefined) return
    // `navigator.clipboard` does not exist outside a secure context or in some webviews: that is a failure to say, not an exception
    if (typeof navigator.clipboard?.writeText !== 'function') {
      setCopy('failed')
      return
    }
    navigator.clipboard.writeText(password).then(
      () => setCopy('copied'),
      () => setCopy('failed')
    )
  }

  if (step === 'done' && result !== null) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {t('doneTitle')}
        </h1>
        <p className="text-muted-foreground">{t('done')}</p>
        {linkLive ? (
          <a
            ref={link}
            href={result.url}
            download={result.filename}
            rel="noreferrer noopener"
            className="text-primary underline"
          >
            {t('again')}
          </a>
        ) : (
          <p className="text-muted-foreground">{t('expired')}</p>
        )}
        {result.password === undefined ? null : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">{t('passwordHint')}</p>
            <p className="text-sm font-medium">{t('passwordLabel')}</p>
            <code
              translate="no"
              className="rounded-md border px-3 py-2 font-mono break-all select-all"
            >
              {result.password}
            </code>
            <Button type="button" variant="outline" onClick={copyPassword}>
              {copy === 'copied' ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              {copy === 'copied' ? t('copied') : t('copy')}
            </Button>
            {copy === 'idle' ? null : (
              <p role="status" className="text-muted-foreground text-sm">
                {copy === 'copied' ? t('copied') : t('copyFailed')}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('heading')}</h1>
      <p className="text-muted-foreground">{t('body')}</p>
      {step === 'invalid' || step === 'failed' || step === 'tooMany' ? (
        <p ref={alert} tabIndex={-1} role="alert" className="text-destructive outline-none">
          {t(step)}
        </p>
      ) : null}
      {!read || step === 'invalid' ? null : (
        <Button
          type="button"
          onClick={download}
          aria-disabled={step === 'working'}
          className={step === 'working' ? 'opacity-70' : ''}
        >
          {step === 'working'
            ? t('working')
            : step === 'failed' || step === 'tooMany'
              ? t('retry')
              : t('download')}
        </Button>
      )}
    </div>
  )
}
