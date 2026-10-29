'use client'

import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { fetchOrganizationStores, QueryKeys } from '@platform/api-client'

import { useStore } from '../../components/providers/store-context'
import { apiClient } from '../../lib/api'
import { errorCodeOf } from '../../lib/error-message'

export function StoresList(): ReactElement | null {
  const t = useTranslations('org')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const stores = useQuery({
    queryKey: QueryKeys.organizations.stores(storeId),
    queryFn: ({ signal }) => fetchOrganizationStores(apiClient, storeId, signal)
  })
  if (stores.isError) {
    return (
      <p role="alert" className="text-destructive">
        {tAll(`errors.${errorCodeOf(stores.error)}`)}
      </p>
    )
  }
  if (stores.data === undefined) return null
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('storesTitle')}</h1>
      <ul className="divide-y rounded-md border">
        {stores.data.map(store => (
          <li key={store.id} className="flex flex-col gap-1 p-4">
            <span className="font-medium">{store.name}</span>
            <span className="text-muted-foreground text-sm">
              {store.slug} · {store.timezone} · {store.currency} · {store.defaultLocale}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
