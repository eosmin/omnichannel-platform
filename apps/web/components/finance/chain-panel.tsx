'use client'

import { ShieldCheck } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { knownChainReason } from '../../lib/finance/chain-reasons'
import { periodKeyOf } from '../../lib/finance/period-form'
import { useVerifyFinanceChain } from '../../lib/finance/use-finance-reports'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The check of the hash chain, on demand (TDD_18 §11): the verdict, the head the auditor compares with the last row of their file, and
// whether every head a closed month froze is still in the chain. Each check leaves an audit row, so it is a button and not a page load.
export function ChainPanel(): ReactElement {
  const t = useTranslations('finance.reports.chain')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const verify = useVerifyFinanceChain(storeId)
  const [refusal, setRefusal] = useState<string | null>(null)
  // The verdict is of the moment of the check: the books move after it, so the screen says when it was
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const format = useFormatter()
  const result = verify.data
  const found = result?.break ?? null
  const reason = found === null ? null : knownChainReason(found.reason)
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="finance-chain-title"
      data-testid="finance-chain"
    >
      <header className="flex flex-col gap-1">
        <h2 id="finance-chain-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={verify.isPending}
          busy={verify.isPending}
          onClick={() => {
            setRefusal(null)
            verify.mutate(undefined, {
              onSuccess: () => setCheckedAt(new Date()),
              onError: error => setRefusal(errorText(error))
            })
          }}
        >
          <ShieldCheck aria-hidden />
          {t('verify')}
        </Button>
      </div>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      {result === undefined ? null : (
        <div
          className="flex flex-col gap-2 rounded-md border p-3 text-sm"
          data-testid="finance-chain-result"
        >
          <p
            role={result.ok ? 'status' : 'alert'}
            className={result.ok ? 'font-medium' : 'text-destructive font-medium'}
            data-testid="finance-chain-verdict"
          >
            {result.ok ? t('ok', { count: result.entriesChecked }) : t('broken')}
          </p>
          {checkedAt === null ? null : (
            <p className="text-muted-foreground" data-testid="finance-chain-checked-at">
              {t('checkedAt', {
                time: format.dateTime(checkedAt, { dateStyle: 'medium', timeStyle: 'medium' })
              })}
            </p>
          )}
          {result.break === null ? null : (
            <p>
              {t('breakAt', { number: result.break.number })}{' '}
              {reason === null ? t('reasons.unknown') : t(`reasons.${reason}`)}
            </p>
          )}
          {result.headNumber === null || result.headHash === null ? (
            <p className="text-muted-foreground">{t('noHead')}</p>
          ) : (
            <dl className="grid gap-1 sm:grid-cols-[auto_1fr] sm:gap-x-3">
              <dt className="text-muted-foreground">{t('headNumber')}</dt>
              <dd data-testid="finance-chain-head-number">{result.headNumber}</dd>
              <dt className="text-muted-foreground">{t('headHash')}</dt>
              <dd className="font-mono text-xs break-all" data-testid="finance-chain-head-hash">
                {result.headHash}
              </dd>
            </dl>
          )}
          {result.frozenHeads.length === 0 ? null : (
            <div>
              <p className="font-medium">{t('frozen')}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.frozenHeads.map(head => (
                  <li key={head.periodId} className={head.present ? '' : 'text-destructive'}>
                    {periodKeyOf(head)}: {head.present ? t('frozenPresent') : t('frozenMissing')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
