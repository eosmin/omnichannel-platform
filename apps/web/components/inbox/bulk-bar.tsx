'use client'

import { ChevronDown, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useRef, useState } from 'react'

import {
  type BulkOperation,
  type BulkTarget,
  type ConversationFilters,
  type ConversationListItemView
} from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { BulkActions, BulkLimits, ConversationStatus } from '@platform/core/domain'

import { BulkConfirmations, confirmationOf, targetCountOf } from '../../lib/inbox/bulk'
import { hasFilters } from '../../lib/inbox/inbox-filters'
import {
  EMPTY_SELECTION,
  type Selection,
  selectAllMatching,
  selectIds
} from '../../lib/inbox/selection'
import { useBulkRunner } from '../../lib/inbox/use-bulk-actions'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { BulkConfirmDialog, type BulkRequest } from './bulk-confirm-dialog'
import { BulkPickDialog, type BulkPick, BulkPicks } from './bulk-pick-dialog'

function Menu({
  label,
  disabled,
  children
}: {
  label: string
  disabled: boolean
  children: ReactNode
}): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {label}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

// The bar over the list while rows are ticked (TDD_09 §10). It builds the request, asks for
// confirmation where the rules say so, and hands the action to the runner, which tells the result.
export function BulkBar({
  selection,
  onSelectionChange,
  items,
  filters,
  hasMore
}: {
  selection: Selection
  onSelectionChange: (selection: Selection) => void
  // What the list has loaded: the old state of the ticked rows comes from here, for the Undo
  items: readonly ConversationListItemView[]
  filters: ConversationFilters
  // The list has more pages than it has loaded
  hasMore: boolean
}): ReactElement {
  const t = useTranslations('inbox.bulk')
  const tStatus = useTranslations('conversations.status')
  const { can } = useStore()
  const runner = useBulkRunner()
  const [pick, setPick] = useState<BulkPick | null>(null)
  const [confirm, setConfirm] = useState<BulkRequest | null>(null)

  const mayAssign = can(Permissions.CONVERSATIONS_ASSIGN)
  const mayResolve = can(Permissions.CONVERSATIONS_RESOLVE)
  const mayArchive = can(Permissions.CONVERSATIONS_ARCHIVE)

  const count = selection.ids.size
  const isOverLimit = !selection.isAllMatching && count > BulkLimits.MAX_ITEMS
  const allLoaded = count >= items.length
  const canWiden = !selection.isAllMatching && allLoaded && hasMore && hasFilters(filters)

  const clear = (): void => onSelectionChange(EMPTY_SELECTION)

  const inFlight = useRef(false)

  async function go({ operation, target, label }: BulkRequest): Promise<void> {
    if (inFlight.current) return
    // The dialog may have stayed open while the list moved: only what is still ticked is reached
    const ids =
      'conversationIds' in target
        ? target.conversationIds.filter(id => selection.ids.has(id))
        : null
    if (ids !== null && ids.length === 0) {
      setConfirm(null)
      return
    }
    const sent: BulkRequest = {
      operation,
      label,
      target: ids === null ? target : { conversationIds: ids }
    }
    inFlight.current = true
    try {
      const previous = items.filter(item => selection.ids.has(item.id))
      const result = await runner.run(sent.operation, sent.target, previous)
      setConfirm(null)
      // A request that failed as a whole keeps the selection; so do the conversations that did not change
      if (result === null) return
      if (result.failed.length > 0 && ids !== null) {
        onSelectionChange(selectIds(result.failed.map(failure => failure.id)))
      } else {
        clear()
      }
    } finally {
      inFlight.current = false
    }
  }

  function request(operation: BulkOperation, label = ''): void {
    const target: BulkTarget = selection.isAllMatching
      ? { filter: filters }
      : { conversationIds: [...selection.ids] }
    const asked: BulkRequest = { operation, target, label }
    if (confirmationOf(operation, targetCountOf(target)) === BulkConfirmations.NONE) {
      void go(asked)
      return
    }
    setConfirm(asked)
  }

  const status = (
    value: ConversationStatus.OPEN | ConversationStatus.PENDING | ConversationStatus.RESOLVED
  ) => request({ action: BulkActions.SET_STATUS, params: { status: value } }, tStatus(value))

  const disabled = runner.isPending || isOverLimit

  return (
    <div role="region" aria-label={t('label')} className="bg-muted/50 grid gap-1 border-b p-2">
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="mr-auto text-sm font-medium">
          {selection.isAllMatching
            ? t('allMatching', { max: BulkLimits.MAX_ITEMS })
            : t('selected', { count })}
        </p>
        {mayResolve || mayAssign ? (
          <Menu label={t('assign.label')} disabled={disabled}>
            <DropdownMenuItem onSelect={() => request({ action: BulkActions.ASSIGN_TO_ME })}>
              {t('assign.toMe')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => request({ action: BulkActions.UNASSIGN })}>
              {t('assign.unassign')}
            </DropdownMenuItem>
            {mayAssign ? <DropdownMenuSeparator /> : null}
            {mayAssign ? (
              <DropdownMenuItem onSelect={() => setPick(BulkPicks.AGENT)}>
                {t('assign.toAgent')}
              </DropdownMenuItem>
            ) : null}
            {mayAssign ? (
              <DropdownMenuItem onSelect={() => setPick(BulkPicks.TEAM)}>
                {t('assign.roundRobin')}
              </DropdownMenuItem>
            ) : null}
          </Menu>
        ) : null}
        {mayResolve ? (
          <Menu label={t('status.label')} disabled={disabled}>
            <DropdownMenuItem onSelect={() => status(ConversationStatus.OPEN)}>
              {tStatus(ConversationStatus.OPEN)}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => status(ConversationStatus.PENDING)}>
              {tStatus(ConversationStatus.PENDING)}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => status(ConversationStatus.RESOLVED)}>
              {tStatus(ConversationStatus.RESOLVED)}
            </DropdownMenuItem>
          </Menu>
        ) : null}
        {mayResolve ? (
          <Menu label={t('tag.label')} disabled={disabled}>
            <DropdownMenuItem onSelect={() => setPick(BulkPicks.ADD_TAG)}>
              {t('tag.add')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPick(BulkPicks.REMOVE_TAG)}>
              {t('tag.remove')}
            </DropdownMenuItem>
          </Menu>
        ) : null}
        {mayResolve || mayArchive ? (
          <Menu label={t('more.label')} disabled={disabled}>
            {mayResolve ? (
              <DropdownMenuItem onSelect={() => request({ action: BulkActions.MARK_READ })}>
                {t('more.markRead')}
              </DropdownMenuItem>
            ) : null}
            {mayResolve ? (
              <DropdownMenuItem onSelect={() => request({ action: BulkActions.MARK_UNREAD })}>
                {t('more.markUnread')}
              </DropdownMenuItem>
            ) : null}
            {mayArchive ? (
              <DropdownMenuItem onSelect={() => request({ action: BulkActions.ARCHIVE })}>
                {t('more.archive')}
              </DropdownMenuItem>
            ) : null}
          </Menu>
        ) : null}
        <Button type="button" variant="ghost" size="icon" aria-label={t('clear')} onClick={clear}>
          <X aria-hidden />
        </Button>
      </div>
      {isOverLimit ? (
        <p role="alert" className="text-destructive text-xs">
          {t('overLimit', { max: BulkLimits.MAX_ITEMS })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {!selection.isAllMatching && !allLoaded ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onSelectionChange(
                selectIds(items.slice(0, BulkLimits.MAX_ITEMS).map(item => item.id))
              )
            }
          >
            {t('selectLoaded', { count: Math.min(items.length, BulkLimits.MAX_ITEMS) })}
          </Button>
        ) : null}
        {canWiden ? (
          <>
            <span className="text-muted-foreground">{t('onlyLoaded', { count })}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSelectionChange(selectAllMatching(selection))}
            >
              {t('selectMatching', { max: BulkLimits.MAX_ITEMS })}
            </Button>
          </>
        ) : null}
      </div>
      <BulkPickDialog
        pick={pick}
        onOpenChange={open => (open ? undefined : setPick(null))}
        onPick={(operation, label) => {
          setPick(null)
          request(operation, label)
        }}
      />
      <BulkConfirmDialog
        request={confirm}
        isPending={runner.isPending}
        onConfirm={asked => void go(asked)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
