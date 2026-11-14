'use client'

import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { SearchConfig, Shortcuts } from '@platform/core/domain'

import { readySearchText } from '../../lib/search/search-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { useSearchUi } from './search-context'

// The search of the top bar. From `md` it is a box: Enter opens the page of results, `/` puts the cursor in it. On a
// phone there is no room for it, so it is a button that opens the palette. Nothing is shown to a member who may search
// nothing.
export function SearchBox(): ReactElement | null {
  const t = useTranslations('search.box')
  const router = useRouter()
  const { storeId } = useStore()
  const { canSearch, boxRef, openPalette } = useSearchUi()
  const [text, setText] = useState('')
  if (!canSearch) return null

  function submit(event: FormEvent): void {
    event.preventDefault()
    const ready = readySearchText(text)
    if (ready === null) return
    router.push(AppPaths.store.search(storeId, ready))
    // The results page has its own box with the text: this one is for the next search
    setText('')
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label={t('open')}
        onClick={openPalette}
      >
        <Search aria-hidden />
      </Button>
      <form role="search" onSubmit={submit} className="relative hidden w-56 md:block lg:w-72">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          ref={boxRef}
          type="search"
          value={text}
          onChange={event => setText(event.target.value)}
          maxLength={SearchConfig.MAX_QUERY_LENGTH}
          aria-label={t('label')}
          aria-keyshortcuts={Shortcuts.list.FOCUS_SEARCH}
          placeholder={t('placeholder')}
          autoComplete="off"
          className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border bg-transparent pr-3 pl-8 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
        />
      </form>
    </>
  )
}
