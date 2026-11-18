'use client'

import { Check, FilePlus, Layers, Undo2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BankLineView, BankSuggestionView } from '@platform/api-client'

import {
  LineStates,
  lineStateOf,
  reasonsOf,
  SuggestionReasons
} from '../../lib/finance/bank-statement'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import {
  useConfirmBankMatch,
  useRejectBankMatch,
  useUndoBankMatch
} from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { BankConfirmDialog } from './bank-confirm-dialog'
import { BankGroupDialog } from './bank-group-dialog'

// One line of the statement and what the person can decide about it (TDD_18 §4.4). Nothing here is automatic: a suggestion is a pair the
// rules found (the same amount to the cent, a date inside the window, a reference that agrees) and it counts only when the person
// confirms it. A confirmed pair can be taken back; a rejected suggestion cannot be brought back from this screen (the api does not list
// rejections), so rejecting asks first.
export function BankLineRow({
  line,
  onRegister
}: {
  line: BankLineView
  onRegister: (line: BankLineView) => void
}): ReactElement {
  const t = useTranslations('finance.reconciliation.lines')
  const errorText = useBankErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const undo = useUndoBankMatch(storeId)
  const confirm = useConfirmBankMatch(storeId)
  const reject = useRejectBankMatch(storeId)
  const state = lineStateOf(line)
  const [undoing, setUndoing] = useState(false)
  const [grouping, setGrouping] = useState(false)
  // One decision at a time for a line: two suggestions of it cannot be confirmed together. The answer is awaited here, in a component
  // that stays mounted, because the row of a decision leaves the list (or the filter) once the lines are read again.
  const busy = undo.isPending || confirm.isPending || reject.isPending
  const decide = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    try {
      await work()
      toast.success(done)
      return true
    } catch (error) {
      toast.error(errorText(error))
      return false
    }
  }
  return (
    <li
      data-testid="bank-line-row"
      data-line-no={line.lineNo}
      data-state={state}
      className="flex flex-col gap-3 px-4 py-3"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">
            {line.postedOn}
            {line.description === null ? null : (
              <span className="text-muted-foreground font-normal"> · {line.description}</span>
            )}
          </span>
          {line.reference === null ? null : (
            <span className="text-muted-foreground text-xs">
              {t('reference', { reference: line.reference })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-1">
          <span className="font-medium tabular-nums" data-testid="bank-line-amount">
            {money(line.amountCents)}
          </span>
          <span
            className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs wrap-normal whitespace-nowrap"
            data-testid="bank-line-state"
          >
            {t(`states.${state}`)}
          </span>
        </div>
      </div>

      {line.match === null ? null : (
        <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
          {line.group === null ? (
            <p className="text-sm" data-testid="bank-line-match">
              {t('matchedWith', { number: line.match.entryNumber, date: line.match.entryDate })}
            </p>
          ) : (
            <div className="flex min-w-0 flex-col gap-1" data-testid="bank-line-group-pieces">
              <p className="text-sm font-medium" data-testid="bank-line-match">
                {t('matchedWithGroup', { count: line.group.pieces.length })}
              </p>
              <ul className="flex flex-col gap-0.5" aria-label={t('groupPiecesLabel')}>
                {line.group.pieces.map(piece => (
                  <li
                    key={piece.matchId}
                    data-entry={piece.entryNumber}
                    className="text-muted-foreground flex justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 wrap-anywhere">
                      {t('entry', { number: piece.entryNumber, date: piece.entryDate })}
                    </span>
                    <span className="shrink-0 tabular-nums">{money(piece.signedCents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="bank-line-undo"
            onClick={() => setUndoing(true)}
          >
            <Undo2 aria-hidden />
            {line.group === null ? t('undo') : t('undoGroup')}
          </Button>
        </div>
      )}

      <BankConfirmDialog
        open={undoing}
        onOpenChange={setUndoing}
        title={line.group === null ? t('undoTitle') : t('undoGroupTitle')}
        description={line.group === null ? t('undoDescription') : t('undoGroupDescription')}
        confirmLabel={line.group === null ? t('undo') : t('undoGroup')}
        busy={undo.isPending}
        onConfirm={() => {
          const matchId = line.match?.id
          if (matchId === undefined) {
            setUndoing(false)
            return
          }
          void decide(() => undo.mutateAsync(matchId), t('undone')).then(() => setUndoing(false))
        }}
      />

      {line.match === null ? (
        <div className="flex sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="bank-line-group"
            onClick={() => setGrouping(true)}
          >
            <Layers aria-hidden />
            {t('group')}
          </Button>
        </div>
      ) : null}
      <BankGroupDialog line={grouping ? line : null} onOpenChange={setGrouping} />

      {state === LineStates.SUGGESTED ? (
        <ul className="flex flex-col gap-2" aria-label={t('suggestionsLabel')}>
          {line.suggestions.map(suggestion => (
            <SuggestionRow
              key={suggestion.bookLineId}
              suggestion={suggestion}
              busy={busy}
              rejecting={reject.isPending}
              onConfirm={() =>
                decide(
                  () =>
                    confirm.mutateAsync({ lineId: line.id, journalLineId: suggestion.bookLineId }),
                  t('confirmed')
                )
              }
              onReject={() =>
                decide(
                  () =>
                    reject.mutateAsync({ lineId: line.id, journalLineId: suggestion.bookLineId }),
                  t('rejected')
                )
              }
            />
          ))}
        </ul>
      ) : null}

      {state === LineStates.UNMATCHED ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-sm">{t('noSuggestions')}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="bank-line-register"
            onClick={() => onRegister(line)}
          >
            <FilePlus aria-hidden />
            {t('register')}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function SuggestionRow({
  suggestion,
  busy,
  rejecting: rejectPending,
  onConfirm,
  onReject
}: {
  suggestion: BankSuggestionView
  busy: boolean
  rejecting: boolean
  onConfirm: () => Promise<boolean>
  onReject: () => Promise<boolean>
}): ReactElement {
  const t = useTranslations('finance.reconciliation.lines')
  const reasons = useTranslations('finance.reconciliation.lines.reasons')
  const money = useMoney()
  const [rejecting, setRejecting] = useState(false)
  const pending = busy
  return (
    <li
      data-testid="bank-suggestion"
      data-entry={suggestion.entryNumber}
      data-exact={suggestion.exact ? 'true' : 'false'}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">
            {t('entry', { number: suggestion.entryNumber, date: suggestion.entryDate })}
          </span>
          {suggestion.memo === null ? null : (
            <span className="text-muted-foreground text-xs">{suggestion.memo}</span>
          )}
        </div>
        <span className="text-sm tabular-nums">{money(suggestion.signedCents)}</span>
      </div>
      <ul
        className="flex flex-wrap gap-1.5"
        aria-label={t('reasonsLabel')}
        data-testid="bank-reasons"
      >
        {reasonsOf(suggestion).map(item => (
          <li
            key={item.reason}
            data-reason={item.reason}
            className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs wrap-normal whitespace-nowrap"
          >
            {item.reason === SuggestionReasons.DAYS_APART
              ? reasons('daysApart', { days: item.days ?? 0 })
              : reasons(item.reason)}
          </li>
        ))}
        {suggestion.exact ? (
          <li
            data-reason="exact"
            className="bg-primary text-primary-foreground shrink-0 rounded-full px-2 py-0.5 text-xs wrap-normal whitespace-nowrap"
          >
            {reasons('exact')}
          </li>
        ) : null}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          data-testid="bank-suggestion-reject"
          onClick={() => setRejecting(true)}
          aria-label={t('rejectNamed', { number: suggestion.entryNumber })}
        >
          <X aria-hidden />
          {t('reject')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          data-testid="bank-suggestion-confirm"
          aria-label={t('confirmNamed', { number: suggestion.entryNumber })}
          onClick={() => void onConfirm()}
        >
          <Check aria-hidden />
          {t('confirm')}
        </Button>
      </div>
      <BankConfirmDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={t('rejectTitle', { number: suggestion.entryNumber })}
        description={t('rejectDescription')}
        confirmLabel={t('reject')}
        busy={rejectPending}
        onConfirm={() => void onReject().then(() => setRejecting(false))}
      />
    </li>
  )
}
