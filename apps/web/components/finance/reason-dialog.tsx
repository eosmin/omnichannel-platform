'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import { type DestructiveAction, FinanceLimits } from '@platform/core/domain'

import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { TextField } from './fields'

// What a person is asked before a purchase is closed, cancelled or a payment voided: the reason, which is written in the audit log (and,
// for a payment, is the memo of the reversal in the books). A destructive action also asks to confirm, as its tier says (TDD_09 §11).
export interface ReasonDialogCopy {
  title: string
  description: string
  label: string
  submit: string
  // The confirmation of a destructive action, already translated
  confirm?: { title: string; description: string; confirmLabel: string }
}

export function ReasonDialog({
  copy,
  required,
  action,
  open,
  onOpenChange,
  onSubmit
}: {
  copy: ReasonDialogCopy
  required: boolean
  // The destructive action this is, when it is one: its tier decides how the confirmation is asked
  action?: DestructiveAction
  open: boolean
  onOpenChange: (open: boolean) => void
  // Rejects with the error to show; resolves when it is done
  onSubmit: (reason: string) => Promise<void>
}): ReactElement {
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
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {open ? (
          <ReasonForm
            copy={copy}
            required={required}
            action={action}
            onSubmit={onSubmit}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReasonForm({
  copy,
  required,
  action,
  onSubmit,
  onBusy,
  onDone
}: {
  copy: ReasonDialogCopy
  required: boolean
  action?: DestructiveAction
  onSubmit: (reason: string) => Promise<void>
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.reason')
  const errorText = usePurchaseErrorText()
  const run = useDestructiveAction()
  const guard = useSubmitGuard()
  const [reason, setReason] = useState('')
  const [wrong, setWrong] = useState<'required' | 'tooLong' | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setPending(true)
    try {
      await onSubmit(reason.trim())
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
    const text = reason.trim()
    if (text.length > FinanceLimits.MEMO_MAX_LENGTH) {
      setWrong('tooLong')
      return
    }
    if (required && text === '') {
      setWrong('required')
      return
    }
    if (action !== undefined && copy.confirm !== undefined) {
      run(action, { ...copy.confirm, onConfirm: send })
      return
    }
    void send()
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={copy.title}>
      <TextField
        label={copy.label}
        value={reason}
        maxLength={FinanceLimits.MEMO_MAX_LENGTH}
        disabled={pending}
        problem={wrong === null ? null : t(wrong)}
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
        <Button
          type="submit"
          variant={action === undefined ? 'default' : 'destructive'}
          disabled={pending}
        >
          {copy.submit}
        </Button>
      </div>
    </form>
  )
}
