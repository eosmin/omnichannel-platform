'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { BookPanel } from '../../components/finance/book-panel'
import { FinanceGate } from '../../components/finance/finance-gate'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'

// Finance → Legal books (TDD_18 §7): the book of sales to taxpayers, of sales to final consumers and of purchases, one month at a time,
// with its file. **[ACCOUNTANT]** What the columns are, their order and the correlative are the accountant's call: until an accountant
// confirms the layout the book is a draft and says so (the api sends `unvalidated` with every book). A book lists the names and tax ids
// of suppliers, so the api asks for finance:view_reports AND finance:export to read one, and so does this page.
export function BooksPage(): ReactElement {
  return <FinanceGate>{() => <Books />}</FinanceGate>
}

function Books(): ReactElement {
  const t = useTranslations('finance.books')
  const { can } = useStore()
  if (!can(ClientPermissions.FINANCE_VIEW_REPORTS)) {
    return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW_REPORTS} />
  }
  if (!can(ClientPermissions.FINANCE_EXPORT)) {
    return <PermissionDenied permission={ClientPermissions.FINANCE_EXPORT} />
  }
  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <BookPanel />
    </section>
  )
}
