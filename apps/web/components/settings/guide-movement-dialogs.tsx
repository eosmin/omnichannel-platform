'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { CarrierChargeModel, CarrierGuideLimits } from '@platform/core/domain'

import { accountLabelsOf } from '../../lib/finance/account-form'
import { moneyAccountsOf } from '../../lib/finance/transaction-form'
import { useFinanceAccounts } from '../../lib/finance/use-finance'
import {
  type AdjustmentDraft,
  adjustmentBody,
  adjustmentProblems,
  AdjustmentProblems,
  EMPTY_ADJUSTMENT_DRAFT,
  EMPTY_PURCHASE_DRAFT,
  type PurchaseDraft,
  purchaseBody,
  PurchaseProblems,
  purchaseProblems,
  voidBody,
  voidNoteProblem
} from '../../lib/settings/carrier-guides-form'
import {
  useRecordAdjustment,
  useRecordPurchase,
  useVoidPurchase
} from '../../lib/settings/use-carrier-guides'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Label } from '../ui/label'

import { GuideField } from './guide-field'

// The three writes of the ledger a person makes (TDD_17 §4.18): a purchase of guides, an adjustment nobody else can know, and
// the void of a purchase. Each one only checks what it can before the request: the api decides.

interface DialogProps {
  connectionId: string
  connectionName: string
  onClose: () => void
}

export function GuidePurchaseDialog({
  connectionId,
  connectionName,
  chargeModel,
  onClose
}: DialogProps & { chargeModel: string }): ReactElement {
  const t = useTranslations('settings.carriers.guides.purchase')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const { can } = useStore()
  const record = useRecordPurchase(storeId, connectionId)
  // A prepaid connection's purchase is carried by the books: who may move money says which account it left (the default bank account otherwise)
  const carried = chargeModel === CarrierChargeModel.PREPAID
  const picksAccount = carried && can(ClientPermissions.FINANCE_MOVE_MONEY)
  const accounts = useFinanceAccounts(storeId, picksAccount)
  const moneyAccounts = moneyAccountsOf(accounts.data ?? [], [])
  const label = accountLabelsOf(accounts.data ?? [])
  const guard = useSubmitGuard()
  const id = useId()
  const [draft, setDraft] = useState<PurchaseDraft>(EMPTY_PURCHASE_DRAFT)
  const [showProblems, setShowProblems] = useState(false)
  const problems = purchaseProblems(draft)
  const set = (patch: Partial<PurchaseDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))
  const pending = record.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending || !guard.enter()) return
    if (problems.length > 0) {
      setShowProblems(true)
      guard.leave()
      return
    }
    record.mutate(purchaseBody(draft), {
      onSuccess: () => {
        toast.success(t('done'))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: connectionName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <GuideField
            id={`${id}-paid`}
            label={t('paid')}
            hint={t('paidHint')}
            value={draft.paidQuantity}
            onChange={value => set({ paidQuantity: value })}
            inputMode="numeric"
            invalid={
              showProblems &&
              (problems.includes(PurchaseProblems.PAID) || problems.includes(PurchaseProblems.NONE))
            }
            disabled={pending}
          />
          <GuideField
            id={`${id}-gift`}
            label={t('gift')}
            hint={t('giftHint')}
            value={draft.giftQuantity}
            onChange={value => set({ giftQuantity: value })}
            inputMode="numeric"
            invalid={
              showProblems &&
              (problems.includes(PurchaseProblems.GIFT) || problems.includes(PurchaseProblems.NONE))
            }
            disabled={pending}
          />
          <GuideField
            id={`${id}-cost`}
            label={t('cost')}
            hint={t('costHint')}
            value={draft.totalCost}
            onChange={value => set({ totalCost: value })}
            inputMode="decimal"
            invalid={showProblems && problems.includes(PurchaseProblems.COST)}
            disabled={pending}
          />
          {carried ? <p className="text-muted-foreground text-xs">{t('carriedHint')}</p> : null}
          {picksAccount ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-account`}>{t('paidFrom')}</Label>
              <select
                id={`${id}-account`}
                value={draft.paidFromAccountId}
                onChange={event => set({ paidFromAccountId: event.target.value })}
                disabled={pending || accounts.isPending}
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              >
                <option value="">{t('paidFromDefault')}</option>
                {moneyAccounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {label(account.id)}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">{t('paidFromHint')}</p>
            </div>
          ) : null}
          <GuideField
            id={`${id}-note`}
            label={t('note')}
            value={draft.note}
            onChange={value => set({ note: value })}
            max={CarrierGuideLimits.NOTE_MAX_LENGTH}
            invalid={showProblems && problems.includes(PurchaseProblems.NOTE)}
            disabled={pending}
          />
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <MutationError error={record.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending} busy={pending}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function GuideAdjustmentDialog({
  connectionId,
  connectionName,
  onClose
}: DialogProps): ReactElement {
  const t = useTranslations('settings.carriers.guides.adjustment')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const record = useRecordAdjustment(storeId, connectionId)
  const guard = useSubmitGuard()
  const id = useId()
  const [draft, setDraft] = useState<AdjustmentDraft>(EMPTY_ADJUSTMENT_DRAFT)
  const [showProblems, setShowProblems] = useState(false)
  const problems = adjustmentProblems(draft)
  const pending = record.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending || !guard.enter()) return
    if (problems.length > 0) {
      setShowProblems(true)
      guard.leave()
      return
    }
    record.mutate(adjustmentBody(draft), {
      onSuccess: () => {
        toast.success(t('done'))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: connectionName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <GuideField
            id={`${id}-guides`}
            label={t('guides')}
            hint={t('guidesHint')}
            value={draft.guides}
            onChange={value => setDraft(current => ({ ...current, guides: value }))}
            inputMode="numeric"
            invalid={showProblems && problems.includes(AdjustmentProblems.GUIDES)}
            disabled={pending}
          />
          <GuideField
            id={`${id}-note`}
            label={t('note')}
            value={draft.note}
            onChange={value => setDraft(current => ({ ...current, note: value }))}
            max={CarrierGuideLimits.NOTE_MAX_LENGTH}
            invalid={showProblems && problems.includes(AdjustmentProblems.NOTE)}
            disabled={pending}
          />
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <MutationError error={record.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={pending} busy={pending}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function GuideVoidDialog({
  connectionId,
  connectionName,
  movementId,
  onClose
}: DialogProps & { movementId: string }): ReactElement {
  const t = useTranslations('settings.carriers.guides.void')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const run = useVoidPurchase(storeId, connectionId)
  const guard = useSubmitGuard()
  const id = useId()
  const [note, setNote] = useState('')
  const [showProblem, setShowProblem] = useState(false)
  const problem = voidNoteProblem(note)
  const pending = run.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (pending || !guard.enter()) return
    if (problem) {
      setShowProblem(true)
      guard.leave()
      return
    }
    run.mutate(
      { movementId, body: voidBody(note) },
      {
        onSuccess: () => {
          toast.success(t('done'))
          onClose()
        },
        onSettled: guard.leave
      }
    )
  }

  return (
    <Dialog open onOpenChange={open => (open || pending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: connectionName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <GuideField
            id={`${id}-note`}
            label={t('note')}
            value={note}
            onChange={setNote}
            max={CarrierGuideLimits.NOTE_MAX_LENGTH}
            invalid={showProblem && problem}
            disabled={pending}
          />
          {showProblem && problem ? (
            <p role="alert" className="text-destructive text-sm">
              {t('problem')}
            </p>
          ) : null}
          <MutationError error={run.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={pending} busy={pending}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
