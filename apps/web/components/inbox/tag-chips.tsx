'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ConversationListItemView } from '@platform/api-client'
import { DEFAULT_TAG_COLOR, TAG_COLOR_PATTERN } from '@platform/core/domain'

// The row has room for two names; the rest is a count
const VISIBLE_TAGS = 2

// The color comes from the store's own settings, but it is text: only #rrggbb reaches a style
const dotColor = (color: string): string =>
  TAG_COLOR_PATTERN.test(color) ? color : DEFAULT_TAG_COLOR

// The tags of a conversation on its row: a dot of the tag color and its name, so the color is never
// the only signal
export function TagChips({
  tags
}: {
  tags: ConversationListItemView['tags']
}): ReactElement | null {
  const t = useTranslations('inbox')
  if (tags.length === 0) return null
  const hidden = tags.length - VISIBLE_TAGS
  return (
    <ul aria-label={t('tagsLabel')} className="flex min-w-0 items-center gap-1.5">
      {tags.slice(0, VISIBLE_TAGS).map(tag => (
        <li key={tag.id} className="flex min-w-0 items-center gap-1">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor(tag.color) }}
          />
          <span className="truncate">{tag.name}</span>
        </li>
      ))}
      {hidden > 0 ? <li>{t('moreTags', { count: hidden })}</li> : null}
    </ul>
  )
}
