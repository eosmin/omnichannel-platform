'use client'

import { useTranslations } from 'next-intl'
import { useState, type ReactElement } from 'react'

import type { BankLineView, FinanceAccountView } from '@platform/api-client'

import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankRegisterDraft } from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { useStore } from '../providers/store-context'
import { PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// What a statement line that no entry explains would be as a transaction (TDD_18 §4.4): the kind, the day, the amount and the accounts
// the api prefilled from the line. Reading it posts nothing and the dialog only shows it: the transaction itself is registered from the
// journal, with the same fields.
export function BankRegisterDraftDialog({
  line,
  accounts,
  onOpenChange
}: {
  line: BankLineView | null
  accounts: readonly FinanceAccountView[]
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.draft')
  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="bank-draft-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {line === null ? null : <Draft line={line} accounts={accounts} />}
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Draft({
  line,
  accounts
}: {
  line: BankLineView
  accounts: readonly FinanceAccountView[]
}): ReactElement {
  const t = useTranslations('finance.reconciliation.draft')
  const errorText = useBankErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  // The bank's text is not copied into the memo unless the person asks for it
  const [useDescription, setUseDescription] = useState(false)
  const draft = useBankRegisterDraft(storeId, line.id, useDescription)
  if (draft.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {errorText(draft.error)}
      </p>
    )
  }
  if (draft.data === undefined) return <PageLoading />
  const nameOf = (id: string | undefined): string | null => {
    if (id === undefined) return null
    const account = accounts.find(candidate => candidate.id === id)
    return account === undefined ? null : `${account.code} ${account.name}`
  }
  const rows: [string, string | null][] = [
    [t('kind'), t(`kinds.${draft.data.kind}` as 'kinds.expense')],
    [t('date'), draft.data.occurredOn],
    [t('amount'), money(draft.data.amountCents)],
    [t('from'), nameOf(draft.data.fromAccountId)],
    [t('to'), nameOf(draft.data.toAccountId)],
    [t('document'), draft.data.documentNumber ?? null],
    [t('memo'), draft.data.memo ?? null]
  ]
  const canUseDescription = line.description !== null && line.description !== ''
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="bank-draft">
        {rows.flatMap(([label, value]) =>
          value === null
            ? []
            : [
                <dt key={`${label}-t`} className="text-muted-foreground">
                  {label}
                </dt>,
                <dd key={`${label}-d`} className="break-words">
                  {value}
                </dd>
              ]
        )}
      </dl>
      {canUseDescription && !useDescription ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="bank-draft-use-memo"
          onClick={() => setUseDescription(true)}
        >
          {t('useAsMemo')}
        </Button>
      ) : null}
    </div>
  )
}
