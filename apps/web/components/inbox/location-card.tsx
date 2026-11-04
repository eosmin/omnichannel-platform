'use client'

import { ExternalLink, MapPin } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { locationTitleOf } from '../../lib/inbox/location-title'
import { mapLinkOf } from '../../lib/inbox/map-link'
import { cn } from '../../lib/utils'
import { buttonVariants } from '../ui/button'

const COORDINATE_DECIMALS = 6

// A place the customer shared: its name, its address and its coordinates, and a button that opens it
// on a map in another tab. There is no embedded map: nothing is fetched from a map provider until the
// agent chooses to open it. The name and the address are text of the customer, drawn as plain text; the
// link is built from the coordinates alone.
export function LocationCard({
  location,
  content
}: {
  location: NonNullable<MessageView['location']>
  // The text of the message: the title of a place saved before name and address were kept apart
  content: string | null
}): ReactElement {
  const t = useTranslations('inbox.thread.location')
  const format = useFormatter()
  const number = (value: number): string =>
    format.number(value, { maximumFractionDigits: COORDINATE_DECIMALS })
  const link = mapLinkOf(location)
  const title = locationTitleOf(location, content) ?? t('untitled')
  return (
    <div className="flex w-[min(260px,100%)] flex-col gap-1.5">
      <p className="flex items-start gap-1.5 font-medium">
        <MapPin aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 break-words">{title}</span>
      </p>
      {location.address === null ? null : (
        <p className="text-muted-foreground break-words">{location.address}</p>
      )}
      <p className="text-muted-foreground text-xs">
        {t('coordinates', {
          latitude: number(location.latitude),
          longitude: number(location.longitude)
        })}
      </p>
      {link === null ? null : (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('openMapAria', { place: title })}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-fit')}
        >
          <ExternalLink aria-hidden className="size-4" />
          {t('openMap')}
        </a>
      )}
    </div>
  )
}
