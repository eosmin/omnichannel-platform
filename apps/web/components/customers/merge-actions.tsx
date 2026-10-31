'use client'

import { MoreHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { MergeDialog } from './merge-dialog'

// What the profile asks of a merge: `absorbedId` is set by "Merge instead", which skips the search
export interface MergeRequest {
  absorbedId?: string
}

// The `⋯` menu of the profile and the merge dialog it opens. They live together, and load together,
// because the inbox panel imports `CustomerDetails` and the inbox has a script budget
// (apps/web-e2e/lighthouse/budgets.ts): the dropdown is not worth its weight there. With `showMenu`
// false only the dialog is drawn, for a request that came from somewhere else.
export function MergeActions({
  customerId,
  request,
  showMenu,
  onRequest
}: {
  customerId: string
  request: MergeRequest | null
  showMenu: boolean
  onRequest: (request: MergeRequest | null) => void
}): ReactElement {
  const t = useTranslations('customers.merge')
  return (
    <>
      {showMenu ? (
        // Not modal: a modal menu leaves the page locked when it hands over to the merge dialog
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" aria-label={t('moreActions')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRequest({})}>{t('open')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {request === null ? null : (
        <MergeDialog
          survivorId={customerId}
          absorbedId={request.absorbedId}
          onClose={() => onRequest(null)}
        />
      )}
    </>
  )
}
