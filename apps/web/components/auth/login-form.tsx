'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { requestMagicLink } from '@platform/api-client'
import type { ErrorCode } from '@platform/core/errors'

import { apiClient } from '../../lib/api'
import { errorCodeOf } from '../../lib/error-message'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type Step = { name: 'form'; errorCode: ErrorCode | null } | { name: 'sending' } | { name: 'sent' }

export function LoginForm(): ReactElement {
  const t = useTranslations()
  const [email, setEmail] = useState('')
  const [step, setStep] = useState<Step>({ name: 'form', errorCode: null })

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setStep({ name: 'sending' })
    try {
      await requestMagicLink(apiClient, email.trim())
      setStep({ name: 'sent' })
    } catch (error) {
      setStep({ name: 'form', errorCode: errorCodeOf(error) })
    }
  }

  if (step.name === 'sent') {
    return (
      <div className="flex flex-col gap-4" role="status">
        <h1 className="text-2xl font-semibold">{t('login.sentTitle')}</h1>
        <p className="text-muted-foreground">{t('login.sentBody', { email: email.trim() })}</p>
        <Button variant="outline" onClick={() => setStep({ name: 'form', errorCode: null })}>
          {t('login.useAnother')}
        </Button>
      </div>
    )
  }

  const sending = step.name === 'sending'
  const errorCode = step.name === 'form' ? step.errorCode : null
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        void submit(event)
      }}
    >
      <h1 className="text-2xl font-semibold">{t('login.title')}</h1>
      <p className="text-muted-foreground">{t('login.body')}</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t('login.emailLabel')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          aria-invalid={errorCode !== null}
          aria-describedby={errorCode === null ? undefined : 'login-error'}
          onChange={event => setEmail(event.target.value)}
        />
        {errorCode !== null && (
          <p id="login-error" role="alert" className="text-destructive text-sm">
            {t(`errors.${errorCode}`)}
          </p>
        )}
      </div>
      <Button type="submit" disabled={sending}>
        {sending ? t('login.sending') : t('login.submit')}
      </Button>
    </form>
  )
}
