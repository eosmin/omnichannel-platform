'use client'

import { TriangleAlert } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'
import { CaptionState, ResendableCaptionStates } from '@platform/core/domain'

import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// The button and the question that goes before it, downloaded the first time a text needs them
const CaptionResend = dynamic(() => import('./caption-resend'), { ssr: false })

const NOTICE_KEYS = {
  [CaptionState.FAILED]: 'captionFailed',
  [CaptionState.UNCONFIRMED]: 'captionUnconfirmed',
  [CaptionState.QUEUED]: 'captionQueued'
} as const

// What the thread says of the text of a message that the channel sent apart from its file, and the button
// to send only that text again when the person may (the api checks it again); a text that may already be with the
// customer asks first. Nothing is drawn for a text that went.
export function CaptionNotice(props: {
  message: MessageView
  conversationId: string
  canResend: boolean
}): ReactElement | null {
  // Almost every message has no caption state: it must not pay for the mutations of the notice
  return props.message.captionState === null ? null : <Notice {...props} />
}

function Notice({
  message,
  conversationId,
  canResend
}: {
  message: MessageView
  conversationId: string
  canResend: boolean
}): ReactElement | null {
  const t = useTranslations('inbox.thread')
  const errorText = useErrorText()
  const { resendCaption } = useMessageMutations(conversationId, message.id)
  const state = message.captionState
  if (state === null) return null
  return (
    <div role="status" className="text-muted-foreground flex flex-col items-start gap-1 text-xs">
      <p className="flex items-center gap-1.5">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        {t(NOTICE_KEYS[state])}
      </p>
      {canResend && ResendableCaptionStates.some(allowed => allowed === state) ? (
        <div>
          <CaptionResend
            label={t('resendCaption')}
            state={state}
            isBusy={resendCaption.isPending}
            onSend={() => {
              resendCaption.mutateAsync().catch((error: unknown) => toast.error(errorText(error)))
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
