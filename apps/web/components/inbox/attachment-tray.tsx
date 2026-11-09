'use client'

import { FileText, LoaderCircle, Music, Video, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type KeyboardEvent,
  type ReactElement,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useState
} from 'react'

import { ChannelCapability, MessageType } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import { takesCaptionPerFile } from '../../lib/media/attachment-batch'
import { formatBytes } from '../../lib/media/attachment-rules'
import {
  type AttachmentItem,
  type AttachmentRules,
  useAttachments
} from '../../lib/media/use-attachments'
import { useCodeText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

// What the composer reads from the tray to draw its own button and to decide what Send does
export interface TrayStatus {
  // Files in the message that have not failed
  count: number
  ready: number
  isBusy: boolean
  isSending: boolean
}

export const EMPTY_TRAY: TrayStatus = { count: 0, ready: 0, isBusy: false, isSending: false }

export interface TrayHandle {
  send: (caption: string, replyToMessageId?: string) => Promise<boolean>
  add: (files: readonly File[]) => void
  clear: () => void
}

// A picture of the file while it waits to be sent. The address is made here and let go of when the file
// leaves, so a long session does not keep the bytes of every picture it ever chose.
function useObjectUrl(file: File, isImage: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    const made = URL.createObjectURL(file)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [file, isImage])
  return url
}

function Thumbnail({ item }: { item: AttachmentItem }): ReactElement {
  const isImage = item.type === MessageType.IMAGE
  const url = useObjectUrl(item.file, isImage)
  if (isImage && url !== null) {
    // eslint-disable-next-line @next/next/no-img-element -- a local preview of a file the agent chose
    return <img src={url} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
  }
  if (item.status === 'uploading' || item.status === 'checking') {
    return <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
  }
  const Icon =
    item.type === MessageType.VIDEO ? Video : item.type === MessageType.AUDIO ? Music : FileText
  return <Icon aria-hidden className="size-4 shrink-0" />
}

// The text under one file: its own field, with how much the channel holds. Escape leaves the field and keeps
// the text (it must not close the conversation, as in the box of the message).
function CaptionField({
  item,
  max,
  isLocked,
  onChange
}: {
  item: AttachmentItem
  max: number | undefined
  isLocked: boolean
  onChange: (caption: string) => void
}): ReactElement {
  const t = useTranslations('inbox.composer.attach')
  const countId = useId()
  const used = Array.from(item.caption).length
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.stopPropagation()
    event.currentTarget.blur()
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Input
        value={item.caption}
        disabled={isLocked}
        aria-label={t('captionFor', { name: item.file.name })}
        aria-describedby={max === undefined ? undefined : countId}
        placeholder={t('captionPlaceholder')}
        className="h-8 text-xs"
        onChange={event => onChange(Array.from(event.target.value).slice(0, max).join(''))}
        onKeyDown={onKeyDown}
      />
      {max === undefined ? null : (
        <span id={countId} className="text-muted-foreground self-end text-[0.7rem]">
          {t('captionCount', { used, max })}
        </span>
      )}
    </div>
  )
}

function Chip({
  item,
  isLocked,
  hasCaption,
  captionMax,
  onCaption,
  onRemove
}: {
  item: AttachmentItem
  isLocked: boolean
  // This file has its own field for the text under it
  hasCaption: boolean
  captionMax: number | undefined
  onCaption: (caption: string) => void
  onRemove: () => void
}): ReactElement {
  const t = useTranslations('inbox.composer.attach')
  const codeText = useCodeText()
  const name = item.file.name
  const percent = item.status === 'uploading' ? Math.round(item.progress * 100) : null
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="bg-muted flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
        <Thumbnail item={item} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-muted-foreground shrink-0">{formatBytes(item.file.size)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onRemove}
          disabled={isLocked}
          aria-label={t('remove', { name })}
        >
          <X aria-hidden />
        </Button>
      </div>
      {hasCaption ? (
        <CaptionField item={item} max={captionMax} isLocked={isLocked} onChange={onCaption} />
      ) : null}
      {percent === null ? null : (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('uploading', { name, percent })}
          className="bg-muted h-1 overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
      <p role="status" className="sr-only">
        {item.status === 'checking'
          ? t('checking', { name })
          : item.status === 'ready'
            ? t('ready', { name })
            : ''}
      </p>
      {item.status === 'failed' && item.code !== null ? (
        <p role="alert" className="text-destructive text-xs">
          {item.code === ClientErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
            ? `${name}: ${t('unsupported')}`
            : `${t('failed', { name })}: ${codeText(item.code)}`}
        </p>
      ) : null}
    </li>
  )
}

// The files the agent is about to send, one chip each in the order they will go: a picture, its name and
// size, how far the upload is, whether the scan is done and the way to take it away. It holds the uploads
// (`useAttachments`), so it is loaded the first time a file is chosen and stays mounted after that: a note
// hides it (`hidden`), and the files wait for the reply tab again.
export function AttachmentTray({
  storeId,
  conversationId,
  rules,
  captionMax,
  hidden,
  onStatus,
  handle
}: {
  storeId: string
  conversationId: string
  rules: AttachmentRules
  // How much text the channel holds under a file; unknown when it does not say
  captionMax: number | undefined
  hidden: boolean
  onStatus: (status: TrayStatus) => void
  handle: Ref<TrayHandle>
}): ReactElement | null {
  const t = useTranslations('inbox.composer.attach')
  const codeText = useCodeText()
  const attachments = useAttachments(storeId, conversationId, rules)
  const { items, notice, sendError, isSending } = attachments
  useImperativeHandle(
    handle,
    () => ({ send: attachments.send, add: attachments.add, clear: attachments.clear }),
    [attachments.send, attachments.add, attachments.clear]
  )

  // The files that go in the message, in order; each has a field for its text where the channel puts a text under
  // each file, the first included (the text of the composer is the text of the message and goes after the files)
  const kept = items.filter(item => item.status !== 'failed')
  const perFile = takesCaptionPerFile(rules, kept[0]?.type ?? null)
  const count = items.filter(item => item.status !== 'failed').length
  // The channel sends the text of the box as a message after the files, whatever the kind of file
  const carriesPerFile =
    count > 0 && rules.capabilities?.includes(ChannelCapability.CAPTION_PER_FILE) === true
  const ready = items.filter(item => item.status === 'ready').length
  const isBusy = items.some(item => item.status === 'uploading' || item.status === 'checking')
  useEffect(() => {
    onStatus({ count, ready, isBusy, isSending })
  }, [count, ready, isBusy, isSending, onStatus])

  if (hidden || (items.length === 0 && notice === null && sendError === null)) return null
  return (
    <div className="flex flex-col gap-1">
      {items.length === 0 ? null : (
        <ul aria-label={t('listLabel')} className="grid gap-1 sm:grid-cols-2">
          {items.map(item => (
            <Chip
              key={item.id}
              item={item}
              isLocked={isSending}
              hasCaption={perFile && item.status !== 'failed'}
              captionMax={captionMax}
              onCaption={caption => attachments.setCaption(item.id, caption)}
              onRemove={() => attachments.remove(item.id)}
            />
          ))}
        </ul>
      )}
      {carriesPerFile || count > 1 ? (
        <p className="text-muted-foreground text-xs">
          {t(carriesPerFile ? 'captionEach' : 'captionAfter')}
        </p>
      ) : null}
      {notice === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {notice.kind === 'mixed' ? t('mixed') : t('tooMany', { max: notice.max })}
        </p>
      )}
      {sendError === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {codeText(sendError)}
        </p>
      )}
    </div>
  )
}
