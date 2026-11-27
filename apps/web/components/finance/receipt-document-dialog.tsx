'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { PurchaseOrderView, PurchaseReceiptView } from '@platform/api-client'
import { PURCHASE_ANNEX_EXCLUSIONS, type PurchaseAnnexExclusion } from '@platform/core/domain'

import {
  type DocumentDraft,
  documentInputOf,
  documentProblem,
  documentTouched,
  emptyDocumentDraft
} from '../../lib/finance/purchase-form'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useCompleteReceiptDocument } from '../../lib/finance/use-purchases'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField } from './fields'
import { PurchaseDocumentFields } from './purchase-document-fields'

// Completing the supplier's document of a receipt after the fact (D4b): the data the annex of purchases needs, or the mark that the annex
// leaves the receipt out (only a receipt that credits no tax: it has no document to declare). The money of the receipt is never touched.
export function ReceiptDocumentDialog({
  order,
  receipt,
  open,
  onOpenChange
}: {
  order: PurchaseOrderView
  receipt: PurchaseReceiptView
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.document')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('completeTitle')}</DialogTitle>
          <DialogDescription>{t('completeDescription')}</DialogDescription>
        </DialogHeader>
        {open ? (
          <CompleteForm order={order} receipt={receipt} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function CompleteForm({
  order,
  receipt,
  onDone
}: {
  order: PurchaseOrderView
  receipt: PurchaseReceiptView
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.document')
  const errorText = usePurchaseErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const complete = useCompleteReceiptDocument(storeId)
  const [draft, setDraft] = useState<DocumentDraft>(emptyDocumentDraft)
  const [leaveOut, setLeaveOut] = useState<PurchaseAnnexExclusion | ''>('')
  const [problem, setProblem] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // A receipt that credits the tax has a document to declare: only one that does not may be left out
  const mayLeaveOut = !receipt.taxCreditable

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const input = leaveOut === '' ? documentInputOf(draft) : undefined
    if (leaveOut === '' && (input === undefined || documentProblem(draft) !== null)) {
      setProblem(true)
      return
    }
    if (!guard.enter()) return
    complete.mutate(
      {
        id: order.id,
        receiptId: receipt.id,
        input:
          leaveOut === ''
            ? { fiscalDocument: input as NonNullable<typeof input> }
            : { annexExclusion: leaveOut }
      },
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

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3"
      aria-label={t('completeTitle')}
    >
      {mayLeaveOut ? (
        <SelectField
          label={t('leaveOut.label')}
          value={leaveOut}
          disabled={complete.isPending}
          hint={t('leaveOut.hint')}
          onChange={value => {
            setLeaveOut(PURCHASE_ANNEX_EXCLUSIONS.find(known => known === value) ?? '')
            setProblem(false)
            setRefusal(null)
          }}
        >
          <option value="">{t('leaveOut.none')}</option>
          {PURCHASE_ANNEX_EXCLUSIONS.map(reason => (
            <option key={reason} value={reason}>
              {t(`leaveOut.reasons.${reason}`)}
            </option>
          ))}
        </SelectField>
      ) : null}
      {leaveOut === '' ? (
        <PurchaseDocumentFields
          draft={draft}
          problem={problem ? documentProblem(draft) : null}
          disabled={complete.isPending}
          onChange={patch => {
            setDraft(current => ({ ...current, ...patch }))
            setProblem(false)
            setRefusal(null)
          }}
        />
      ) : null}
      {problem && !documentTouched(draft) ? (
        <p role="alert" className="text-destructive text-sm">
          {t('problems.empty')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={complete.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={complete.isPending}>
          {t('save')}
        </Button>
      </div>
    </form>
  )
}
