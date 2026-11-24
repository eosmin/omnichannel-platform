'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'

import {
  ApiError,
  DSR_PUBLIC_TYPES,
  DSR_REQUEST_FRAGMENT_KEY,
  DSR_REQUEST_KEY_MAX_LENGTH,
  DSR_REQUEST_KEY_MIN_LENGTH,
  type DsrPublicType,
  submitDsrRequest
} from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { Button } from '../../components/ui/button'
import { apiClient } from '../../lib/api'

type Step = 'ask' | 'working' | 'sent' | 'incomplete' | 'failed' | 'tooMany'

const emailSchema = z.email().max(254)

function isLocale(value: string): value is Locale {
  return SUPPORTED_LOCALES.some(locale => locale === value)
}

// The public form of data requests. The key of the store is in the fragment of the address (#key=...), which a browser never sends to a server
// and never puts in a Referer, so no log holds it. The page does not name the store: the key is all it has, and what it says never depends on
// who the address belongs to. The api answers the same 202 for an address that is a customer and for one that is not (the worker looks it up
// later and mails only the first), so the page has ONE sentence for it and branches on nothing but the status.
export function DsrRequestForm(): ReactElement {
  const t = useTranslations('dsrRequest')
  const rawLocale = useLocale()
  const ids = { email: useId(), type: useId(), error: useId() }
  const [step, setStep] = useState<Step>('ask')
  const [storeKey, setStoreKey] = useState<string | null>(null)
  // The fragment is read after the first render (the server has none): until then the page shows no form, so a link with no key never
  // flashes one that does nothing
  const [read, setRead] = useState(false)
  const [type, setType] = useState<DsrPublicType>(DSR_PUBLIC_TYPES[0])
  const [email, setEmail] = useState('')
  const [emailInvalid, setEmailInvalid] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const emailInput = useRef<HTMLInputElement>(null)
  const alert = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get(DSR_REQUEST_FRAGMENT_KEY)
    const usable =
      found !== null &&
      found.length >= DSR_REQUEST_KEY_MIN_LENGTH &&
      found.length <= DSR_REQUEST_KEY_MAX_LENGTH
        ? found
        : null
    setStoreKey(usable)
    if (usable === null) setStep('incomplete')
    setRead(true)
  }, [])

  // The focus goes where the news is: the result when it was sent (the form is gone), the message when it failed (the keyboard stays where
  // the person pressed, and the message is read out), the field when the address is not an address
  useEffect(() => {
    if (step === 'sent') heading.current?.focus()
    else if (step === 'failed' || step === 'tooMany') alert.current?.focus()
  }, [step])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    // `aria-disabled` and not `disabled` while it works: a disabled button throws the keyboard focus away
    if (step === 'working' || storeKey === null) return
    const clean = email.trim()
    if (!emailSchema.safeParse(clean.toLowerCase()).success) {
      setEmailInvalid(true)
      // Focused here and not in an effect: a second press with the same bad address must bring the person back to the field too
      emailInput.current?.focus()
      return
    }
    setEmailInvalid(false)
    setStep('working')
    submitDsrRequest(apiClient, {
      storeKey,
      type,
      email: clean,
      locale: isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE
    }).then(
      () => {
        window.history.replaceState(null, '', window.location.pathname)
        setStep('sent')
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === HttpStatusCodes.TOO_MANY_REQUESTS) {
          // No wait time is shown: the limit is per address and per store (and per day), and a number of minutes would tell which one was hit
          setStep('tooMany')
        } else {
          setStep('failed')
        }
      }
    )
  }

  if (step === 'sent') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {t('sentTitle')}
        </h1>
        <p className="text-muted-foreground">{t('sent')}</p>
      </div>
    )
  }
  if (step === 'incomplete') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t('heading')}</h1>
        <p role="alert" className="text-destructive">
          {t('incomplete')}
        </p>
      </div>
    )
  }
  const working = step === 'working'
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('heading')}</h1>
      <p className="text-muted-foreground">{t('body')}</p>
      {!read ? null : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.type} className="text-sm font-medium">
              {t('typeLabel')}
            </label>
            <select
              id={ids.type}
              value={type}
              onChange={event => {
                const chosen = DSR_PUBLIC_TYPES.find(kind => String(kind) === event.target.value)
                if (chosen !== undefined) setType(chosen)
              }}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              {DSR_PUBLIC_TYPES.map(kind => (
                <option key={kind} value={kind}>
                  {t(`types.${kind}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.email} className="text-sm font-medium">
              {t('emailLabel')}
            </label>
            <input
              ref={emailInput}
              id={ids.email}
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              maxLength={254}
              aria-invalid={emailInvalid}
              aria-describedby={emailInvalid ? ids.error : undefined}
              onChange={event => {
                setEmail(event.target.value)
                setEmailInvalid(false)
              }}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            />
            {emailInvalid ? (
              <p id={ids.error} className="text-destructive text-sm">
                {t('emailInvalid')}
              </p>
            ) : null}
          </div>
          {step === 'failed' || step === 'tooMany' ? (
            <p ref={alert} tabIndex={-1} role="alert" className="text-destructive outline-none">
              {step === 'tooMany' ? t('tooMany') : t('failed')}
            </p>
          ) : null}
          <Button type="submit" aria-disabled={working} className={working ? 'opacity-70' : ''}>
            {working ? t('working') : step === 'failed' ? t('retry') : t('submit')}
          </Button>
        </form>
      )}
    </div>
  )
}
