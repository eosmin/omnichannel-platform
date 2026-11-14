'use client'

import { CornerDownLeft, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type KeyboardEvent, type ReactElement, useEffect, useId, useMemo, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { SearchConfig, type SearchEntity } from '@platform/core/domain'

import { flattenGroups, hitKey } from '../../lib/search/hits'
import {
  hitItems,
  matchingPages,
  moveActive,
  type PaletteItem,
  pageCommands
} from '../../lib/search/palette-items'
import { readySearchText } from '../../lib/search/search-text'
import { useGlobalSearch } from '../../lib/search/use-search'
import { useDebouncedValue } from '../../lib/use-debounced-value'
import { cn } from '../../lib/utils'
import { useCustomerDrawer } from '../customers/customer-drawer-context'
import { useStore } from '../providers/store-context'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

import { HitContent } from './hit-content'

// The command palette (`Mod+K`, Step 5.1): one box that finds a customer, an order, a product or a message, and jumps
// to a page. The text goes to the api once the typing pauses and has the minimum length; the arrows walk the rows,
// Enter opens one, and the last row is the page with every result.
export function CommandPalette({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('search')
  const tNav = useTranslations('shell.nav')
  const router = useRouter()
  const { storeId, can } = useStore()
  const { openCustomer } = useCustomerDrawer()
  const listId = useId()
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1)
  const ready = readySearchText(useDebouncedValue(text, SearchConfig.DEBOUNCE_MS))
  const isTypingMore = ready !== readySearchText(text)
  const search = useGlobalSearch(storeId, ready)

  // A closed palette starts empty the next time: yesterday's text is not what the person comes to look for
  useEffect(() => {
    if (!open) {
      setText('')
      setActive(-1)
    }
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const pages = matchingPages(pageCommands(storeId, can), command => tNav(command.labelKey), text)
    if (ready === null) return pages
    const hits = search.data === undefined ? [] : flattenGroups(search.data.groups)
    return [
      ...pages,
      ...hitItems(storeId, hits, hitKey),
      { kind: 'all', key: 'all', href: AppPaths.store.search(storeId, ready) }
    ]
  }, [storeId, can, tNav, text, ready, search.data])

  // The row the arrows reach stays in view
  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, listId])

  // The row under the cursor follows the list: a new list starts with no row chosen
  useEffect(() => setActive(-1), [items.length, ready])

  function go(item: PaletteItem | undefined): void {
    if (item === undefined) return
    onOpenChange(false)
    // A customer has no page: the profile opens as the drawer every other screen of the store opens
    if (item.kind === 'hit' && item.href === null) openCustomer(item.item.hit.id)
    else if (item.href !== null) router.push(item.href)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => moveActive(current, event.key === 'ArrowDown' ? 1 : -1, items.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (active >= 0) {
        go(items[active])
        return
      }
      // With no row chosen Enter opens the page of results for what is in the box now (not the debounced text,
      // which may be behind), the way the box of the top bar does; with too little text, the first page
      const typedNow = readySearchText(text)
      if (typedNow === null) go(items[0])
      else go({ kind: 'all', key: 'all', href: AppPaths.store.search(storeId, typedNow) })
    }
  }

  const isWaiting =
    ready !== null && (search.isPending || isTypingMore) && search.data === undefined
  const isEmpty =
    ready !== null && !isWaiting && !search.isError && !items.some(item => item.kind === 'hit')
  let previousGroup: string | null = null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] translate-y-0 gap-0 p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('palette.description')}</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <input
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={t('palette.label')}
            value={text}
            onChange={event => setText(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={SearchConfig.MAX_QUERY_LENGTH}
            placeholder={t('palette.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="placeholder:text-muted-foreground h-12 w-full min-w-0 bg-transparent text-base outline-none md:text-sm"
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={t('palette.results')}
          className="max-h-[min(60dvh,24rem)] overflow-y-auto p-1"
        >
          {items.map((item, index) => {
            const group = groupOf(item)
            const showsGroup = group !== previousGroup
            previousGroup = group
            return (
              <div key={item.key} role="presentation">
                {showsGroup && group !== null ? (
                  <div
                    role="presentation"
                    className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium"
                  >
                    {group === 'page' ? t('palette.goTo') : t(`groups.${group}`)}
                  </div>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(item)}
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-2',
                    index === active && 'bg-accent text-accent-foreground'
                  )}
                >
                  <ItemContent item={item} text={ready ?? text} />
                </div>
              </div>
            )
          })}
        </div>
        <p
          role="status"
          className={cn(
            'text-muted-foreground border-t px-3 py-2 text-xs',
            ready === null && text.trim() === '' && 'sr-only'
          )}
        >
          {statusText()}
        </p>
      </DialogContent>
    </Dialog>
  )

  function statusText(): string {
    if (ready === null)
      return text.trim() === ''
        ? ''
        : t('palette.tooShort', { count: SearchConfig.MIN_QUERY_LENGTH })
    if (search.isError) return t('palette.failed')
    if (isWaiting) return t('palette.searching')
    if (isEmpty) return t('palette.empty', { query: ready })
    return t('palette.resultsCount', { count: items.filter(item => item.kind === 'hit').length })
  }
}

// The heading a row sits under: the pages, or the kind of thing a hit is; none for the closing row
function groupOf(item: PaletteItem): 'page' | SearchEntity | null {
  if (item.kind === 'page') return 'page'
  if (item.kind === 'hit') return item.item.entity
  return null
}

function ItemContent({ item, text }: { item: PaletteItem; text: string }): ReactElement {
  const t = useTranslations('search')
  if (item.kind === 'hit') return <HitContent item={item.item} />
  if (item.kind === 'all') {
    return (
      <div className="flex items-center gap-3 text-sm">
        <CornerDownLeft className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="truncate">{t('palette.seeAll', { query: text })}</span>
      </div>
    )
  }
  return <div className="px-7 text-sm">{item.label}</div>
}
