'use client'

import { AlarmClock, CircleCheck, RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import { ConversationStatus } from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import { conversationStatusOf } from '../../lib/inbox/conversation-status'
import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { useConversationControls } from './conversation-controls'

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
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const { reopen } = useConversationActions(storeId, conversationId)
  const { resolve: resolveFlow, openSnooze } = useConversationControls()

  const mayResolve = can(Permissions.CONVERSATIONS_RESOLVE)
  const maySnooze = can(Permissions.CONVERSATIONS_SNOOZE)
  const known = conversationStatusOf(status)
  const isResolved = known === ConversationStatus.RESOLVED
  const isSnoozed = known === ConversationStatus.SNOOZED

  const reopenNow = (): void =>
    reopen.mutate(undefined, {
      onError: error => toast.error(tAll(`errors.${errorCodeOf(error)}`))
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
          <Button
            type="button"
            size="sm"
            disabled={!resolveFlow.isReady}
            onClick={resolveFlow.start}
          >
            <CircleCheck aria-hidden />
            {t('resolve')}
          </Button>
        ) : null}
      </div>
    )
  }

  return buttons
}
