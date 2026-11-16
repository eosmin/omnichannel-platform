'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import type { FiscalDocumentView, FiscalIssuerView } from '@platform/api-client'
import { FiscalLimits } from '@platform/core/domain'

import {
  issuerChangeReasonProblem,
  type IssuerChangeReasonProblem
} from '../../lib/fiscal/issuer-change-form'
import { useConfirmFiscalIssuerChange, useFiscalIssuer } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { TextField } from '../finance/fields'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// A refused document that may be at the issuer it was made with, which was changed since (TDD_18 §8.3, HIGH tier). The api will not move it
// by itself: the same number could end up at two authorities. A person who checked with the authority of the first issuer, with the
// accountant, that it is NOT there says so, with the reason, and it is made again with the issuer as it is now. The effect is shown before
// anything is sent and the action asks to be confirmed again. The dialog knows no provider: it names the ids the api sent.
export function IssuerChangeDialog({
  document,
  open,
  onOpenChange
}: {
  document: FiscalDocumentView
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.issuerChange')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title', { number: document.sequenceNumber })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <IssuerChangeForm
            document={document}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function IssuerChangeForm({
  document,
  onBusy,
  onDone
}: {
  document: FiscalDocumentView
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.issuerChange')
  const tEnv = useTranslations('finance.fiscal.detail.environments')
  const errorText = useFiscalErrorText()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const issuer = useFiscalIssuer(storeId, true)
  const confirming = useConfirmFiscalIssuerChange(storeId)
  const [reason, setReason] = useState('')
  const [wrong, setWrong] = useState<IssuerChangeReasonProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setRefusal(null)
    setPending(true)
    try {
      await confirming.mutateAsync({ id: document.id, reason: reason.trim() })
      toast.success(t('done'))
      onDone()
    } catch (error) {
      setRefusal(errorText(error))
    } finally {
      setPending(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = issuerChangeReasonProblem(reason)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    run('CONFIRM_FISCAL_ISSUER_CHANGE', {
      title: t('confirmTitle', { number: document.sequenceNumber }),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  const now: FiscalIssuerView | null = issuer.data ?? null
  // The effect is shown before anything is sent: no issuer loaded (or none set up) means nothing to confirm against
  const ready = !issuer.isPending && !issuer.isError && now !== null
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div
        className="bg-muted/50 flex flex-col gap-2 rounded-md border p-3 text-sm"
        data-testid="fiscal-issuer-change-effect"
      >
        <p className="font-medium">{t('effectTitle')}</p>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-muted-foreground text-xs">{t('madeWith')}</dt>
            <dd className="break-words" data-testid="fiscal-issuer-change-from">
              {t('issuerLine', {
                provider: document.providerId,
                environment: tEnv(document.environment)
              })}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-muted-foreground text-xs">{t('now')}</dt>
            <dd className="break-words" data-testid="fiscal-issuer-change-to">
              {now === null
                ? issuer.isPending
                  ? t('nowLoading')
                  : issuer.isError
                    ? t('nowFailed')
                    : t('nowNone')
                : t('issuerLine', {
                    provider: now.providerId,
                    environment: tEnv(now.environment)
                  })}
            </dd>
          </div>
        </dl>
        <ul className="text-muted-foreground list-disc pl-5">
          <li>{t('effect.again')}</li>
          <li>{t('effect.number')}</li>
          <li>{t('effect.responsibility')}</li>
          <li>{t('effect.irreversible')}</li>
        </ul>
      </div>
      <TextField
        label={t('reason')}
        value={reason}
        maxLength={FiscalLimits.VOID_REASON_MAX_LENGTH}
        disabled={pending}
        problem={wrong === null ? null : t(`problems.${wrong}`)}
        onChange={value => {
          setReason(value)
          setWrong(null)
          setRefusal(null)
        }}
      />
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button type="submit" variant="destructive" disabled={pending || !ready}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
