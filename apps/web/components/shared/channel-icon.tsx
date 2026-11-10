import type { ReactElement } from 'react'

import { channelIconOf } from '../../lib/channel-icon'

// The icon a channel declared (`iconKey` of its descriptor), decorative: the name is always next to it
export function ChannelIcon({
  iconKey,
  className = 'size-4 shrink-0'
}: {
  iconKey: string | null | undefined
  className?: string
}): ReactElement {
  const Icon = channelIconOf(iconKey)
  return <Icon aria-hidden className={className} />
}
