'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { FiscalGate } from '../../components/fiscal/fiscal-gate'
import { IssuerForm } from '../../components/fiscal/issuer-form'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { useFiscalIssuer, useFiscalProviders } from '../../lib/fiscal/use-fiscal'

// Finance → Fiscal issuer (TDD_18 §8.2): the legal entity the fiscal documents are made in the name of, and the provider that makes them.
// Read with fiscal:view and changed with fiscal:manage. Without an issuer the organization issues no document.
export function FiscalIssuerPage(): ReactElement {
  return <FiscalGate>{canManage => <Issuer canManage={canManage} />}</FiscalGate>
}

function Issuer({ canManage }: { canManage: boolean }): ReactElement {
  const t = useTranslations('finance.fiscal.issuer')
  const { storeId } = useStore()
  const providers = useFiscalProviders(storeId, true)
  const issuer = useFiscalIssuer(storeId, true)
  if (providers.isError) {
    return <LoadFailed error={providers.error} onRetry={() => void providers.refetch()} />
  }
  if (issuer.isError) {
    return <LoadFailed error={issuer.error} onRetry={() => void issuer.refetch()} />
  }
  if (providers.data === undefined || issuer.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {providers.data.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="fiscal-no-providers">
          {t('noProviders')}
        </p>
      ) : (
        <IssuerForm
          // A saved issuer is a new starting point: the form begins again from what the api now has
          key={issuer.data?.updatedAt ?? 'new'}
          providers={providers.data}
          issuer={issuer.data}
          canManage={canManage}
        />
      )}
    </section>
  )
}
