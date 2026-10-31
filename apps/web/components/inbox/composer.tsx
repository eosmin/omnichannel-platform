'use client'

import { Clock, Send } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import {
  ConversationStatus,
  MessageLimits,
  MessageType,
  SLASH_PREFIX,
  Shortcuts,
  SlashCommand
} from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import { composerMenu, type MenuEntry } from '../../lib/inbox/composer-menu'
import {
  type Mention,
  mentionedIds,
  typedCommand,
  withMentions
} from '../../lib/inbox/composer-triggers'
import { conversationStatusOf } from '../../lib/inbox/conversation-status'
import { useComposerQueue } from '../../lib/inbox/use-composer-queue'
import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import {
  useChannelDirectory,
  useConversation,
  useMemberDirectory,
  useSnippets
} from '../../lib/inbox/use-inbox-data'
import { useWindowState } from '../../lib/inbox/use-window-state'
import { hoursAndMinutes } from '../../lib/inbox/window-state'
import type { PendingMessage } from '../../lib/realtime/offline-queue'
import { useAgentTyping } from '../../lib/realtime/use-agent-typing'
import { SHORTCUT_FIELD_ATTRIBUTE } from '../../lib/shortcuts/chords'
import { ShortcutPriority } from '../../lib/shortcuts/priorities'
import { useProfile } from '../../lib/use-profile'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'
import { useShortcut } from '../shortcuts/shortcuts-provider'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Textarea } from '../ui/textarea'

import { CommandMenu } from './command-menu'
import { useConversationControls } from './conversation-controls'
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

// The keys that go to the box: `r` to write to the customer, Shift+N to write a note, Cmd/Ctrl+Enter to
// send from anywhere (Enter in the box already sends). Its own component because the composer returns
// early, before it could register them.
function ComposerShortcuts({
  mayReply,
  mayNote,
  onMode,
  onSend,
  focus
}: {
  mayReply: boolean
  mayNote: boolean
  onMode: (mode: Mode) => void
  onSend: () => void
  focus: () => void
}): null {
  const keyboard = { priority: ShortcutPriority.OPEN_CONVERSATION }
  // After the render: a box that was replaced (a closed window) is there again by then
  const focusSoon = (): void => void requestAnimationFrame(focus)
  useShortcut(
    Shortcuts.conversation.FOCUS_REPLY,
    () => {
      onMode(MessageType.TEXT)
      focusSoon()
    },
    { ...keyboard, enabled: mayReply }
  )
  useShortcut(
    Shortcuts.conversation.INTERNAL_NOTE,
    () => {
      onMode(MessageType.INTERNAL_NOTE)
      focusSoon()
    },
    { ...keyboard, enabled: mayNote }
  )
  useShortcut(Shortcuts.global.SEND_MESSAGE, onSend, keyboard)
  return null
}

// Where the agent answers. Everything goes through the offline queue, online or not: the queue sends
// it, draws it while it goes out and keeps it if the connection is down. Free text to the customer
// follows the messaging window of the channel; an internal note never does.
export function Composer({ conversationId }: { conversationId: string }): ReactElement | null {
  const t = useTranslations('inbox.composer')
  const tAll = useTranslations()
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
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  // The text for which the menu was closed with Escape: it opens again when the text changes
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [picked, setPicked] = useState<Mention[]>([])
  const menuId = useId()
  const tMenu = useTranslations('inbox.composer.menu')
  const members = useMemberDirectory(storeId)
  const profile = useProfile()
  const actions = useConversationActions(storeId, conversationId)
  const { resolve: resolveFlow, openSnooze } = useConversationControls()
  const wantsSnippets = draft.toLowerCase().startsWith(`${SLASH_PREFIX}${SlashCommand.SNIPPET} `)
  const snippets = useSnippets(storeId, wantsSnippets)
  // Only a reply that could reach the customer is announced: not a note, not a command, and not a
  // box that cannot send (a closed window sends nothing, so it shows nothing)
  useAgentTyping(
    conversationId,
    draft,
    allowedMode(chosenMode, mayReply, mayNote) === MessageType.TEXT &&
      typedCommand(draft.trim()) === undefined &&
      windowState.kind !== 'closed'
  )

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
  // A resolved or snoozed conversation is reopened, not resolved or snoozed again: the same rule as
  // the buttons of the header
  const status = conversationStatusOf(conversation.data.status)
  const canChangeState =
    status !== ConversationStatus.RESOLVED && status !== ConversationStatus.SNOOZED
  const commands = [
    SlashCommand.SNIPPET,
    ...(can(Permissions.CONVERSATIONS_ASSIGN) ? [SlashCommand.ASSIGN] : []),
    ...(can(Permissions.CONVERSATIONS_SNOOZE) && canChangeState ? [SlashCommand.SNOOZE] : []),
    ...(can(Permissions.CONVERSATIONS_RESOLVE) && canChangeState && resolveFlow.isReady
      ? [SlashCommand.RESOLVE]
      : [])
  ]
  const menu = composerMenu({
    draft,
    caret,
    isNote,
    commands,
    snippets: snippets.data ?? [],
    members: members.data ?? [],
    selfId: profile.data?.id,
    isMentionFull: mentionedIds(draft, picked).length >= MessageLimits.MAX_MENTIONS,
    maxLength: MessageLimits.CONTENT_MAX_LENGTH,
    commandHint: command => tMenu(`commands.${command}`)
  })
  const isMenuOpen = menu !== null && dismissedFor !== draft
  const entries = isMenuOpen ? menu.entries : []
  const active = entries[Math.min(activeIndex, entries.length - 1)]

  const setText = (text: string): void => {
    setDraft(text)
    setActiveIndex(0)
  }
  // Text that is a command is not a message: nothing sends it, and the button says so by being off
  const isCommandText = typedCommand(content) !== undefined
  const submit = (): void => {
    if (content === '' || isClosed || !queue.isReady) return
    // Text that starts with a command is never a message, whether or not the agent may use it or the
    // menu found a match: "/snippet thx" must not reach the customer
    if (isCommandText) return
    const mentions = isNote ? mentionedIds(content, picked) : []
    queue.send({ type: mode, content, ...(mentions.length > 0 ? { mentions } : {}) })
    setText('')
    setCaret(0)
    setPicked([])
  }

  const pick = (entry: MenuEntry): void => {
    const { outcome } = entry
    if (outcome.kind === 'draft') {
      setText(outcome.draft)
      // After the new text is in the box: the box is not a controlled caret
      const { caret: at } = outcome
      requestAnimationFrame(() => textarea.current?.setSelectionRange(at, at))
      setCaret(outcome.caret)
      if (outcome.mention !== undefined) {
        const { mention } = outcome
        setPicked(current => withMentions(current, [mention]))
      }
    } else {
      setText('')
      setCaret(0)
      if (outcome.kind === 'snooze') openSnooze()
      if (outcome.kind === 'resolve') resolveFlow.start()
      if (outcome.kind === 'assign') {
        const { member } = outcome
        // A promise, not the callbacks of mutate: those do not run if the agent moves to another
        // conversation before the answer
        actions.assign
          .mutateAsync(member.id)
          .then(() => toast.success(tMenu('assigned', { name: member.name })))
          .catch((error: unknown) => toast.error(tAll(`errors.${errorCodeOf(error)}`)))
      }
    }
    textarea.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (active !== undefined && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        const at = entries.indexOf(active)
        setActiveIndex((at + step + entries.length) % entries.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(active)
        return
      }
    }
    if (event.key === 'Escape' && isMenuOpen) {
      event.preventDefault()
      setDismissedFor(draft)
      return
    }
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
    // The people a note named come back from the directory: until it is read they cannot
    if (message.mentions.length > 0 && members.isPending) return 'disabled'
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
    // The people the note named come back with its text, so sending it again still notifies them
    const named = (members.data ?? []).filter(member => message.mentions.includes(member.id))
    setPicked(current =>
      withMentions(
        current,
        named.map(({ id, name }) => ({ id, name }))
      )
    )
    setMode(message.type)
    queue.discard(message.id)
    textarea.current?.focus()
  }

  return (
    <div className={cn('flex flex-col gap-2 border-t p-3', isNote && 'bg-note/40')}>
      <ComposerShortcuts
        mayReply={mayReply}
        mayNote={mayNote}
        onMode={setMode}
        onSend={submit}
        focus={() => textarea.current?.focus()}
      />
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
        <div className="flex flex-col gap-1">
          {isMenuOpen && entries.length > 0 ? (
            <CommandMenu
              id={menuId}
              label={tMenu(`label.${menu.kind}`)}
              items={entries}
              activeIndex={Math.min(activeIndex, entries.length - 1)}
              onPick={item => {
                const entry = entries.find(candidate => candidate.id === item.id)
                if (entry !== undefined) pick(entry)
              }}
            />
          ) : null}
          {/* A multi-line field stays a textbox, so the highlighted option is announced here */}
          <p role="status" className="sr-only">
            {active === undefined
              ? ''
              : tMenu('announce', { count: entries.length, label: active.label })}
          </p>
          {isMenuOpen && entries.length === 0 && menu.kind === 'snippets' && snippets.isError ? (
            <p role="alert" className="text-destructive px-2 text-xs">
              {tAll(`errors.${errorCodeOf(snippets.error)}`)}
            </p>
          ) : null}
          {isMenuOpen &&
          entries.length === 0 &&
          menu.kind !== 'commands' &&
          !(menu.kind === 'snippets' && (snippets.isPending || snippets.isError)) &&
          !((menu.kind === 'members' || menu.kind === 'mentions') && members.isPending) ? (
            <p role="status" className="text-muted-foreground px-2 text-xs">
              {tMenu('noMatches')}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              ref={textarea}
              {...{ [SHORTCUT_FIELD_ATTRIBUTE]: '' }}
              value={draft}
              onChange={event => {
                setText(event.target.value)
                setCaret(event.target.selectionStart)
              }}
              onSelect={event => setCaret(event.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              aria-controls={entries.length > 0 ? menuId : undefined}
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
              disabled={content === '' || !queue.isReady || isCommandText}
              aria-label={t('send')}
            >
              <Send aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
