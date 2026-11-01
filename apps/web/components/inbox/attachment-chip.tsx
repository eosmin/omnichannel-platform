'use client'

import { LoaderCircle, Paperclip, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { formatBytes } from '../../lib/media/attachment-rules'
import type { AttachmentState } from '../../lib/media/use-attachment'
import { Button } from '../ui/button'

// The file the agent is about to send: its name and size, how far the upload is, whether the scan is
// done, and the way to take it away. A failure is read out as an alert.
export function AttachmentChip({
  state,
  onRemove
}: {
  state: Exclude<AttachmentState, { kind: 'idle' }>
  onRemove: () => void
}): ReactElement {
  const t = useTranslations('inbox.composer.attach')
  const tAll = useTranslations()
  const { file } = state
  const percent = state.kind === 'uploading' ? Math.round(state.progress * 100) : null
  const problem =
    state.kind === 'failed' ? state.code : state.kind === 'ready' ? state.sendError : null
  return (
    <div className="flex flex-col gap-1">
      <div className="bg-muted flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
        {state.kind === 'uploading' || state.kind === 'checking' ? (
          <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin" />
        ) : (
          <Paperclip aria-hidden className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onRemove}
          disabled={state.kind === 'ready' && state.isSending}
          aria-label={t('remove', { name: file.name })}
        >
          <X aria-hidden />
        </Button>
      </div>
      {percent === null ? null : (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={t('uploading', { name: file.name, percent })}
          className="bg-muted h-1 overflow-hidden rounded-full"
        >
          <div className="bg-primary h-full transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
      <p role="status" className="sr-only">
        {state.kind === 'checking'
          ? t('checking', { name: file.name })
          : state.kind === 'ready'
            ? t('ready', { name: file.name })
            : ''}
      </p>
      {problem === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {state.kind === 'failed' ? `${t('failed', { name: file.name })}: ` : ''}
          {tAll(`errors.${problem}`)}
        </p>
      )}
    </div>
  )
}
