'use client'

import { Layers } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BankLineView } from '@platform/api-client'
import { BankStatementLimits } from '@platform/core/domain'

import { groupSelectionOf } from '../../lib/finance/bank-statement'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankBookCandidates, useConfirmBankGroup } from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

// ONE line of the statement against SEVERAL lines of the books of the same account (TDD_18 §4.4, HC-121): a deposit that groups three
// collections, or one net of a fee that was booked as an expense. The person chooses the lines and the sum is shown while they choose;
// Confirm waits until it is exact to the cent (the api checks the same rule and never leaves a residue). Taking the group back is one
// decision on the line, and it takes all the pieces back.
export function BankGroupDialog({
  line,
  onOpenChange
}: {
  line: BankLineView | null
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.group')
  return (
    <Dialog open={line !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="bank-group-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {line === null ? null : (
          <Chooser key={line.id} line={line} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Chooser({ line, onDone }: { line: BankLineView; onDone: () => void }): ReactElement {
  const t = useTranslations('finance.reconciliation.group')
  const errorText = useBankErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const candidates = useBankBookCandidates(storeId, line.id)
  const confirm = useConfirmBankGroup(storeId)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  if (candidates.data === undefined) {
    return candidates.isError ? (
      <LoadFailed error={candidates.error} onRetry={() => void candidates.refetch()} />
    ) : (
      <PageLoading />
    )
  }
  const { items, hasMore } = candidates.data
  const picked = groupSelectionOf(line.amountCents, items, selected)
  const toggle = (id: string, on: boolean): void =>
    setSelected(current => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  // Awaited here and not given to `mutate`: the answer is told even when the dialog was closed while the request was on its way
  const submit = async (): Promise<void> => {
    try {
      await confirm.mutateAsync({ lineId: line.id, journalLineIds: picked.journalLineIds })
      toast.success(t('confirmed'))
      onDone()
    } catch (error) {
      // The conflicts (the sum, a line matched in the same moment) have a sentence each; the dialog stays so the choice is not lost
      toast.error(errorText(error))
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm" data-testid="bank-group-line">
        {t('line', { date: line.postedOn, amount: money(line.amountCents) })}
      </p>
      <p className="text-muted-foreground text-xs">{t('feeHint')}</p>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-group-empty">
          {t('empty')}
        </p>
      ) : (
        <ul
          className="max-h-72 divide-y overflow-y-auto rounded-md border"
          aria-label={t('candidatesLabel')}
          data-testid="bank-group-candidates"
        >
          {items.map(item => {
            const checked = selected.has(item.journalLineId)
            return (
              <li key={item.journalLineId} data-entry={item.entryNumber}>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={checked}
                    disabled={confirm.isPending}
                    data-testid="bank-group-candidate"
                    onChange={event => toggle(item.journalLineId, event.target.checked)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium wrap-anywhere">
                      {t('entry', { number: item.entryNumber, date: item.entryDate })}
                    </span>
                    {item.memo === null && item.documentNumber === null ? null : (
                      <span className="text-muted-foreground text-xs wrap-anywhere">
                        {[item.documentNumber, item.memo].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums">{money(item.signedCents)}</span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {hasMore ? <p className="text-muted-foreground text-xs">{t('hasMore')}</p> : null}

      <dl
        className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border p-3 text-sm"
        aria-live="polite"
        data-testid="bank-group-sum"
        data-exact={picked.canConfirm ? 'true' : 'false'}
      >
        <dt className="text-muted-foreground">{t('statement')}</dt>
        <dd className="text-right tabular-nums">{money(line.amountCents)}</dd>
        <dt className="text-muted-foreground">{t('chosen', { count: picked.chosen })}</dt>
        <dd className="text-right tabular-nums">{money(picked.sumCents)}</dd>
        <dt className="font-medium">{t('difference')}</dt>
        <dd className="text-right font-medium tabular-nums" data-testid="bank-group-difference">
          {money(picked.differenceCents)}
        </dd>
      </dl>
      <p
        className={picked.canConfirm ? 'text-sm' : 'text-muted-foreground text-xs'}
        data-testid="bank-group-status"
      >
        {picked.tooMany
          ? t('tooMany', { max: BankStatementLimits.MAX_GROUP })
          : picked.canConfirm
            ? t('exact')
            : picked.chosen < BankStatementLimits.MIN_GROUP
              ? t('needTwo')
              : picked.differenceCents > 0
                ? t('missing', { amount: money(picked.differenceCents) })
                : t('over', { amount: money(-picked.differenceCents) })}
      </p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={confirm.isPending} onClick={onDone}>
          {t('cancel')}
        </Button>
        <Button
          type="button"
          disabled={!picked.canConfirm || confirm.isPending}
          busy={confirm.isPending}
          data-testid="bank-group-confirm"
          onClick={() => void submit()}
        >
          <Layers aria-hidden />
          {t('confirm')}
        </Button>
      </div>
    </div>
  )
}
