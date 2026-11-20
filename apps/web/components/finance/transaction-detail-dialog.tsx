'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, type ReactNode, useRef, useState } from 'react'

import type {
  FinanceAccountView,
  FinanceTaxRateView,
  FinanceTransactionView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { accountLabelsOf } from '../../lib/finance/account-form'
import { permissionOfKind } from '../../lib/finance/transaction-form'
import {
  useFinanceEntry,
  useFinanceReceiptUpload,
  useFinanceReceiptUrls,
  useFinanceTransaction,
  useVoidFinanceTransaction
} from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'
import { useReceiptErrorText } from '../../lib/finance/use-receipt-error-text'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  stickyDialogActionsClass
} from '../ui/dialog'

import { EntryLines } from './entry-lines'
import { TextField } from './fields'
import { ReceiptFileField } from './receipt-file-field'
import { TransactionFormDialog } from './transaction-form-dialog'

// One transaction with its entry and its receipt (TDD_18 §4.3). Who holds the permission of its kind may void it, replace it, or attach
// the receipt once; a voided transaction stays in the books, marked, and nothing more can be done to it.
export function TransactionDetailDialog({
  transactionId,
  accounts,
  rates,
  rounding,
  onOpenChange
}: {
  transactionId: string | null
  accounts: readonly FinanceAccountView[]
  rates: readonly FinanceTaxRateView[]
  rounding: string
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { storeId } = useStore()
  // The last id is kept while the dialog closes, so the content does not flip to loading during the animation
  const lastId = useRef(transactionId)
  if (transactionId !== null) lastId.current = transactionId
  const transaction = useFinanceTransaction(storeId, transactionId ?? lastId.current)
  const t = useTranslations('finance.transactions.detail')
  return (
    <Dialog open={transactionId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {transaction.data === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>{t('loading')}</DialogDescription>
            </DialogHeader>
            {transaction.isError ? (
              <LoadFailed error={transaction.error} onRetry={() => void transaction.refetch()} />
            ) : (
              <PageLoading />
            )}
          </>
        ) : (
          <TransactionBody
            transaction={transaction.data}
            accounts={accounts}
            rates={rates}
            rounding={rounding}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function TransactionBody({
  transaction,
  accounts,
  rates,
  rounding,
  onClose
}: {
  transaction: FinanceTransactionView
  accounts: readonly FinanceAccountView[]
  rates: readonly FinanceTaxRateView[]
  rounding: string
  onClose: () => void
}): ReactElement {
  const t = useTranslations('finance.transactions')
  const money = useMoney()
  const { storeId, can } = useStore()
  const entry = useFinanceEntry(storeId, transaction.entryId)
  const [voiding, setVoiding] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const label = accountLabelsOf(accounts)
  const mayWrite = can(permissionOfKind(transaction.kind))
  const mayChange = mayWrite && !transaction.voided
  const rate = rates.find(candidate => candidate.id === transaction.taxRateId)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('detail.title')}</DialogTitle>
        <DialogDescription>
          {t('detail.description', {
            kind: t(`kinds.${transaction.kind as 'expense'}`),
            date: transaction.occurredOn
          })}
        </DialogDescription>
      </DialogHeader>
      <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="finance-transaction-detail">
        <Fact label={t('detail.amount')}>{money(transaction.amountCents)}</Fact>
        <Fact label={t('detail.status')}>
          {transaction.voided ? t('detail.voided') : t('detail.active')}
        </Fact>
        {transaction.fromAccountId === null ? null : (
          <Fact label={t('detail.from')}>{label(transaction.fromAccountId)}</Fact>
        )}
        {transaction.toAccountId === null ? null : (
          <Fact label={t('detail.to')}>{label(transaction.toAccountId)}</Fact>
        )}
        {transaction.categoryAccountId === null ? null : (
          <Fact label={t('detail.category')}>{label(transaction.categoryAccountId)}</Fact>
        )}
        {transaction.taxCents > 0 ? (
          <Fact label={t('detail.tax')}>
            {money(transaction.taxCents)}
            {rate === undefined ? '' : ` · ${rate.name}`}
          </Fact>
        ) : null}
        {transaction.documentNumber === null ? null : (
          <Fact label={t('detail.document')}>{transaction.documentNumber}</Fact>
        )}
        {transaction.memo === null ? null : (
          <Fact label={t('detail.memo')}>{transaction.memo}</Fact>
        )}
      </dl>
      {transaction.replacesTransactionId === null ? null : (
        <p className="text-muted-foreground text-sm">{t('detail.replaces')}</p>
      )}
      <ReceiptPanel transaction={transaction} />
      {entry.data === undefined ? null : (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">
            {t('detail.entry')} · {t('detail.entryNumber', { number: entry.data.number })}
          </h3>
          <EntryLines lines={entry.data.lines} accounts={accounts} />
        </section>
      )}
      {voiding ? (
        <VoidForm transaction={transaction} onDone={onClose} onCancel={() => setVoiding(false)} />
      ) : (
        <div className={`${stickyDialogActionsClass} flex flex-wrap justify-end gap-2`}>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('detail.close')}
          </Button>
          {mayChange ? (
            <>
              <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
                {t('replace.action')}
              </Button>
              <Button type="button" variant="destructive" onClick={() => setVoiding(true)}>
                {t('void.action')}
              </Button>
            </>
          ) : null}
        </div>
      )}
      {/* Mounted for who may write, voided or not: replacing voids the transaction, and its receipt travels after that */}
      {mayWrite ? (
        <TransactionFormDialog
          replace={replacing ? transaction : null}
          kinds={[transaction.kind]}
          accounts={accounts}
          rates={rates}
          rounding={rounding}
          open={replacing}
          onOpenChange={setReplacing}
          onSaved={onClose}
        />
      ) : null}
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

// The receipt: a link to the file once it is attached (its signed links are asked now and expire), or, for who may register this kind
// of transaction, the way to attach one. It is set once: the books are never edited, so another file is another transaction.
function ReceiptPanel({ transaction }: { transaction: FinanceTransactionView }): ReactElement {
  const t = useTranslations('finance.transactions.receipt')
  const errorText = useReceiptErrorText()
  const { storeId, can } = useStore()
  const hasReceipt = transaction.documentMediaId !== null
  const urls = useFinanceReceiptUrls(storeId, transaction.id, hasReceipt)
  const upload = useFinanceReceiptUpload(storeId)
  // Held until the person says so: the receipt is set once and cannot be changed
  const [file, setFile] = useState<File | null>(null)
  const mayAttach =
    !hasReceipt &&
    !transaction.voided &&
    can(permissionOfKind(transaction.kind)) &&
    can(ClientPermissions.MEDIA_UPLOAD)
  return (
    <section className="flex flex-col gap-1.5" data-testid="finance-receipt">
      {hasReceipt ? (
        <>
          <h3 className="text-sm font-medium">{t('title')}</h3>
          {urls.data === undefined ? (
            <p className="text-muted-foreground text-sm">
              {urls.isError ? t('loadFailed') : t('pending')}
            </p>
          ) : (
            <a
              href={urls.data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline"
            >
              {t('view')} ({urls.data.filename})
            </a>
          )}
        </>
      ) : mayAttach ? (
        <>
          <ReceiptFileField file={file} busy={upload.isPending} onChange={setFile} />
          {file === null ? null : (
            <div>
              <Button
                type="button"
                size="sm"
                disabled={upload.isPending}
                busy={upload.isPending}
                onClick={() =>
                  upload.mutate(
                    { transactionId: transaction.id, file },
                    { onSuccess: () => toast.success(t('attached')) }
                  )
                }
              >
                {t('attach')}
              </Button>
            </div>
          )}
          {upload.error === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {errorText(upload.error)}
            </p>
          )}
        </>
      ) : (
        <>
          <h3 className="text-sm font-medium">{t('title')}</h3>
          <p className="text-muted-foreground text-sm">{t('none')}</p>
        </>
      )}
    </section>
  )
}

function VoidForm({
  transaction,
  onDone,
  onCancel
}: {
  transaction: FinanceTransactionView
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('finance.transactions.void')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const run = useDestructiveAction()
  const voidIt = useVoidFinanceTransaction(storeId)
  const [reason, setReason] = useState('')
  const [wrong, setWrong] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const send = async (): Promise<void> => {
    if (!guard.enter()) return
    setSaving(true)
    try {
      await voidIt.mutateAsync({ id: transaction.id, reason: reason.trim() })
      toast.success(t('done'))
      onDone()
    } catch (error) {
      setRefusal(errorText(error))
    } finally {
      setSaving(false)
      guard.leave()
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (reason.trim() === '') {
      setWrong(true)
      return
    }
    run('VOID_FINANCE_TRANSACTION', {
      title: t('confirmTitle'),
      description: t('confirmDescription'),
      confirmLabel: t('confirm'),
      onConfirm: send
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('title')}>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <TextField
        label={t('reason')}
        value={reason}
        maxLength={500}
        disabled={saving}
        problem={wrong ? t('problems.reason') : null}
        onChange={value => {
          setReason(value)
          setWrong(false)
          setRefusal(null)
        }}
      />
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className={`${stickyDialogActionsClass} flex justify-end gap-2`}>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button type="submit" variant="destructive" disabled={saving} busy={saving}>
          {t('submit')}
        </Button>
      </div>
    </form>
  )
}
