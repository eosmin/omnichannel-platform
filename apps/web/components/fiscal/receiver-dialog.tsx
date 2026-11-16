'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import type { FiscalDocumentView, FiscalProviderView } from '@platform/api-client'
import { FiscalFieldLimits } from '@platform/core/domain'

import {
  type ReceiverDraft,
  type ReceiverField,
  ReceiverFields,
  type ReceiverProblem,
  emptyReceiverDraft,
  receiverPatchOf,
  receiverProblem
} from '../../lib/fiscal/receiver-form'
import { usePatchFiscalReceiver } from '../../lib/fiscal/use-fiscal'
import { useFiscalErrorText } from '../../lib/fiscal/use-fiscal-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { TextField } from '../finance/fields'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { AddressRowsField } from './address-rows-field'

// Fixes the receiver of a document that was refused or never sent (TDD_18 §8.3). What the document needs of its receiver is the
// provider's own rule, read from its manifest: the fields it asks for are marked. A field left empty stays as it is.
export function ReceiverDialog({
  document,
  provider,
  open,
  onOpenChange
}: {
  document: FiscalDocumentView
  provider: FiscalProviderView | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.receiver')
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
          <ReceiverForm
            document={document}
            provider={provider}
            onBusy={setBusy}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// What the manifest says the type of this document cannot be built without. A document never built has no type yet (the provider picks it
// when it builds), so nothing is marked for it: the rule is the provider's and it is not guessed here.
const requiredFieldsOf = (
  provider: FiscalProviderView | undefined,
  documentType: string
): readonly string[] =>
  provider?.manifest.documentTypes.find(type => type.id === documentType)?.requiredReceiverFields ??
  []

function ReceiverForm({
  document,
  provider,
  onBusy,
  onDone
}: {
  document: FiscalDocumentView
  provider: FiscalProviderView | undefined
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.fiscal.receiver')
  const errorText = useFiscalErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const patch = usePatchFiscalReceiver(storeId)
  const [draft, setDraft] = useState<ReceiverDraft>(emptyReceiverDraft)
  const [wrong, setWrong] = useState<ReceiverProblem | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const required = requiredFieldsOf(provider, document.documentType)

  useEffect(() => {
    onBusy(patch.isPending)
    return () => onBusy(false)
  }, [patch.isPending, onBusy])

  const set = (changes: Partial<ReceiverDraft>): void => {
    setDraft(current => ({ ...current, ...changes }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = receiverProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    patch.mutate(
      { id: document.id, changes: receiverPatchOf(draft) },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onDone()
        },
        onError: error => setRefusal(errorText(error)),
        onSettled: guard.leave
      }
    )
  }

  const addressProblem =
    wrong?.field === ReceiverFields.ADDRESS ? t(`problems.${wrong.kind}`) : null

  const textField = (field: Exclude<ReceiverField, 'address'>, max: number): ReactElement => (
    <TextField
      label={t(`fields.${field}`) + (required.includes(field) ? ` ${t('requiredMark')}` : '')}
      value={draft[field]}
      maxLength={max}
      disabled={patch.isPending}
      problem={wrong?.field === field ? t(`problems.${wrong.kind}`) : null}
      onChange={value => set({ [field]: value })}
    />
  )

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <p className="text-muted-foreground text-sm" data-testid="fiscal-receiver-current">
        {document.receiver.name === null && document.receiver.taxIdMasked === null
          ? t('currentNone')
          : t('current', {
              name: document.receiver.name ?? t('noName'),
              taxId: document.receiver.taxIdMasked ?? t('noTaxId')
            })}
      </p>
      {required.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">{t('requiredHint')}</p>
      )}
      {textField(ReceiverFields.NAME, FiscalFieldLimits.NAME)}
      {textField(ReceiverFields.TAX_ID, FiscalFieldLimits.TAX_ID)}
      {textField(ReceiverFields.REGISTRATION_ID, FiscalFieldLimits.REGISTRATION_ID)}
      {textField(ReceiverFields.EMAIL, FiscalFieldLimits.EMAIL)}
      {textField(ReceiverFields.PHONE, FiscalFieldLimits.PHONE)}
      <AddressRowsField
        rows={draft.address}
        onChange={address => set({ address })}
        disabled={patch.isPending}
        hint={t('addressHint')}
        required={required.includes(ReceiverFields.ADDRESS)}
        problem={addressProblem}
      />
      {wrong?.kind === 'nothing' ? (
        <p role="alert" className="text-destructive text-sm">
          {t('problems.nothing')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={patch.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={patch.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
