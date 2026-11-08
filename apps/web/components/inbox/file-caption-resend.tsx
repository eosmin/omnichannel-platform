'use client'

import { useIsMutating } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

import CaptionResend from './caption-resend'

// "Send the text again" under one file (the question that may go first is `CaptionResend`'s).
export default function FileCaptionResend({
  conversationId,
  messageId,
  mediaId,
  state
}: {
  conversationId: string
  messageId: string
  mediaId: string
  state: 'failed' | 'unconfirmed'
}): ReactElement {
  const t = useTranslations('inbox.thread')
  const errorText = useErrorText()
  const { resendFileCaption } = useMessageMutations(conversationId, messageId)
  // A text of this message is on its way, from this file or another one: the api takes one at a time
  const isBusy =
    useIsMutating({ mutationKey: ['resend-file-caption', messageId] }) > 0 ||
    resendFileCaption.isPending

  return (
    <CaptionResend
      label={t('fileCaptionResend')}
      state={state}
      isBusy={isBusy}
      onSend={() => {
        resendFileCaption
          .mutateAsync(mediaId)
          .catch((error: unknown) => toast.error(errorText(error)))
      }}
    />
  )
}
