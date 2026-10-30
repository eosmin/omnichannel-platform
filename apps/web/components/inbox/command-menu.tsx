'use client'

import type { ReactElement } from 'react'

import { cn } from '../../lib/utils'

export interface CommandMenuItem {
  id: string
  label: string
  // A second line: what a command does, the text of a snippet
  hint?: string
}

export interface CommandMenuProps {
  // The id the textarea points at with `aria-controls`
  id: string
  label: string
  items: readonly CommandMenuItem[]
  activeIndex: number
  onPick: (item: CommandMenuItem) => void
}

function optionId(menuId: string, item: CommandMenuItem): string {
  return `${menuId}-${item.id}`
}

// The list under a combobox: the focus stays in the textarea, which is a multi-line `textbox` and so
// cannot be a combobox: the composer announces the highlighted option in a live region. A press (mousedown) picks, so
// the textarea does not lose the focus first.
export function CommandMenu({
  id,
  label,
  items,
  activeIndex,
  onPick
}: CommandMenuProps): ReactElement {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={label}
      className="bg-popover text-popover-foreground max-h-48 overflow-y-auto rounded-md border p-1 shadow-sm"
    >
      {items.map((item, index) => (
        <li
          key={item.id}
          id={optionId(id, item)}
          role="option"
          aria-selected={index === activeIndex}
          ref={node => {
            // The highlighted row stays in view when the arrows go past the visible ones
            if (index === activeIndex) node?.scrollIntoView?.({ block: 'nearest' })
          }}
          onMouseDown={event => {
            event.preventDefault()
            onPick(item)
          }}
          className={cn(
            'flex cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm',
            index === activeIndex && 'bg-accent text-accent-foreground'
          )}
        >
          <span className="truncate font-medium">{item.label}</span>
          {item.hint === undefined ? null : (
            <span className="text-muted-foreground truncate text-xs">{item.hint}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
