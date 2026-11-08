'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { asksBeforeResending, type FileCaptionView } from '../../lib/inbox/file-caption'
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

// The button to send a text again and the question that goes before it, the same for the text of a message and
// for the one under a file. A text that failed is sent at once; one that got no clear answer may already be with
// the customer, so the agent confirms first and is told they may see it twice. Never automatic. Loaded only when
// a text is in one of those states (a rare one), so the thread does not carry it.
export default function CaptionResend({
  label,
  state,
  isBusy,
  onSend
}: {
  label: string
  state: FileCaptionView['state']
  // A text of this message is on its way: the api takes one at a time
  isBusy: boolean
  onSend: () => void
}): ReactElement {
  const t = useTranslations('inbox.thread')
  const [isAsking, setAsking] = useState(false)

  const send = (): void => {
    // A second click before the first is answered would ask twice (and an unconfirmed text may go twice)
    if (isBusy) return
    setAsking(false)
    onSend()
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
        {label}
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
