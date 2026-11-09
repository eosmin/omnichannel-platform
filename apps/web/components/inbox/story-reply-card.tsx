'use client'

import { ImageOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { RemoteImage } from './remote-image'

// The story of the business that the customer answered: the label and the thumbnail the provider gave. The
// link is untrusted and expires within about a day (and may not come), so the image is drawn by the
// browser from the hosts the CSP allows, and when it is gone, or there was none, a notice takes its place.
// The server never fetched it. Channel agnostic: it draws what `MessageView.storyReply` says.
export function StoryReplyCard({
  story
}: {
  story: NonNullable<MessageView['storyReply']>
}): ReactElement {
  const t = useTranslations('inbox.thread.storyReply')
  return (
    <div className="flex w-40 max-w-full flex-col gap-1">
      <p className="text-muted-foreground text-xs font-medium">{t('label')}</p>
      <div className="bg-muted aspect-[9/16] w-full overflow-hidden rounded-md">
        <RemoteImage
          src={story.url}
          className="size-full object-cover"
          fallback={
            <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1.5 p-2 text-center text-xs">
              <ImageOff aria-hidden className="size-5" />
              <span>{t('unavailable')}</span>
            </div>
          }
        />
      </div>
    </div>
  )
}
