'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { FinanceGate } from '../../components/finance/finance-gate'
import { VatPanel } from '../../components/finance/vat-panel'

// Finance → VAT (TDD_18 §7): the tax of a range of days, month by month and by rate, and the file the api writes (and audits) for the
// tax office's accountant. The api asks finance:view to read it and finance:export besides to take the file, the only thing that
// permission hides here. It only reads: it never writes the books.
export function VatPage(): ReactElement {
  return <FinanceGate>{settings => <Vat lockedThrough={settings.lockedThrough} />}</FinanceGate>
}

function Vat({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.vat')
  return (
    <section className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <VatPanel lockedThrough={lockedThrough} />
    </section>
  )
}
