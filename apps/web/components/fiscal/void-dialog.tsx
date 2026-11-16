'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import type { FiscalDocumentView } from '@platform/api-client'
import { FiscalLimits } from '@platform/core/domain'

import { useMoney } from '../../lib/finance/use-money'
import { useVoidFiscalDocument } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { voidReasonProblem, type VoidReasonProblem } from '../../lib/fiscal/void-form'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { TextField } from '../finance/fields'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// Voids an accepted fiscal document (TDD_18 §8.3, HIGH tier). The effect is shown before anything is sent, the reason is written, and the
// action asks to be confirmed again: the invalidation goes to the authority through the provider and cannot be taken back.
export function VoidDialog({
  document,
  open,
  onOpenChange
}: {
  document: FiscalDocumentView
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.void')
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
          <VoidForm document={document} onBusy={setBusy} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function VoidForm({
  document,
  onBusy,
  onDone
}: {
  document: FiscalDocumentView
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.void')
  const money = useMoney()
  const errorText = useFiscalErrorText()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const voiding = useVoidFiscalDocument(storeId)
  const [reason, setReason] = useState('')
  const [wrong, setWrong] = useState<VoidReasonProblem | null>(null)
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
      await voiding.mutateAsync({ id: document.id, reason: reason.trim() })
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
    const problem = voidReasonProblem(reason)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    run('VOID_FISCAL_DOCUMENT', {
      title: t('confirmTitle', { number: document.sequenceNumber }),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <div
        className="bg-muted/50 flex flex-col gap-1 rounded-md border p-3 text-sm"
        data-testid="fiscal-void-effect"
      >
        <p className="font-medium">{t('effectTitle')}</p>
        <ul className="text-muted-foreground list-disc pl-5">
          <li>{t('effect.authority', { total: money(document.totalCents) })}</li>
          <li>{t('effect.consult')}</li>
          <li>{t('effect.irreversible')}</li>
          <li>{t('effect.replace')}</li>
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
