'use client'

import { ChevronDown, CircleCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ConversationListItemView } from '@platform/api-client'

import { useCustomerName } from '../../lib/inbox/use-customer-name'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { ResolveMode, type ResolveModeType } from './resolve-flow'

// Shown the way the snooze button is: over the row, as a sibling of the link, on hover or focus and always
// on a touch screen (where it is 40 px). They stand side by side at the bottom right of the row.
const BUTTON_CLASS =
  'bg-background hover:bg-accent focus-visible:ring-ring pointer-events-none flex h-8 items-center justify-center border opacity-0 outline-none group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 pointer-coarse:pointer-events-auto pointer-coarse:h-10 pointer-coarse:opacity-100 group-has-[[data-state=open]]/resolve:pointer-events-auto group-has-[[data-state=open]]/resolve:opacity-100'

// The resolve button of a row and its arrow: the button takes the way the store chose, the arrow lists
// both. It does not open the conversation (it is not inside the link). The flow itself is run by the list.
export function RowResolveButton({
  customer,
  channelType,
  defaultMode,
  onResolve
}: {
  customer: ConversationListItemView['customer']
  channelType: string
  // Null until the settings of the store are read: the menu then marks none
  defaultMode: ResolveModeType | null
  onResolve: (way: 'default' | ResolveModeType) => void
}): ReactElement {
  const t = useTranslations('inbox.actions')
  const { name } = useCustomerName(customer, channelType)
  // The box lets the click through to the link; only the buttons catch it, and only when they show
  return (
    <div className="group/resolve pointer-events-none absolute right-12 bottom-1.5 flex pointer-coarse:right-14">
      <button
        type="button"
        aria-label={t('resolveRow', { name })}
        onClick={() => onResolve('default')}
        className={`${BUTTON_CLASS} w-8 rounded-l-md border-r-0 pointer-coarse:w-10`}
      >
        <CircleCheck aria-hidden className="size-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('resolveRowMore', { name })}
            className={`${BUTTON_CLASS} w-5 rounded-r-md pointer-coarse:w-10`}
          >
            <ChevronDown aria-hidden className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {[ResolveMode.NOW, ResolveMode.OPTIONS].map(mode => (
            <DropdownMenuItem key={mode} onSelect={() => onResolve(mode)}>
              {mode === ResolveMode.NOW ? t('resolveNow') : t('resolveWithOptions')}
              {mode === defaultMode ? (
                <span className="text-muted-foreground ml-auto text-xs">{t('resolveDefault')}</span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
