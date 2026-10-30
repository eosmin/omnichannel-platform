'use client'

import { Clock, Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from 'react'

import { Permissions } from '@platform/core/auth'
import { MessageLimits, MessageType } from '@platform/core/domain'

import { useComposerQueue } from '../../lib/inbox/use-composer-queue'
import { useChannelDirectory, useConversation } from '../../lib/inbox/use-inbox-data'
import { useWindowState } from '../../lib/inbox/use-window-state'
import { hoursAndMinutes } from '../../lib/inbox/window-state'
import type { PendingMessage } from '../../lib/realtime/offline-queue'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Textarea } from '../ui/textarea'

import { type EditState, FailedMessages } from './failed-messages'
import { TemplateDialog } from './template-dialog'

// What a keydown carries while an input method is composing
const IME_KEY_CODE = 229

// Between what the agent was writing and the text that comes back to the box
const EDIT_JOINER = '\n\n'

type Mode = MessageType.TEXT | MessageType.INTERNAL_NOTE

// The tab that is not allowed is not offered, so the mode follows the permissions
function allowedMode(chosen: Mode, mayReply: boolean, mayNote: boolean): Mode {
  if (chosen === MessageType.INTERNAL_NOTE && !mayNote) return MessageType.TEXT
  if (chosen === MessageType.TEXT && !mayReply) return MessageType.INTERNAL_NOTE
  return chosen
}

// Where the agent answers. Everything goes through the offline queue, online or not: the queue sends
// it, draws it while it goes out and keeps it if the connection is down. Free text to the customer
// follows the messaging window of the channel; an internal note never does.
export function Composer({ conversationId }: { conversationId: string }): ReactElement | null {
  const t = useTranslations('inbox.composer')
  const { storeId, can } = useStore()
  const conversation = useConversation(storeId, conversationId)
  const channels = useChannelDirectory(storeId)
  const windowState = useWindowState(storeId, conversationId)
  const queue = useComposerQueue(storeId, conversationId)

  const mayReply = can(Permissions.MESSAGES_SEND)
  const mayNote = can(Permissions.MESSAGES_INTERNAL_NOTE)
  const [chosenMode, setMode] = useState<Mode>(MessageType.TEXT)
  const [draft, setDraft] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [isTemplateOpen, setTemplateOpen] = useState(false)

  // The dialog belongs to the closed window: when the customer writes and it reopens, the dialog
  // goes, and it must not come back by itself the next time the window closes
  const isWindowClosed = windowState.kind === 'closed'
  useEffect(() => {
    if (!isWindowClosed) setTemplateOpen(false)
  }, [isWindowClosed])

  if (conversation.data === undefined) return null
  if (!mayReply && !mayNote) {
    return <p className="text-muted-foreground border-t p-3 text-sm">{t('readOnly')}</p>
  }

  const mode = allowedMode(chosenMode, mayReply, mayNote)
  const isNote = mode === MessageType.INTERNAL_NOTE
  const isClosed = !isNote && windowState.kind === 'closed'
  const pluginId =
    channels.data?.find(channel => channel.id === conversation.data.channelConnectionId)
      ?.pluginId ?? conversation.data.channelType
  const mayTemplate = can(Permissions.MESSAGES_SEND_TEMPLATE)

  const content = draft.trim()
  const submit = (): void => {
    if (content === '' || isClosed || !queue.isReady) return
    queue.send({ type: mode, content })
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends and Shift+Enter breaks the line; Enter that picks a character of an input method
    // (composition) is not a send
    // Safari fires the Enter that confirms a composition after it has ended, with keyCode 229 and
    // isComposing already false
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === IME_KEY_CODE) return
    event.preventDefault()
    submit()
  }
  // The text goes back only where it can be sent again as it was written, and never into a draft of
  // the other kind (a note that turned into a reply would go to the customer)
  const canEdit = (message: PendingMessage): EditState => {
    const isNoteMessage = message.type === MessageType.INTERNAL_NOTE
    if (isNoteMessage ? !mayNote : !mayReply || windowState.kind === 'closed') return 'hidden'
    if (draft.trim() === '') return 'enabled'
    const isSameKind = isNoteMessage === (mode === MessageType.INTERNAL_NOTE)
    const fits =
      draft.length + EDIT_JOINER.length + message.content.length <= MessageLimits.CONTENT_MAX_LENGTH
    return isSameKind && fits ? 'enabled' : 'disabled'
  }
  const edit = (message: PendingMessage): void => {
    // What the agent was already writing stays: the text that comes back goes after it
    setDraft(current =>
      current.trim() === '' ? message.content : `${current}${EDIT_JOINER}${message.content}`
    )
    setMode(message.type)
    queue.discard(message.id)
    textarea.current?.focus()
  }

  return (
    <div className={cn('flex flex-col gap-2 border-t p-3', isNote && 'bg-note/40')}>
      <FailedMessages
        messages={queue.failed}
        canEdit={canEdit}
        onEdit={edit}
        onDiscard={queue.discard}
        onResend={queue.resend}
      />
      {mayReply && mayNote ? (
        <Tabs
          value={mode}
          onValueChange={value =>
            setMode(
              value === String(MessageType.INTERNAL_NOTE)
                ? MessageType.INTERNAL_NOTE
                : MessageType.TEXT
            )
          }
        >
          <TabsList aria-label={t('modeLabel')}>
            <TabsTrigger value={MessageType.TEXT}>{t('reply')}</TabsTrigger>
            <TabsTrigger value={MessageType.INTERNAL_NOTE}>{t('note')}</TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      {!isNote && windowState.kind === 'closing' ? (
        <p
          role="status"
          className="bg-note text-note-foreground border-note-border flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
        >
          <Clock aria-hidden className="size-3.5" />
          {t('window.closing', hoursAndMinutes(windowState.remainingMs))}
        </p>
      ) : null}

      {isClosed && windowState.kind === 'closed' ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>
            {windowState.requiresTemplate
              ? mayTemplate
                ? t('window.closedTemplate')
                : t('window.closedNoPermission')
              : t('window.closedNothing')}
          </p>
          {draft.trim() === '' ? null : (
            <p className="text-muted-foreground">{t('window.draftKept')}</p>
          )}
          {windowState.requiresTemplate && mayTemplate ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setTemplateOpen(true)}
              >
                {t('window.chooseTemplate')}
              </Button>
              <TemplateDialog
                open={isTemplateOpen}
                onOpenChange={setTemplateOpen}
                conversationId={conversationId}
                pluginId={pluginId}
                connectionId={conversation.data.channelConnectionId}
              />
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <Textarea
            ref={textarea}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MessageLimits.CONTENT_MAX_LENGTH}
            aria-label={isNote ? t('noteLabel') : t('replyLabel')}
            placeholder={isNote ? t('notePlaceholder') : t('replyPlaceholder')}
            className="max-h-48 min-h-10 resize-none"
            rows={2}
          />
          <Button
            type="button"
            size="icon"
            onClick={submit}
            disabled={content === '' || !queue.isReady}
            aria-label={t('send')}
          >
            <Send aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}
