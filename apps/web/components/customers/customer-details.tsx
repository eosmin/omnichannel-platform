'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { CustomerDetailView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { DEFAULT_TAG_COLOR, TAG_COLOR_PATTERN } from '@platform/core/domain'

import { conversationCount } from '../../lib/customers/conversation-count'
import { customerDisplayName, initialsOfName } from '../../lib/customers/customer-name'
import { useCustomerConversations } from '../../lib/customers/use-customer-data'
import { useChannelName } from '../../lib/inbox/use-inbox-data'
import { CustomerAvatar } from '../inbox/customer-avatar'
import { useStore } from '../providers/store-context'

const dotColor = (color: string): string =>
  TAG_COLOR_PATTERN.test(color) ? color : DEFAULT_TAG_COLOR

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function IdentityRow({
  identity
}: {
  identity: CustomerDetailView['identities'][number]
}): ReactElement {
  const { storeId } = useStore()
  const channelName = useChannelName(storeId, identity.channelType)
  return (
    <li className="flex flex-col text-sm">
      <span className="font-medium">{channelName}</span>
      <span className="text-muted-foreground break-all">
        {identity.displayName ?? identity.channelIdentity}
      </span>
    </li>
  )
}

// The count of conversations. The profile has no order figures until Step 4.4, so the stats are
// "customer since" and this count.
function ConversationsStat({ customerId }: { customerId: string }): ReactElement | null {
  const t = useTranslations('customers.profile')
  const tCommon = useTranslations('common')
  const { storeId, can } = useStore()
  const mayRead = can(Permissions.CONVERSATIONS_VIEW)
  const conversations = useCustomerConversations(storeId, customerId, mayRead)
  if (!mayRead) return null
  if (conversations.data === undefined) {
    return (
      <div className="flex justify-between text-sm">
        <dt>{t('stats.conversations')}</dt>
        <dd className="text-muted-foreground">
          {conversations.isError ? t('stats.failed') : tCommon('loading')}
        </dd>
      </div>
    )
  }
  const { count, isExact } = conversationCount(conversations.data)
  return (
    <div className="flex justify-between text-sm">
      <dt>{t('stats.conversations')}</dt>
      <dd>{isExact ? count : t('stats.atLeast', { count })}</dd>
    </div>
  )
}

// The identity side of the profile (TDD_09 §6), used by the drawer and by the panel of the inbox:
// who the customer is, the channels they write from, the figures, the tags and the addresses.
export function CustomerDetails({ customer }: { customer: CustomerDetailView }): ReactElement {
  const t = useTranslations('customers.profile')
  const format = useFormatter()
  const name = customerDisplayName(customer)
  const since = new Date(customer.createdAt)
  const contact = [customer.email, customer.phone].filter(
    (value): value is string => value !== null && value !== name
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <CustomerAvatar avatarUrl={null} initials={initialsOfName(name)} />
        <div className="flex min-w-0 flex-col">
          <p className="truncate font-semibold">{name ?? t('unnamed')}</p>
          {contact.map(line => (
            <p key={line} className="text-muted-foreground truncate text-xs">
              {line}
            </p>
          ))}
        </div>
      </div>
      {customer.isCaution ? (
        <p role="note" className="bg-muted rounded-md p-2 text-sm">
          <span className="font-medium">{t('caution')}</span>
          {customer.cautionReason === null ? null : ` ${customer.cautionReason}`}
        </p>
      ) : null}

      <Section title={t('identities')}>
        {customer.identities.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noIdentities')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {customer.identities.map(identity => (
              <IdentityRow key={identity.id} identity={identity} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('stats.title')}>
        <dl className="flex flex-col gap-1">
          <ConversationsStat customerId={customer.id} />
          <div className="flex justify-between text-sm">
            <dt>{t('stats.since')}</dt>
            <dd>
              {Number.isNaN(since.getTime())
                ? t('stats.unknown')
                : format.dateTime(since, { month: 'short', year: 'numeric' })}
            </dd>
          </div>
        </dl>
      </Section>

      <Section title={t('tags')}>
        {customer.tags.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noTags')}</p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {customer.tags.map(tag => (
              <li key={tag.id} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor(tag.color) }}
                />
                {tag.name}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('addresses', { count: customer.addresses.length })}>
        {customer.addresses.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noAddresses')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {customer.addresses.map(address => (
              <li key={address.id} className="text-sm">
                {address.label === null && !address.isDefault ? null : (
                  <p className="font-medium">
                    {[address.label, address.isDefault ? t('defaultAddress') : null]
                      .filter(part => part !== null)
                      .join(' · ')}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {[
                    address.line1,
                    address.line2,
                    address.city,
                    address.state,
                    address.postalCode,
                    address.country
                  ]
                    .filter((part): part is string => part !== null && part !== '')
                    .join(', ')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
