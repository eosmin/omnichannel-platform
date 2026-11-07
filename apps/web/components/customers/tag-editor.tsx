'use client'

import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { CustomerDetailView } from '@platform/api-client'

import { tagDotColor } from '../../lib/customers/tag-color'
import { filterTags, TAG_LIST_LIMIT, TAG_SEARCH_FROM } from '../../lib/customers/tag-filter'
import { useCustomerEdits } from '../../lib/customers/use-customer-data'
import { useTags } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

import { MutationError } from './mutation-error'

// The tags of the customer, each with a button to take it off, and the tags of the store that it does
// not hold yet, each with a button to add it. Tags are made in Settings (Step 3.6), not here.
export function TagEditor({ customer }: { customer: CustomerDetailView }): ReactElement {
  const t = useTranslations('customers.edit.tags')
  const tProfile = useTranslations('customers.profile')
  const { storeId } = useStore()
  const { addTag, removeTag } = useCustomerEdits(storeId, customer.id)
  const storeTags = useTags(storeId)
  const held = new Set(customer.tags.map(tag => tag.id))
  const available = (storeTags.data ?? []).filter(tag => !held.has(tag.id))
  const [query, setQuery] = useState('')
  const hasSearch = available.length > TAG_SEARCH_FROM
  const matching = hasSearch ? filterTags(available, query) : available
  const shown = matching.slice(0, TAG_LIST_LIMIT)
  const isBusy = addTag.isPending || removeTag.isPending

  return (
    <div className="flex flex-col gap-2">
      {customer.tags.length === 0 ? (
        <p className="text-muted-foreground text-sm">{tProfile('noTags')}</p>
      ) : (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {customer.tags.map(tag => (
            <li key={tag.id} className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: tagDotColor(tag.color) }}
              />
              {tag.name}
              <Button
                size="icon"
                variant="ghost"
                className="size-5"
                aria-label={t('remove', { name: tag.name })}
                disabled={isBusy}
                onClick={() => removeTag.mutate(tag.id)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {storeTags.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : available.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">{t('addLabel')}</p>
          {hasSearch ? (
            <Input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')}
            />
          ) : null}
          <ul className="flex flex-wrap gap-1">
            {shown.map(tag => (
              <li key={tag.id}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={isBusy}
                  onClick={() => {
                    addTag.mutate(tag.id)
                    // The search was for that tag: the next one starts from the whole list
                    setQuery('')
                  }}
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: tagDotColor(tag.color) }}
                  />
                  {t('add', { name: tag.name })}
                </Button>
              </li>
            ))}
          </ul>
          {hasSearch && matching.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('noMatches')}</p>
          ) : null}
          {matching.length > shown.length ? (
            <p className="text-muted-foreground text-xs">
              {t('showingFirst', { shown: shown.length, total: matching.length })}
            </p>
          ) : null}
        </div>
      )}
      <MutationError error={addTag.error ?? removeTag.error} />
    </div>
  )
}
