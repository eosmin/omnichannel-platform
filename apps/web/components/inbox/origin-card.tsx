'use client'

import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useLayoutEffect, useRef, useState } from 'react'

import type { ConversationOriginView } from '@platform/api-client'
import { MediaStatus, OriginKinds } from '@platform/core/domain'

import { hostOf } from '../../lib/inbox/link-host'
import { pictureFileOf } from '../../lib/inbox/origin-picture'
import { useMediaUrls } from '../../lib/media/use-media-urls'

import { RemoteImage } from './remote-image'

const kindKeyOf = (kind: string): 'ad' | 'post' | 'other' =>
  kind === OriginKinds.AD ? 'ad' : kind === OriginKinds.POST ? 'post' : 'other'

// The picture the worker kept, from a signed link of the bucket. The address of the ad is never drawn:
// it expires, and loading it would tell the CDN of the ad who is looking at the inbox.
function OriginPicture({
  storeId,
  origin
}: {
  storeId: string
  origin: ConversationOriginView
}): ReactElement | null {
  const file = pictureFileOf(origin)
  const isClean = file?.status === String(MediaStatus.CLEAN)
  const urls = useMediaUrls(storeId, file?.id ?? '', isClean)
  const src = urls.data === undefined ? null : (urls.data.variants.thumb ?? urls.data.url)
  if (src === null) return null
  return (
    <div className="bg-muted size-16 shrink-0 overflow-hidden rounded-md">
      <RemoteImage src={src} className="size-full object-cover" />
    </div>
  )
}

function OriginEntry({
  storeId,
  origin,
  isFirstContact
}: {
  storeId: string
  origin: ConversationOriginView
  isFirstContact: boolean
}): ReactElement {
  const t = useTranslations('inbox.thread.origin')
  const host = origin.sourceUrl === null ? null : hostOf(origin.sourceUrl)
  return (
    <div className="flex gap-3">
      <OriginPicture storeId={storeId} origin={origin} />
      <div className="flex min-w-0 flex-col gap-0.5 text-xs">
        <p className="text-muted-foreground">
          {t(isFirstContact ? 'firstContactFrom' : 'cameFrom', {
            kind: t(`kind.${kindKeyOf(origin.kind)}`)
          })}
        </p>
        {origin.title === null ? null : (
          <p className="text-sm font-medium break-words">{origin.title}</p>
        )}
        {origin.body === null ? null : <p className="line-clamp-3 break-words">{origin.body}</p>}
        {origin.sourceUrl !== null && host !== null ? (
          <a
            href={origin.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-visible:ring-ring inline-flex w-fit items-center gap-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2"
          >
            <ExternalLink aria-hidden className="size-3" />
            <span className="sr-only">{t('open', { host })}</span>
            <span aria-hidden>{host}</span>
          </a>
        ) : null}
      </div>
    </div>
  )
}

// Where the conversation came from, on top of the thread: the latest origin as a card and the rest
// folded under "N earlier". The oldest one is the first contact. The list is newest first. A
// conversation with no origin shows nothing.
export function OriginCard({
  storeId,
  origins,
  onGrow
}: {
  storeId: string
  origins: readonly ConversationOriginView[]
  // Called with the change in height and the card, after it unfolds or folds
  onGrow: (growth: number, card: HTMLElement) => void
}): ReactElement | null {
  const t = useTranslations('inbox.thread.origin')
  const [isUnfolded, setIsUnfolded] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const height = useRef(0)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    const growth = card.offsetHeight - height.current
    // The insertion of the card is growth too: the origins can arrive after the thread was drawn
    if (growth !== 0) onGrow(growth, card)
    height.current = card.offsetHeight
  }, [isUnfolded, origins.length, onGrow])
  const [latest, ...earlier] = origins
  if (latest === undefined) return null
  const first = origins.at(-1)
  const shown = isUnfolded ? origins : [latest]

  return (
    <section
      ref={cardRef}
      aria-label={t('label')}
      className="bg-card mx-3 mt-3 flex flex-col gap-3 rounded-lg border p-3"
    >
      {shown.map(origin => (
        <OriginEntry
          key={origin.id}
          storeId={storeId}
          origin={origin}
          isFirstContact={origin.id === first?.id}
        />
      ))}
      {earlier.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={isUnfolded}
          onClick={() => setIsUnfolded(value => !value)}
          className="text-muted-foreground focus-visible:ring-ring flex w-fit items-center gap-1 text-xs outline-none hover:underline focus-visible:ring-2"
        >
          {isUnfolded ? (
            <ChevronUp aria-hidden className="size-3" />
          ) : (
            <ChevronDown aria-hidden className="size-3" />
          )}
          {isUnfolded ? t('hideEarlier') : t('earlier', { count: earlier.length })}
        </button>
      )}
    </section>
  )
}
