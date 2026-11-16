'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinanceAccountView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import {
  ledgerCsvInputOf,
  ledgerFileName,
  ledgerQueryOf,
  type ReportRangeDraft,
  type ReportRangeProblem,
  reportRangeProblem
} from '../../lib/finance/report-form'
import { saveCsvFile } from '../../lib/finance/save-file'
import { useFinanceAccounts } from '../../lib/finance/use-finance'
import {
  type LedgerRange,
  useDownloadLedgerCsv,
  useFinanceLedger
} from '../../lib/finance/use-finance-reports'
import { useMoney } from '../../lib/finance/use-money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed } from '../settings/states'
import { Button } from '../ui/button'

import { SelectField, TextField } from './fields'

// The ledger of one account (TDD_18 §10): its lines in date order, with the balance after each. It pages by line; the first page says
// what the account held before it. The range may leave an end open here; the file needs both (the api asks for them).
export function LedgerPanel(): ReactElement {
  const t = useTranslations('finance.reports.ledger')
  const money = useMoney()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const accounts = useFinanceAccounts(storeId, true)
  // Only an account that takes entries has a ledger: a header only groups the others
  const postable = (accounts.data ?? []).filter((account: FinanceAccountView) => account.isPostable)
  const [accountId, setAccountId] = useState('')
  const [draft, setDraft] = useState<ReportRangeDraft>({ from: '', to: '' })
  const [wrong, setWrong] = useState<ReportRangeProblem | null>(null)
  const [applied, setApplied] = useState<LedgerRange | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const ledger = useFinanceLedger(storeId, applied, true)
  const download = useDownloadLedgerCsv(storeId)
  const guard = useSubmitGuard()
  const chosen = postable.find(account => account.id === accountId)
  const canExport = can(ClientPermissions.FINANCE_EXPORT)
  const csvProblem = reportRangeProblem(draft, { bothEnds: true })

  const show = (event: FormEvent): void => {
    event.preventDefault()
    const problem = reportRangeProblem(draft, { bothEnds: false })
    setWrong(problem)
    if (problem !== null || chosen === undefined) return
    setApplied(ledgerQueryOf(chosen.id, draft))
  }

  if (accounts.isError) {
    return <LoadFailed error={accounts.error} onRetry={() => void accounts.refetch()} />
  }
  const pages = ledger.data?.pages ?? []
  const first = pages[0]
  const lines = pages.flatMap(page => page.lines)
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="finance-ledger-title"
      data-testid="finance-ledger"
    >
      <header className="flex flex-col gap-1">
        <h2 id="finance-ledger-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <form
        onSubmit={show}
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        aria-label={t('formLabel')}
      >
        <div className="sm:col-span-2">
          <SelectField label={t('account')} value={accountId} onChange={setAccountId}>
            <option value="">{t('choose')}</option>
            {postable.map(account => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label={t('from')}
          hint={t('dayHint')}
          value={draft.from}
          maxLength={10}
          problem={
            wrong === 'from' ? t('problems.from') : wrong === 'order' ? t('problems.order') : null
          }
          onChange={from => {
            setDraft(current => ({ ...current, from }))
            setWrong(null)
          }}
        />
        <TextField
          label={t('to')}
          hint={t('dayHint')}
          value={draft.to}
          maxLength={10}
          problem={wrong === 'to' ? t('problems.to') : null}
          onChange={to => {
            setDraft(current => ({ ...current, to }))
            setWrong(null)
          }}
        />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" size="sm" disabled={chosen === undefined}>
            {t('show')}
          </Button>
          {canExport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={chosen === undefined || csvProblem !== null || download.isPending}
              busy={download.isPending}
              onClick={() => {
                if (chosen === undefined || !guard.enter()) return
                setRefusal(null)
                // The name is of the range that was asked, whatever the fields say when the file arrives
                const name = ledgerFileName(chosen.code, draft)
                download.mutate(ledgerCsvInputOf(chosen.id, draft), {
                  onSuccess: text => saveCsvFile(name, text),
                  onError: error => setRefusal(errorText(error)),
                  onSettled: guard.leave
                })
              }}
            >
              <Download aria-hidden />
              {t('download')}
            </Button>
          ) : null}
        </div>
        {canExport ? (
          <p className="text-muted-foreground text-xs sm:col-span-2">{t('downloadHint')}</p>
        ) : null}
      </form>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      {applied === null ? null : ledger.isError ? (
        <LoadFailed error={ledger.error} onRetry={() => void ledger.refetch()} />
      ) : first === undefined ? (
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      ) : (
        <>
          <p className="text-sm" data-testid="finance-ledger-opening">
            {t('opening', {
              account: `${first.account.code} ${first.account.name}`,
              amount: money(first.openingCents)
            })}
          </p>
          {lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">
                  {t('caption', { account: first.account.name })}
                </caption>
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.date')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.entry')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.memo')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.debit')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.credit')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.running')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(line => (
                    <tr
                      key={`${line.entryId}-${String(line.lineNo)}`}
                      className="border-b last:border-b-0"
                      data-testid="finance-ledger-line"
                    >
                      <td className="px-3 py-2 whitespace-nowrap">{line.entryDate}</td>
                      <td className="px-3 py-2 font-mono text-xs">{line.number}</td>
                      <td className="px-3 py-2">{line.lineMemo ?? line.entryMemo ?? ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(line.debitCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(line.creditCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(line.runningCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ledger.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={ledger.isFetchingNextPage}
                busy={ledger.isFetchingNextPage}
                onClick={() => void ledger.fetchNextPage()}
              >
                {t('more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
