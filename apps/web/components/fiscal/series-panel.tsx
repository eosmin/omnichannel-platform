'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FiscalProviderView, FiscalSeriesView } from '@platform/api-client'
import { FiscalEnvironment, FiscalSeriesScopeKeys } from '@platform/core/domain'

import { useFiscalSeries } from '../../lib/fiscal/use-fiscal'
import { useStore } from '../providers/store-context'
import { LoadFailed } from '../settings/states'

// The keys a scope can carry that this screen has words for; any other key a provider declares is shown as it is named
const KNOWN_KEYS: readonly string[] = Object.values(FiscalSeriesScopeKeys)
type KnownKey = (typeof FiscalSeriesScopeKeys)[keyof typeof FiscalSeriesScopeKeys]
const isKnown = (key: string): key is KnownKey => KNOWN_KEYS.includes(key)
const isEnvironment = (value: string): value is FiscalEnvironment =>
  (Object.values(FiscalEnvironment) as string[]).includes(value)

// The series of correlatives of the organization (TDD_18 §8.2, Step 4B.7c-5): what each one counts (the provider, the environment and what
// the manifest declares: the type of document, the establishment, the point of sale) and the number the next document of it takes. Read only:
// the lifecycle of a document moves them.
export function SeriesPanel({
  providers
}: {
  providers: readonly FiscalProviderView[]
}): ReactElement {
  const t = useTranslations('finance.fiscal.series')
  const tEnvironment = useTranslations('finance.fiscal.issuer.environments')
  const { storeId } = useStore()
  const series = useFiscalSeries(storeId, true)
  if (series.isError && series.data === undefined) {
    return <LoadFailed error={series.error} onRetry={() => void series.refetch()} />
  }
  if (series.data === undefined)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t('loading')}
      </p>
    )

  // The words for a value of a scope: the label of a document type in the manifest of the provider of the series, the name of an environment
  const valueOf = (view: FiscalSeriesView, key: string, value: string): string => {
    if (key === FiscalSeriesScopeKeys.DOCUMENT_TYPE) {
      const provider = providers.find(
        candidate => candidate.id === view.scope[FiscalSeriesScopeKeys.PROVIDER]
      )
      return provider?.manifest.documentTypes.find(type => type.id === value)?.label ?? value
    }
    if (key === FiscalSeriesScopeKeys.ENVIRONMENT && isEnvironment(value)) {
      return tEnvironment(value)
    }
    return value
  }
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="fiscal-series-title"
      data-testid="fiscal-series"
    >
      <h2 id="fiscal-series-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      {series.data.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="fiscal-series-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {series.data.map(view => (
            <li
              key={JSON.stringify(view.scope)}
              className="flex flex-col gap-1 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              data-testid="fiscal-series-row"
            >
              <dl className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(view.scope).map(([key, value]) => (
                  <div key={key} className="flex gap-1">
                    <dt className="text-muted-foreground">
                      {isKnown(key) ? t(`scope.${key}`) : key}:
                    </dt>
                    <dd className="break-all">{valueOf(view, key, value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="font-medium" data-testid="fiscal-series-next">
                {t('next', { number: view.nextNumber })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
