'use client'

import {
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  type LazyExoticComponent,
  type ReactElement,
  Suspense,
  useState
} from 'react'

// What the button that stands in for a menu does before the menu's code is here: warm the download when the
// person is about to use it, and ask for the menu when they do
export interface MenuFacadeProps {
  onPointerEnter: () => void
  onFocus: () => void
  onPointerDown: (event: PointerEvent) => void
  onClick: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

// The props that the menu's trigger shows before and after: the same as Radix gives it when closed, so that
// the button does not change when the real menu takes its place
export const CLOSED_MENU_PROPS = {
  'aria-haspopup': 'menu',
  'aria-expanded': false,
  'data-state': 'closed'
} as const

// A menu of Radix (dropdown, floating-ui, focus trap: ~25 KB) is not part of the first load of a page: its
// button is drawn at once and the menu is downloaded when the person points at the button, focuses it or
// presses it. Until then the button is a plain one with the attributes of a closed menu. The press that asks
// for the menu opens it as soon as it is here (`defaultOpen`), so the first press is not lost; the real
// trigger then takes the place of the plain button, and Radix moves the focus into the menu and back.
export function OnDemandMenu<Props extends object>({
  Popup,
  preload,
  popupProps,
  trigger
}: {
  // `lazy(() => import(...))` of the module that holds the menu
  Popup: LazyExoticComponent<ComponentType<Props & { defaultOpen: boolean; trigger: ReactElement }>>
  // The same `import()`: calling it again costs nothing and starts the download. A download that fails is
  // ignored here (offline while pointing at a button): the press that needs it asks again
  preload: () => Promise<unknown>
  popupProps: Props
  // The button, drawn by the caller so that the plain one and the real one are the same element
  trigger: (extra: Partial<MenuFacadeProps> & Partial<typeof CLOSED_MENU_PROPS>) => ReactElement
}): ReactElement {
  const [isWanted, setWanted] = useState(false)
  const warm = (): void => {
    preload().catch(() => undefined)
  }
  const facade = trigger({
    ...CLOSED_MENU_PROPS,
    onPointerEnter: warm,
    onFocus: warm,
    // Radix opens a menu on the press, not on the release, and keeps the button from taking the focus
    onPointerDown: event => {
      if (event.button === 0 && !event.ctrlKey) {
        event.preventDefault()
        setWanted(true)
      }
    },
    // The keyboard and assistive technology click
    onClick: () => setWanted(true),
    // A menu button also opens with the arrow down (Radix does the same)
    onKeyDown: event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setWanted(true)
      }
    }
  })
  if (!isWanted) return facade
  return (
    <Suspense fallback={facade}>
      <Popup {...popupProps} defaultOpen trigger={trigger({})} />
    </Suspense>
  )
}
