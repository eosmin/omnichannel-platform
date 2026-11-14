'use client'

import dynamic from 'next/dynamic'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useMemo,
  useRef,
  useState
} from 'react'

import { Shortcuts } from '@platform/core/domain'

import { searchableKinds } from '../../lib/search/search-target'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { useStore } from '../providers/store-context'
import { ShortcutsProvider, useShortcut } from '../shortcuts/shortcuts-provider'

// The palette, its results and its list load when it is first opened, not with the page: most sessions never open it
// and the pages have a script budget (apps/web-e2e/lighthouse/budgets.ts).
const CommandPalette = dynamic(
  () => import('./command-palette').then(module => module.CommandPalette),
  { ssr: false }
)

interface SearchValue {
  // False for a member who may search nothing: there is no box and no palette to offer
  canSearch: boolean
  openPalette: () => void
  // The box of the top bar, for the `/` shortcut
  boxRef: RefObject<HTMLInputElement | null>
}

const SearchContext = createContext<SearchValue | null>(null)

// The search of the store, on every page of it: the palette (`Mod+K`) and the box of the top bar (`/`). It has its
// own shortcuts provider, under the ones of the pages (the inbox, the customers), which keep theirs.
export function SearchProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <ShortcutsProvider>
      <SearchShortcuts>{children}</SearchShortcuts>
    </ShortcutsProvider>
  )
}

function SearchShortcuts({ children }: { children: ReactNode }): ReactElement {
  const { can } = useStore()
  const canSearch = searchableKinds(can).length > 0
  const [isOpen, setOpen] = useState(false)
  const isMounted = useMountedOnce(isOpen)
  const boxRef = useRef<HTMLInputElement>(null)
  useShortcut(Shortcuts.global.COMMAND_PALETTE, () => setOpen(true), { enabled: canSearch })
  useShortcut(
    Shortcuts.list.FOCUS_SEARCH,
    () => {
      const box = boxRef.current
      // A phone has no box, only the button that opens the palette
      if (box !== null && box.offsetParent !== null) box.focus()
      else setOpen(true)
    },
    { enabled: canSearch }
  )
  const value = useMemo<SearchValue>(
    () => ({ canSearch, openPalette: () => setOpen(true), boxRef }),
    [canSearch]
  )
  return (
    <SearchContext.Provider value={value}>
      {children}
      {isMounted ? <CommandPalette open={isOpen} onOpenChange={setOpen} /> : null}
    </SearchContext.Provider>
  )
}

export function useSearchUi(): SearchValue {
  const value = useContext(SearchContext)
  if (value === null) throw new Error('useSearchUi needs a SearchProvider above it')
  return value
}
