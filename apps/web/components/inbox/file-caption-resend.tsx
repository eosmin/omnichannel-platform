'use client'

import { useIsMutating } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { asksBeforeResending } from '../../lib/inbox/file-caption'
import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'

// "Send the text again" under one file. A text that failed is sent at once; one that got no clear answer may
// already be with the customer, so the agent confirms first and is told they may see it twice. Never
// automatic. Loaded only when a text is in one of those states (a rare one), so the thread does not carry it.
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
  const [isAsking, setAsking] = useState(false)
  // A text of this message is on its way, from this file or another one: the api takes one at a time
  const isBusy =
    useIsMutating({ mutationKey: ['resend-file-caption', messageId] }) > 0 ||
    resendFileCaption.isPending

  const send = (): void => {
    // A second click before the first is answered would ask twice (and an unconfirmed text may go twice)
    if (isBusy) return
    setAsking(false)
    resendFileCaption.mutateAsync(mediaId).catch((error: unknown) => toast.error(errorText(error)))
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isBusy}
        onClick={() => (asksBeforeResending(state) ? setAsking(true) : send())}
      >
        {t('fileCaptionResend')}
      </Button>
      <AlertDialog open={isAsking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('fileCaptionResendTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('fileCaptionResendMaybeSent')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('fileCaptionResendCancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={isBusy} onClick={send}>
              {t('fileCaptionResendConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
