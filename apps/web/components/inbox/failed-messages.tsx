'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { knownErrorCode } from '../../lib/error-message'
import { OfflineQueueErrors, type PendingMessage } from '../../lib/realtime/offline-queue'
import { Button } from '../ui/button'

// What did not go: the api refused it (the reason, translated) or it waited too long to go out on its
// own (the agent decides). Edit takes the text back to the composer; Discard drops it.
export type EditState = 'enabled' | 'disabled' | 'hidden'

export function FailedMessages({
  messages,
  canEdit,
  onEdit,
  onDiscard,
  onResend
}: {
  messages: readonly PendingMessage[]
  // What the composer can do with the text now. `hidden`: it cannot take it (a reply while the window
  // is closed or without the permission to reply: it must never turn into a note on its own).
  // `disabled`: not yet (the draft in the box is of the other kind, or both would pass the limit).
  canEdit: (message: PendingMessage) => EditState
  onEdit: (message: PendingMessage) => void
  onDiscard: (id: string) => void
  onResend: (id: string) => void
}): ReactElement | null {
  const t = useTranslations('inbox.composer.failed')
  const tAll = useTranslations()
  // The live region is always there: one that appears with its content is often not announced
  return (
    <div role="status" aria-atomic="false">
      {messages.length === 0 ? null : (
        <ul aria-label={t('label')} className="flex flex-col gap-2">
          {messages.map(message => {
            const isExpired = message.lastError === OfflineQueueErrors.EXPIRED
            const editState = canEdit(message)
            const reason = isExpired
              ? t('expired')
              : tAll(`errors.${knownErrorCode(message.lastError ?? '')}`)
            return (
              <li
                key={message.id}
                className="border-destructive/40 flex flex-col gap-2 rounded-md border p-2 text-sm"
              >
                <p className="break-words whitespace-pre-wrap">{message.content}</p>
                <p className="text-destructive text-xs">{reason}</p>
                <div className="flex gap-2">
                  {isExpired ? (
                    editState === 'hidden' ? null : (
                      <Button type="button" size="sm" onClick={() => onResend(message.id)}>
                        {t('send')}
                      </Button>
                    )
                  ) : editState === 'hidden' ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={editState === 'disabled'}
                      onClick={() => onEdit(message)}
                    >
                      {t('edit')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onDiscard(message.id)}
                  >
                    {t('discard')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
