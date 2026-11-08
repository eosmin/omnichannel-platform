'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { asksBeforeResending } from '../../lib/inbox/caption-resend'
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

// The button to send the text of a message again and the question that goes before it. A text that failed is
// sent at once; one that got no clear answer may already be with the customer, so the agent confirms first and is
// told they may see it twice. Never automatic. Loaded only when a text is in one of those states (a rare one),
// so the thread does not carry it.
export default function CaptionResend({
  label,
  state,
  isBusy,
  onSend
}: {
  label: string
  state: Parameters<typeof asksBeforeResending>[0]
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
            <AlertDialogTitle>{t('captionResendTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('captionResendMaybeSent')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('captionResendCancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={isBusy} onClick={send}>
              {t('captionResendConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
