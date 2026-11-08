'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { ResolveMode, type ResolveModeType } from './resolve-flow'

// The two ways to resolve a row, downloaded when the person reaches for the arrow (`RowResolveButton`)
export default function RowResolveMenuPopup({
  defaultMode,
  onResolve,
  defaultOpen,
  trigger
}: {
  defaultMode: ResolveModeType | null
  onResolve: (way: ResolveModeType) => void
  defaultOpen: boolean
  trigger: ReactElement
}): ReactElement {
  const t = useTranslations('inbox.actions')
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
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
  )
}
