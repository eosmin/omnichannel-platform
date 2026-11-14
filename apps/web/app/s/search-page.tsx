'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import {
  SearchConfig,
  SearchEntities,
  type SearchEntity,
  SearchPageParams,
  SearchPageScopes
} from '@platform/core/domain'

import { useCustomerDrawer } from '../../components/customers/customer-drawer-context'
import { useStore } from '../../components/providers/store-context'
import { HitContent } from '../../components/search/hit-content'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { type SearchHit, flattenGroups, hitKey, pathOfHit } from '../../lib/search/hits'
import { readScope, searchAddress } from '../../lib/search/search-page-state'
import { searchableKinds } from '../../lib/search/search-target'
import { readySearchText } from '../../lib/search/search-text'
import { useGlobalSearch, useScopedSearch } from '../../lib/search/use-search'
import { cn } from '../../lib/utils'

const KIND_ORDER = [
  SearchEntities.CUSTOMERS,
  SearchEntities.ORDERS,
  SearchEntities.PRODUCTS,
  SearchEntities.MESSAGES
] as const

// The results of a search (Step 5.1): everything at once, or one kind of thing with more hits. The text and the kind
// live in the address, so a search can be shared and Back returns to it.
export function SearchPage(): ReactElement {
  const t = useTranslations('search.page')
  const { storeId, can } = useStore()
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const kinds = useMemo(() => KIND_ORDER.filter(kind => searchableKinds(can).includes(kind)), [can])
  const scope = readScope(params.get(SearchPageParams.SCOPE), kinds)
  const fromAddress = params.get(SearchPageParams.QUERY) ?? ''
  const [text, setText] = useState(fromAddress)
  const ready = readySearchText(fromAddress)

  // Back, or a link to another search, changes the address under the box
  useEffect(() => setText(fromAddress), [fromAddress])

  function submit(event: FormEvent): void {
    event.preventDefault()
    router.push(searchAddress(pathname, text.trim(), scope))
  }

  if (kinds.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {t('noAccess')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <form role="search" onSubmit={submit} className="flex gap-2">
        <Input
          type="search"
          value={text}
          onChange={event => setText(event.target.value)}
          maxLength={SearchConfig.MAX_QUERY_LENGTH}
          aria-label={t('label')}
          placeholder={t('placeholder')}
          autoComplete="off"
        />
        <Button type="submit">{t('submit')}</Button>
      </form>
      <nav aria-label={t('scopes.label')} className="flex flex-wrap gap-1">
        {[SearchPageScopes.ALL, ...kinds].map(item => (
          <Link
            key={item}
            href={searchAddress(pathname, fromAddress, item)}
            aria-current={item === scope ? 'page' : undefined}
            className={cn(
              'rounded-md border px-3 py-1 text-sm',
              item === scope ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'
            )}
          >
            {t(`scopes.${item}`)}
          </Link>
        ))}
      </nav>
      {ready === null ? (
        <p className="text-muted-foreground text-sm">
          {fromAddress.trim() === ''
            ? t('start')
            : t('tooShort', { count: SearchConfig.MIN_QUERY_LENGTH })}
        </p>
      ) : scope === SearchPageScopes.ALL ? (
        <AllResults storeId={storeId} text={ready} />
      ) : (
        <ScopeResults storeId={storeId} scope={scope} text={ready} />
      )}
    </div>
  )
}

function AllResults({ storeId, text }: { storeId: string; text: string }): ReactElement {
  const t = useTranslations('search')
  const search = useGlobalSearch(storeId, text)
  if (search.isError) return <Failed onRetry={() => void search.refetch()} />
  if (search.data === undefined) return <Loading />
  if (search.data.groups.length === 0) return <Empty text={text} />
  const hits = flattenGroups(search.data.groups)
  return (
    <div className="flex flex-col gap-4">
      {KIND_ORDER.map(kind => {
        const ofKind = hits.filter(item => item.entity === kind)
        if (ofKind.length === 0) return null
        return (
          <section key={kind} aria-labelledby={`group-${kind}`} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <h2 id={`group-${kind}`} className="text-sm font-semibold">
                {t(`groups.${kind}`)}
              </h2>
              {ofKind.length >= SearchConfig.GLOBAL_SEARCH_PER_GROUP ? (
                <Link
                  href={searchAddress(AppPaths.store.search(storeId), text, kind)}
                  className="text-muted-foreground text-xs underline-offset-2 hover:underline"
                >
                  {t('page.seeMore')}
                </Link>
              ) : null}
            </div>
            <HitList storeId={storeId} hits={ofKind} />
          </section>
        )
      })}
    </div>
  )
}

function ScopeResults({
  storeId,
  scope,
  text
}: {
  storeId: string
  scope: SearchEntity
  text: string
}): ReactElement {
  const t = useTranslations('search.page')
  const search = useScopedSearch(storeId, scope, text)
  if (search.isError) return <Failed onRetry={() => void search.refetch()} />
  if (search.data === undefined) return <Loading />
  const result = search.data
  const hits: SearchHit[] =
    result.scope === SearchEntities.PRODUCTS
      ? result.page.data.map(hit => ({ entity: result.scope, hit }))
      : result.scope === SearchEntities.CUSTOMERS
        ? result.page.hits.map(hit => ({ entity: result.scope, hit }))
        : result.scope === SearchEntities.ORDERS
          ? result.page.hits.map(hit => ({ entity: result.scope, hit }))
          : result.page.hits.map(hit => ({ entity: result.scope, hit }))
  if (hits.length === 0) return <Empty text={text} />
  const hasMore = result.scope === SearchEntities.PRODUCTS ? false : result.page.hasMore
  return (
    <div className="flex flex-col gap-2">
      <HitList storeId={storeId} hits={hits} />
      {hasMore ? <p className="text-muted-foreground text-sm">{t('hasMore')}</p> : null}
    </div>
  )
}

function HitList({ storeId, hits }: { storeId: string; hits: SearchHit[] }): ReactElement {
  const { openCustomer } = useCustomerDrawer()
  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {hits.map(item => {
        const path = pathOfHit(storeId, item)
        const className = 'hover:bg-accent/50 block w-full px-3 py-2.5 text-left'
        return (
          <li key={hitKey(item)}>
            {path === null ? (
              // A customer has no page of their own: the profile is the drawer of the store
              <button type="button" className={className} onClick={() => openCustomer(item.hit.id)}>
                <HitContent item={item} />
              </button>
            ) : (
              <Link href={path} className={className}>
                <HitContent item={item} />
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Loading(): ReactElement {
  const t = useTranslations('search.page')
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {t('loading')}
    </p>
  )
}

function Empty({ text }: { text: string }): ReactElement {
  const t = useTranslations('search.page')
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {t('empty', { query: text })}
    </p>
  )
}

function Failed({ onRetry }: { onRetry: () => void }): ReactElement {
  const t = useTranslations('search.page')
  const tCommon = useTranslations('common')
  return (
    <div role="alert" className="flex items-center gap-3 text-sm">
      <span>{t('failed')}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {tCommon('tryAgain')}
      </Button>
    </div>
  )
}
