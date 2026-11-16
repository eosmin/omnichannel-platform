'use client'

import { Upload } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BankImportView, FinanceAccountView } from '@platform/api-client'

import { useBankImport, useBankImports } from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'

import { BankImportDialog } from './bank-import-dialog'
import { BankStatementDetail } from './bank-statement-detail'

// The statements imported for the account (TDD_18 §4.4), the newest first, and the one the person opened. Importing opens the new one.
export function BankImportsPanel({
  accountId,
  accounts
}: {
  accountId: string
  accounts: readonly FinanceAccountView[]
}): ReactElement {
  const t = useTranslations('finance.reconciliation.imports')
  const money = useMoney()
  const { storeId } = useStore()
  const imports = useBankImports(storeId, accountId, true)
  const [importing, setImporting] = useState(false)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const opened = useBankImport(storeId, openedId)

  if (imports.isError) {
    return <LoadFailed error={imports.error} onRetry={() => void imports.refetch()} />
  }
  if (imports.data === undefined) return <PageLoading />

  return (
    <section className="flex flex-col gap-4" aria-labelledby="bank-imports-title">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="bank-imports-title" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <Button size="sm" onClick={() => setImporting(true)} data-testid="bank-import-open">
          <Upload aria-hidden />
          {t('import')}
        </Button>
      </header>
      {imports.data.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-imports-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="bank-imports">
          {imports.data.map((statement: BankImportView) => (
            <li
              key={statement.id}
              data-testid="bank-import-row"
              data-import={statement.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">
                  {t('range', { from: statement.firstDay, to: statement.lastDay })}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('lines', { count: statement.lineCount, added: statement.newLineCount })}
                  {statement.closingBalanceCents === null || statement.closingOn === null
                    ? ''
                    : ` · ${t('closing', {
                        amount: money(statement.closingBalanceCents),
                        date: statement.closingOn
                      })}`}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant={openedId === statement.id ? 'default' : 'outline'}
                aria-pressed={openedId === statement.id}
                onClick={() => setOpenedId(openedId === statement.id ? null : statement.id)}
              >
                {t('open')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {opened.isError ? (
        <LoadFailed error={opened.error} onRetry={() => void opened.refetch()} />
      ) : null}
      {openedId === null || opened.data === undefined ? null : (
        <BankStatementDetail key={opened.data.id} statement={opened.data} accounts={accounts} />
      )}
      <BankImportDialog
        accountId={accountId}
        open={importing}
        onOpenChange={setImporting}
        onImported={imported => setOpenedId(imported.id)}
      />
    </section>
  )
}
