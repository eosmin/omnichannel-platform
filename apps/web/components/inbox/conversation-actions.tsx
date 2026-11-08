'use client'

import { AlarmClock, ChevronDown, CircleCheck, RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ConversationStatus } from '@platform/core/domain'

import { conversationStatusOf } from '../../lib/inbox/conversation-status'
import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { useConversationControls } from './conversation-controls'
import { ResolveMode } from './resolve-flow'

// The buttons of the header that change the state of the conversation. Each is offered only with its
// permission and only where the state allows it: a resolved or snoozed conversation is reopened, any
// other can be snoozed or resolved. The server still decides every request.
export function ConversationActions({
  conversationId,
  status
}: {
  conversationId: string
  status: string
}): ReactElement | null {
  const t = useTranslations('inbox.actions')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const { reopen } = useConversationActions(storeId, conversationId)
  const { resolve: resolveFlow, openSnooze } = useConversationControls()

  const mayResolve = can(ClientPermissions.CONVERSATIONS_RESOLVE)
  const maySnooze = can(ClientPermissions.CONVERSATIONS_SNOOZE)
  const known = conversationStatusOf(status)
  const isResolved = known === ConversationStatus.RESOLVED
  const isSnoozed = known === ConversationStatus.SNOOZED

  const reopenNow = (): void =>
    reopen.mutate(undefined, {
      onError: error => toast.error(errorText(error))
    })

  const may = isResolved ? mayResolve : isSnoozed ? maySnooze : mayResolve || maySnooze
  if (!may) return null

  let buttons: ReactElement
  if (isResolved || isSnoozed) {
    buttons = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={reopen.isPending}
        onClick={reopenNow}
      >
        <RotateCcw aria-hidden />
        {isResolved ? t('reopen') : t('wakeUp')}
      </Button>
    )
  } else {
    buttons = (
      <div className="flex items-center gap-2">
        {maySnooze ? (
          <Button type="button" variant="outline" size="sm" onClick={openSnooze}>
            <AlarmClock aria-hidden />
            {t('snooze')}
          </Button>
        ) : null}
        {mayResolve ? (
          // One button and its arrow: the button resolves the way the store chose, the arrow always lists the two
          // ways and marks the one the button takes
          <div className="flex items-center">
            <Button
              type="button"
              size="sm"
              className="rounded-r-none"
              disabled={!resolveFlow.isReady}
              aria-keyshortcuts="e"
              onClick={resolveFlow.start}
            >
              <CircleCheck aria-hidden />
              {t('resolve')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  className="border-primary-foreground/30 rounded-l-none border-l px-2"
                  disabled={!resolveFlow.isReady}
                  aria-label={t('resolveMore')}
                >
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {[ResolveMode.NOW, ResolveMode.OPTIONS].map(mode => (
                  <DropdownMenuItem
                    key={mode}
                    aria-keyshortcuts={mode === resolveFlow.defaultMode ? 'e' : 'Shift+E'}
                    onSelect={() => resolveFlow.startWith(mode)}
                  >
                    {mode === ResolveMode.NOW ? t('resolveNow') : t('resolveWithOptions')}
                    {mode === resolveFlow.defaultMode ? (
                      <span className="text-muted-foreground ml-auto text-xs">
                        {t('resolveDefault')}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
    )
  }

  return buttons
}
